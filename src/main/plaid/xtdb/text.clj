(ns plaid.xtdb.text
  (:require [xtdb.api :as xt]
            [plaid.algos.text :as ta]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations!]]
            [plaid.xtdb.token :as tok]
            [plaid.xtdb.span :as s]
            [plaid.xtdb.metadata :as metadata])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:text/id
                :text/document
                :text/layer
                :text/body])

;; Queries ------------------------------------------------------------------------
(defn get
  "Get a text by ID, formatted for external consumption (API responses)."
  [db-like id]
  (when-let [text-entity (pxc/find-entity (pxc/->db db-like) {:text/id id})]
    (let [core-attrs (select-keys text-entity [:text/id :text/document :text/layer :text/body])]
      (metadata/add-metadata-to-response core-attrs text-entity "text"))))

(defn project-id [db-like id]
  (-> (xt/q (pxc/->db db-like)
            '{:find  [?prj]
              :where [[?prj :project/text-layers ?txtl]
                      [?txt :text/layer ?txtl]]
              :in    [?txt]}
            id)
      first
      first))

(defn get-text-for-doc
  "There should be exactly one text per text layer per document at all times.
  This function finds the corresponding text for a given document-text layer pair."
  [db-like txtl doc]
  (ffirst
    (xt/q (pxc/->db db-like)
          '{:find  [?txt]
            :where [[?txt :text/layer ?txtl]
                    [?txt :text/document ?doc]]
            :in    [[?txtl ?doc]]}
          [txtl doc])))

(defn get-token-ids [db-like eid]
  (map first (xt/q (pxc/->db db-like)
                   '{:find  [?tok]
                     :where [[?tok :token/text ?txt]]
                     :in    [?txt]}
                   eid)))

(defn- project-id-from-layer [db-like layer-id]
  (-> (xt/q (pxc/->db db-like)
            '{:find  [?prj]
              :where [[?prj :project/text-layers ?txtl]]
              :in    [?txtl]}
            layer-id)
      first
      first))

;; Mutations ----------------------------------------------------------------------
(defn- text-attr? 
  "Check if an attribute key belongs to text namespace (including metadata attributes)."
  [k]
  (= "text" (namespace k)))

(defn create* [xt-map attrs]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        body (or (and (string? (:text/body attrs)) (:text/body attrs))
                 "")
        text-attrs (filter (fn [[k v]] (text-attr? k)) attrs)
        {:text/keys [id document layer body] :as record} (clojure.core/merge (pxc/new-record "text")
                                                                             {:text/body ""}
                                                                             (into {} text-attrs))
        {project-id :document/project :as document-record} (pxc/entity db document)
        {:project/keys [text-layers] :as project} (pxc/entity db project-id)
        tx [[::xt/match document (pxc/entity db document)]
            [::xt/match layer (pxc/entity db layer)]
            [::xt/match id nil]
            [::xt/put record]]]
    (cond
      (some? (pxc/entity db id))
      (throw (ex-info (pxc/err-msg-already-exists "Text" id) {:id id :code 409}))

      (not (string? body))
      (throw (ex-info "Text body must be a string." {:body body :code 400}))

      (nil? (:text-layer/id (pxc/entity db layer)))
      (throw (ex-info (pxc/err-msg-not-found "Text layer" layer) {:id layer :code 400}))

      (nil? (:document/id document-record))
      (throw (ex-info (pxc/err-msg-not-found "Document" document) {:id document :code 400}))

      (not ((set text-layers) layer))
      (throw (ex-info (str "Attempted to create text linked to project " project-id " which is not linked to text layer " layer)
                      {:text-layer layer :project project :document document :code 400}))

      (get-text-for-doc db layer document)
      (throw (ex-info (str "Text already exists for document " document)
                      {:document document :code 409}))

      :else
      tx)))

(defn create-operation
  "Build an operation for creating a text with optional metadata"
  [xt-map attrs metadata]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        {:text/keys [layer document]} attrs
        project-id (project-id-from-layer db layer)
        doc-id document
        ;; Expand metadata into text attributes
        metadata-attrs (metadata/transform-metadata-for-storage metadata "text")
        attrs-with-metadata (clojure.core/merge attrs metadata-attrs)
        tx-ops (create* xt-map attrs-with-metadata)]
    (op/make-operation
     {:type        :text/create
      :project     project-id
      :document    doc-id
      :description (str "Create text in layer " layer " for document " document
                        (when metadata (str " with " (count metadata) " metadata keys")))
      :tx-ops      tx-ops})))

(defn create
  ([xt-map attrs user-id]
   (create xt-map attrs user-id nil))
  ([xt-map attrs user-id metadata]
   (submit-operations! xt-map [(create-operation xt-map attrs metadata)] user-id #(-> % last last :xt/id))))

(defn update-body*
  "Change the textual content (:text/body) of a text item in a way that will also update tokens
  as necessary. Tokens will be updated if their corresponding substring is either removed entirely
  (resulting in deletion) or partially removed (resulting in shrinkage)."
  [xt-map eid new-body-or-ops]

  (let [{:keys [db node]} (pxc/ensure-db xt-map)
        {:text/keys [body] :as text} (pxc/entity db eid)
        _ (when-not text
            (throw (ex-info (pxc/err-msg-not-found "Text" eid) {:code 404 :id eid})))
        _ (when-not (or (string? new-body-or-ops) (sequential? new-body-or-ops))
            (throw (ex-info "Text body must be a string." {:body body :code 400})))
        ops (if (string? new-body-or-ops)
              (ta/diff body new-body-or-ops)
              new-body-or-ops)
        tokens (map #(pxc/entity db %) (get-token-ids db eid))
        indexed-tokens (reduce #(assoc %1 (:token/id %2) %2) {} tokens)
        {new-text :text new-tokens :tokens deleted-token-ids :deleted} (ta/apply-text-edits ops text tokens)
        needs-update? (fn [{:token/keys [begin end id]}]
                        (or (not= begin (:token/begin (clojure.core/get indexed-tokens id)))
                            (not= end (:token/end (clojure.core/get indexed-tokens id)))))
        deletion-tx (when (seq deleted-token-ids) (tok/multi-delete* xt-map deleted-token-ids))
        tokens-to-update (filter needs-update? new-tokens)
        update-tx (when (seq tokens-to-update)
                    (mapcat (fn [{:token/keys [id] :as token}]
                              [[::xt/match id (pxc/entity db id)]
                               [::xt/put token]])
                            tokens-to-update))
        text-tx [[::xt/match (:text/id text) text]
                 [::xt/put (assoc text :text/body (:text/body new-text))]]
        tx (reduce into [text-tx deletion-tx update-tx])]
    tx))

(defn update-body-operation
  "Build an operation for updating text body"
  [xt-map eid new-body]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        text (pxc/entity db eid)
        project-id (project-id db eid)
        doc-id (:text/document text)
        token-ids (get-token-ids db eid)
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
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        token-ids (get-token-ids db eid)
        span-ids (mapcat #(tok/get-span-ids db %) token-ids)
        relation-ids (mapcat #(s/get-relation-ids db %) span-ids)
        dependent-ids (reduce into [token-ids span-ids relation-ids])
        matches (conj (mapv (fn [id] [::xt/match id (pxc/entity db id)]) dependent-ids)
                      [::xt/match eid (pxc/entity db eid)])
        deletes (conj (mapv (fn [id] [::xt/delete id]) dependent-ids)
                      [::xt/delete eid])]

    (when-not (:text/id (pxc/entity db eid))
      (throw (ex-info (pxc/err-msg-not-found "Text" eid) {:code 404 :id eid})))

    (vec (reduce into [matches deletes]))))

(defn delete-operation
  "Build an operation for deleting a text"
  [xt-map eid]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        text (pxc/entity db eid)
        project-id (project-id db eid)
        doc-id (:text/document text)
        token-ids (get-token-ids db eid)
        span-ids (mapcat #(tok/get-span-ids db %) token-ids)
        relation-ids (mapcat #(s/get-relation-ids db %) span-ids)
        tx-ops (delete* xt-map eid)]
    (op/make-operation
     {:type        :text/delete
      :project     project-id
      :document    doc-id
      :description (str "Delete text " eid " with " (count token-ids) " tokens, " (count span-ids) " spans, " (count relation-ids) " relations")
      :tx-ops      tx-ops})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

(defn set-metadata [xt-map eid metadata user-id]
  (letfn [(project-id-fn [db eid] (project-id db eid))
          (document-id-fn [db text] (:text/document text))]
    (metadata/set-metadata xt-map eid metadata user-id "text" project-id-fn document-id-fn)))

(defn delete-metadata [xt-map eid user-id]
  (letfn [(project-id-fn [db eid] (project-id db eid))
          (document-id-fn [db text] (:text/document text))]
    (metadata/delete-metadata xt-map eid user-id "text" project-id-fn document-id-fn)))