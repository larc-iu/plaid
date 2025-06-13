(ns plaid.xtdb.text
  (:require [xtdb.api :as xt]
            [plaid.algos.text :as ta]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations! submit-operations-with-extras!]]
            [plaid.xtdb.token :as tok]
            [plaid.xtdb.span :as s])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:text/id
                :text/document
                :text/layer
                :text/body])

;; Queries ------------------------------------------------------------------------
(defn get
  [db-like id]
  (let [db (pxc/->db db-like)]
    (pxc/find-entity db {:text/id id})))

(defn project-id [db-like id]
  (-> (xt/q (pxc/->db db-like)
            '{:find  [?prj]
              :where [[?prj :project/text-layers ?txtl]
                      [?txt :text/layer ?txtl]]
              :in    [?txt]}
            id)
      first
      first))

(defn project-id-from-layer [db-like layer-id]
  (-> (xt/q (pxc/->db db-like)
            '{:find  [?prj]
              :where [[?prj :project/text-layers ?txtl]]
              :in    [?txtl]}
            layer-id)
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

;; Mutations ----------------------------------------------------------------------
(defn create* [xt-map attrs]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        body (or (and (string? (:text/body attrs)) (:text/body attrs))
                 "")
        {:text/keys [id document layer body] :as record} (clojure.core/merge (pxc/new-record "text")
                                                                             {:text/body ""}
                                                                             (select-keys attrs attr-keys))
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
      (throw (ex-info "Text body must be a string." {:body body}))

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
  "Build an operation for creating a text"
  [xt-map attrs]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        {:text/keys [layer document]} attrs
        project-id (project-id-from-layer db layer)
        doc-id document
        tx-ops (create* xt-map attrs)]
    (op/make-operation
     {:type        :text/create
      :project     project-id
      :document    doc-id
      :description (str "Create text in layer " layer " for document " document)
      :tx-ops      tx-ops})))

(defn create [xt-map attrs user-id]
  (submit-operations-with-extras! xt-map [(create-operation xt-map attrs)] user-id #(-> % last last :xt/id)))

(defn update-body*
  "Change the textual content (:text/body) of a text item in a way that will also update tokens
  as necessary. Tokens will be updated if their corresponding substring is either removed entirely
  (resulting in deletion) or partially removed (resulting in shrinkage)."
  [xt-map eid new-body]

  (let [{:keys [db node]} (pxc/ensure-db xt-map)
        {:text/keys [body] :as text} (pxc/entity db eid)
        _ (when-not text
            (throw (ex-info (pxc/err-msg-not-found "Text" eid) {:code 404 :id eid})))
        _ (when-not (string? new-body)
            (throw (ex-info "Text body must be a string." {:body body})))
        ops (ta/diff body new-body)
        tokens (map #(pxc/entity db %) (get-token-ids db eid))
        indexed-tokens (reduce #(assoc %1 (:token/id %2) %2) {} tokens)
        {new-text :text new-tokens :tokens deleted-token-ids :deleted} (ta/apply-text-edits ops text tokens)
        needs-update? (fn [{:token/keys [begin end id]}]
                        (or (not= begin (:token/begin (clojure.core/get indexed-tokens id)))
                            (not= end (:token/end (clojure.core/get indexed-tokens id)))))
        deletion-tx (reduce into (map #(tok/delete* xt-map %) deleted-token-ids))
        update-tx (mapcat (fn [{:token/keys [id] :as token}]
                            [[::xt/match id (pxc/entity db id)]
                             [::xt/put token]])
                          (filter needs-update? new-tokens))
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