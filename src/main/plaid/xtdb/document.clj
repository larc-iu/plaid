(ns plaid.xtdb.document
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations! submit-operations-with-extras!]]
            [plaid.xtdb.text :as text]
            [plaid.xtdb.token :as token]
            [plaid.xtdb.token-layer :as tokl]
            [plaid.xtdb.span :as s]
            [plaid.xtdb.relation :as r])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:document/id
                :document/name
                :document/project])


;; Queries ------------------------------------------------------------------------
(defn get
  "Get a document by ID, formatted for external consumption (API responses)."
  [db-like id]
  (when-let [document-entity (pxc/find-entity (pxc/->db db-like) {:document/id id})]
    (select-keys document-entity attr-keys)))

(defn project-id [db-like id]
  (:document/project (pxc/entity (pxc/->db db-like) id)))

(defmulti get-doc-info (fn [db doc-id parent-id [key id]] key))

(defmethod get-doc-info :document/id [db doc-id parent-id [key id]]
  (let [txtl-ids (->> id
                      (pxc/entity db)
                      :document/project
                      (pxc/entity db)
                      :project/text-layers)]
    {:document/text-layers (mapv #(get-doc-info db doc-id id [:text-layer/id %]) txtl-ids)}))

(defmethod get-doc-info :text-layer/id [db doc-id parent-id [key id]]
  (let [tokl-ids (:text-layer/token-layers (pxc/entity db id))
        text-entity (pxc/find-entity db [[:text/document parent-id]
                                         [:text/layer id]])
        text (when text-entity (dissoc (text/get db (:text/id text-entity)) :text/layer))
        token-layers (mapv #(get-doc-info db doc-id id [:token-layer/id %]) tokl-ids)]
    (-> (select-keys (pxc/entity db id) [:text-layer/id :text-layer/name :config])
        (assoc :text-layer/token-layers token-layers)
        (cond-> (some? text) (assoc :text-layer/text text)))))

(defmethod get-doc-info :token-layer/id [db doc-id parent-id [key id]]
  (let [sl-ids (:token-layer/span-layers (pxc/entity db id))
        token-ids (->> (xt/q db
                             '{:find  [?tok]
                               :where [[?tok :token/text ?txt]
                                       [?tok :token/layer ?tokl]
                                       [?txt :text/layer ?txtl]
                                       [?txt :text/document ?doc]]
                               :in    [[?txtl ?doc ?tokl]]}
                             [parent-id doc-id id])
                       (mapv first))
        tokens (->> token-ids
                    (mapv #(dissoc (token/get db %) :token/layer))
                    tokl/sort-token-records)]
    (-> (select-keys (pxc/entity db id) [:token-layer/id :token-layer/name :config])
        (assoc :token-layer/tokens tokens)
        (assoc :token-layer/span-layers (mapv #(get-doc-info db doc-id id [:span-layer/id %]) sl-ids)))))

(defmethod get-doc-info :span-layer/id [db doc-id parent-id [key id]]
  (let [rl-ids (:span-layer/relation-layers (pxc/entity db id))
        span-ids (->> (xt/q db
                           '{:find  [?s]
                             :where [[?s :span/tokens ?tok]
                                     [?s :span/layer ?sl]
                                     [?tok :token/layer ?tokl]
                                     [?tok :token/text ?txt]
                                     [?txt :text/document ?doc]]
                             :in    [[?tokl ?doc ?sl]]}
                           [parent-id doc-id id])
                      (mapv first))
        spans (mapv #(dissoc (s/get db %) :span/layer) span-ids)]
    (-> (select-keys (pxc/entity db id) [:span-layer/id :span-layer/name :config])
        (assoc :span-layer/spans spans)
        (assoc :span-layer/relation-layers (mapv #(get-doc-info db doc-id id [:relation-layer/id %]) rl-ids)))))

(defmethod get-doc-info :relation-layer/id [db doc-id parent-id [key id]]
  (let [relation-ids (->> (xt/q db
                                '{:find  [?r]
                                  :where [[?r :relation/source ?s]
                                          [?r :relation/layer ?rl]
                                          [?s :span/layer ?sl]
                                          [?s :span/tokens ?tok]
                                          [?tok :token/text ?txt]
                                          [?txt :text/document ?doc]]
                                  :in    [[?sl ?doc ?rl]]}
                                [parent-id doc-id id])
                          (mapv first))
        relations (mapv #(dissoc (r/get db %) :relation/layer) relation-ids)]
    (-> (select-keys (pxc/entity db id) [:relation-layer/id :relation-layer/name :config])
        (assoc :relation-layer/relations relations))))

(defn get-with-layer-data
  [db-like id]
  (let [db (pxc/->db db-like)
        doc (get db id)]
    (if (nil? doc)
      nil
      (clojure.core/merge doc (get-doc-info db id nil [:document/id id])))))

(defn get-text-layers
  [db-like id]
  (let [db (pxc/->db db-like)]
    (->> (xt/q db
               '{:find  [?txtl]
                 :where [[?doc :document/project ?prj]
                         [?prj :project/text-layers ?txtl]]
                 :in    [?doc]}
               id)
         (mapv #(hash-map :text-layer/id (first %))))))

(defn get-text-ids [db-like eid]
  (map first (xt/q (pxc/->db db-like)
                   '{:find  [?txt]
                     :where [[?txt :text/document ?doc]]
                     :in    [?doc]}
                   eid)))

;; Mutations ----------------------------------------------------------------------
(defn create* [xt-map attrs]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        {:document/keys [id project name] :as record} (clojure.core/merge (pxc/new-record "document")
                                                                          (select-keys attrs attr-keys))
        tx [[::xt/match project (pxc/entity db project)]
            [::xt/match id nil]
            [::xt/put record]]]
    (pxc/valid-name? name)
    (cond
      (some? (pxc/entity db id))
      (throw (ex-info (pxc/err-msg-already-exists "Document" id) {:id id :code 409}))

      (nil? (:project/id (pxc/entity db project)))
      (throw (ex-info (pxc/err-msg-not-found "Project" project) {:id project :code 400}))

      :else
      tx)))

(defn create-operation
  "Build an operation for creating a document"
  [xt-map attrs]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        {:document/keys [project name]} attrs
        tx-ops (create* xt-map attrs)]
    (op/make-operation
     {:type        :document/create
      :project     project
      :document    (-> tx-ops last last :xt/id)
      :description (str "Create document \"" name "\" in project " project)
      :tx-ops      tx-ops})))

(defn create [xt-map attrs user-id]
  (submit-operations-with-extras! xt-map [(create-operation xt-map attrs)] user-id #(-> % last last :xt/id)))

(defn merge-operation
  "Build an operation for updating a document"
  [xt-map eid m]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        document (pxc/entity db eid)
        project-id (project-id db eid)
        tx-ops (do (when-let [name (:document/name m)]
                     (pxc/valid-name? name))
                   (pxc/merge* xt-map eid (select-keys m [:document/name])))]
    (op/make-operation
     {:type        :document/update
      :project     project-id
      :document    eid
      :description (str "Update document " eid (when (:document/name m) (str " to name \"" (:document/name m) "\"")))
      :tx-ops      tx-ops})))

(defn merge
  [{:keys [node db] :as xt-map} eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(defn delete* [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        text-ids (get-text-ids db eid)
        text-deletes (reduce into (mapv #(text/delete* xt-map %) text-ids))]

    (when-not (:document/id (pxc/entity db eid))
      (throw (ex-info (pxc/err-msg-not-found "Document" eid) {:code 404 :id eid})))

    (reduce into [text-deletes
                  [[::xt/match eid (pxc/entity db eid)]
                   [::xt/delete eid]]])))

(defn delete-operation
  "Build an operation for deleting a document"
  [xt-map eid]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        document (pxc/entity db eid)
        project-id (project-id db eid)
        text-ids (get-text-ids db eid)
        tx-ops (delete* xt-map eid)]
    (op/make-operation
     {:type        :document/delete
      :project     project-id
      :document    eid
      :description (str "Delete document " eid " with " (count text-ids) " texts")
      :tx-ops      tx-ops})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

