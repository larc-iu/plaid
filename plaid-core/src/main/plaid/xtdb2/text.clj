(ns plaid.xtdb2.text
  (:require [xtdb.api :as xt]
            [plaid.algos.text :as ta]
            [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.operation :as op :refer [submit-operations!]]
            [plaid.xtdb2.token :as tok]
            [plaid.xtdb2.metadata :as metadata])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:text/id
                :text/document
                :text/layer
                :text/body])

;; Queries -----------------------------------------------------------------------

(defn get
  "Get a text by ID, formatted for external consumption (API responses)."
  [node-or-map id]
  (when-let [text-entity (pxc/entity node-or-map :texts id)]
    (when (:text/id text-entity)
      (let [core-attrs (select-keys text-entity attr-keys)]
        (metadata/add-metadata-to-response core-attrs text-entity "text")))))

(defn project-id [node-or-map id]
  (let [text (pxc/entity node-or-map :texts id)
        txtl-id (:text/layer text)]
    (when txtl-id
      (:text-layer/project (pxc/entity node-or-map :text-layers txtl-id)))))

(defn get-text-for-doc
  "Find the text for a given text-layer + document pair. Returns entity or nil."
  [node-or-map txtl doc]
  (pxc/find-entity node-or-map :texts {:text/layer txtl :text/document doc}))

(defn get-token-ids [node-or-map eid]
  (->> (pxc/find-entities node-or-map :tokens {:token/text eid})
       (map :xt/id)))

(defn- project-id-from-layer [node-or-map layer-id]
  (:text-layer/project (pxc/entity node-or-map :text-layers layer-id)))

;; Mutations ---------------------------------------------------------------------

(defn create* [xt-map attrs]
  (let [node (pxc/->node xt-map)
        body (or (and (string? (:text/body attrs)) (:text/body attrs)) "")
        text-attrs (filter (fn [[k _]] (= "text" (namespace k))) attrs)
        {:text/keys [id document layer] :as record} (clojure.core/merge
                                                      (pxc/new-record "text")
                                                      {:text/body ""}
                                                      (into {} text-attrs))
        doc-e (pxc/entity-with-sys-from node :documents document)
        prj-id (:document/project doc-e)
        prj (pxc/entity node :projects prj-id)
        txtl-e (pxc/entity-with-sys-from node :text-layers layer)]
    (cond
      (nil? (:document/id doc-e))
      (throw (ex-info (pxc/err-msg-not-found "Document" document) {:id document :code 400}))

      (not (string? body))
      (throw (ex-info "Text body must be a string." {:body body :code 400}))

      (nil? (:text-layer/id txtl-e))
      (throw (ex-info (pxc/err-msg-not-found "Text layer" layer) {:id layer :code 400}))

      (not (some #{layer} (:project/text-layers prj)))
      (throw (ex-info (str "Text layer " layer " not linked to project " prj-id)
                      {:text-layer layer :project prj-id :document document :code 400}))

      (get-text-for-doc xt-map layer document)
      (throw (ex-info (str "Text already exists for document " document)
                      {:document document :code 409}))

      :else
      [;; Transactional uniqueness: prevents two concurrent requests from both passing
       ;; the pre-flight (get-text-for-doc) check and creating duplicate texts for the same pair.
       [:sql "ASSERT NOT EXISTS (SELECT 1 FROM texts WHERE text$layer = ? AND text$document = ?)"
        [layer document]]
       (pxc/match* :documents doc-e)
       (pxc/match* :text-layers txtl-e)
       [:put-docs :texts record]])))

(defn create-operation
  "Build an operation for creating a text with optional metadata."
  [xt-map attrs metadata-map]
  (let [node (pxc/->node xt-map)
        {:text/keys [layer document]} attrs
        project-id (project-id-from-layer node layer)
        metadata-attrs (metadata/transform-metadata-for-storage metadata-map "text")
        attrs-with-metadata (clojure.core/merge attrs metadata-attrs)
        tx-ops (create* xt-map attrs-with-metadata)]
    (op/make-operation
     {:type        :text/create
      :project     project-id
      :document    document
      :description (str "Create text in layer " layer " for document " document
                        (when metadata-map (str " with " (count metadata-map) " metadata keys")))
      :tx-ops      tx-ops})))

(defn create
  ([xt-map attrs user-id]
   (create xt-map attrs user-id nil))
  ([xt-map attrs user-id metadata-map]
   (submit-operations! xt-map [(create-operation xt-map attrs metadata-map)] user-id
                       #(-> % last last :xt/id))))

(defn update-body*
  "Change the textual content of a text, updating token extents as needed."
  [xt-map eid new-body-or-ops]
  (let [node (pxc/->node xt-map)
        text-e (pxc/entity-with-sys-from node :texts eid)]
    (when-not (:text/id text-e)
      (throw (ex-info (pxc/err-msg-not-found "Text" eid) {:code 404 :id eid})))
    (when-not (or (string? new-body-or-ops) (sequential? new-body-or-ops))
      (throw (ex-info "Text body must be a string." {:body new-body-or-ops :code 400})))
    (let [text (dissoc text-e :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)
          ops (if (string? new-body-or-ops)
                (ta/diff (:text/body text) new-body-or-ops)
                new-body-or-ops)
          token-ids (get-token-ids node eid)
          tokens-e (mapv #(pxc/entity-with-sys-from node :tokens %) token-ids)
          tokens (mapv #(dissoc % :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to) tokens-e)
          indexed-tokens-e (reduce #(assoc %1 (:token/id %2) %2) {} tokens-e)
          indexed-tokens (reduce #(assoc %1 (:token/id %2) %2) {} tokens)
          {new-text :text new-tokens :tokens deleted-token-ids :deleted} (ta/apply-text-edits ops text tokens)
          needs-update? (fn [{:token/keys [begin end id]}]
                          (or (not= begin (:token/begin (clojure.core/get indexed-tokens id)))
                              (not= end (:token/end (clojure.core/get indexed-tokens id)))))
          deletion-tx (when (seq deleted-token-ids)
                        (tok/multi-delete* xt-map deleted-token-ids))
          tokens-to-update (filter needs-update? new-tokens)
          update-tx (when (seq tokens-to-update)
                      (mapcat (fn [{:token/keys [id] :as new-token}]
                                [(pxc/match* :tokens (clojure.core/get indexed-tokens-e id))
                                 [:put-docs :tokens new-token]])
                              tokens-to-update))
          text-tx [(pxc/match* :texts text-e)
                   [:put-docs :texts (assoc text :text/body (:text/body new-text))]]
          tx (reduce into [text-tx deletion-tx update-tx])]
      tx)))

(defn update-body-operation
  "Build an operation for updating text body."
  [xt-map eid new-body]
  (let [node (pxc/->node xt-map)
        text (pxc/entity node :texts eid)
        project-id (project-id xt-map eid)
        doc-id (:text/document text)
        token-ids (get-token-ids node eid)
        tx-ops (update-body* xt-map eid new-body)]
    (op/make-operation
     {:type        :text/update-body
      :project     project-id
      :document    doc-id
      :description (str "Update body of text " eid " (affecting " (count token-ids) " tokens)")
      :tx-ops      tx-ops})))

(defn update-body [xt-map eid new-body user-id]
  (submit-operations! xt-map [(update-body-operation xt-map eid new-body)] user-id))

(defn delete* [xt-map eid]
  (let [node (pxc/->node xt-map)
        text-e (pxc/entity-with-sys-from node :texts eid)]
    (when-not (:text/id text-e)
      (throw (ex-info (pxc/err-msg-not-found "Text" eid) {:code 404 :id eid})))
    (let [token-ids (get-token-ids node eid)
          tok-ops (when (seq token-ids) (tok/multi-delete* xt-map token-ids))]
      (reduce into [(vec tok-ops)
                    [(pxc/match* :texts text-e)
                     [:delete-docs :texts eid]]]))))

(defn delete-operation
  "Build an operation for deleting a text."
  [xt-map eid]
  (let [node (pxc/->node xt-map)
        text (pxc/entity node :texts eid)
        project-id (project-id xt-map eid)
        doc-id (:text/document text)
        token-ids (get-token-ids node eid)
        span-ids (mapcat #(tok/get-span-ids node %) token-ids)
        relation-ids (mapcat #(map :xt/id (pxc/find-entities node :relations {:relation/source %}))
                             span-ids)
        tx-ops (delete* xt-map eid)]
    (op/make-operation
     {:type        :text/delete
      :project     project-id
      :document    doc-id
      :description (str "Delete text " eid " with " (count token-ids) " tokens, " (count span-ids) " spans, " (count relation-ids) " relations")
      :tx-ops      tx-ops})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

(defn set-metadata [xt-map eid metadata-map user-id]
  (metadata/set-metadata xt-map eid metadata-map user-id "text" project-id :text/document))

(defn delete-metadata [xt-map eid user-id]
  (metadata/delete-metadata xt-map eid user-id "text" project-id :text/document))
