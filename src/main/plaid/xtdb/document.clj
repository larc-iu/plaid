(ns plaid.xtdb.document
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations!]]
            [plaid.xtdb.text :as text]
            [plaid.xtdb.token :as token]
            [plaid.xtdb.token-layer :as tokl]
            [plaid.xtdb.span :as s]
            [plaid.xtdb.relation :as r]
            [plaid.xtdb.metadata :as metadata]
            [plaid.xtdb.vocab-layer :as vocab-layer]
            [plaid.xtdb.vocab-item :as vocab-item]
            [plaid.xtdb.vocab-link :as vocab-link]
            [plaid.media.storage :as media])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:document/id
                :document/name
                :document/project])

;; Queries ------------------------------------------------------------------------
(defn get
  "Get a document by ID, formatted for external consumption (API responses)."
  [db-like id]
  (when-let [document-entity (pxc/find-entity (pxc/->db db-like) {:document/id id})]
    (let [db (pxc/->db db-like)
          core-attrs (select-keys document-entity attr-keys)
          ;; Get the latest audit ID for this document as version
          [latest-audit-id time-modified] (first (xt/q db
                                                       '{:find [?a s]
                                                         :where [[?a :audit/documents ?doc]
                                                                 [(get-start-valid-time ?a) s]]
                                                         :order-by [[s :desc]] :limit 1 :in [?doc]}
                                                       id))
          time-created (ffirst (xt/q db
                                     '{:find [s]
                                       :where [[?a :audit/documents ?doc]
                                               [(get-start-valid-time ?a) s]]
                                       :order-by [[s :asc]] :limit 1 :in [?doc]}
                                     id))
          core-attrs-with-version (assoc core-attrs :document/version latest-audit-id
                                                    :document/time-created time-created
                                                    :document/time-modified time-modified)
          ;; Add media URL if media file exists
          core-attrs-with-media (if (media/media-exists? id)
                                  (assoc core-attrs-with-version :document/media-url (str "/api/v1/documents/" id "/media"))
                                  core-attrs-with-version)]
      (metadata/add-metadata-to-response core-attrs-with-media document-entity "document"))))

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
  (let [text-layer (pxc/entity db id)
        tokl-ids (:text-layer/token-layers text-layer)
        text-entity (pxc/find-entity db [[:text/document parent-id]
                                         [:text/layer id]])
        text (when text-entity (dissoc (text/get db (:text/id text-entity)) :text/layer))
        token-layers (mapv #(get-doc-info db doc-id id [:token-layer/id %]) tokl-ids)]
    (-> (select-keys text-layer [:text-layer/id :text-layer/name :config])
        (assoc :text-layer/token-layers token-layers)
        (assoc :text-layer/text text))))

(defmethod get-doc-info :token-layer/id [db doc-id parent-id [key id]]
  (let [token-layer (pxc/entity db id)
        sl-ids (:token-layer/span-layers token-layer)
        tokens (->> (xt/q db
                          '{:find [(pull ?tok [*])]
                            :where [[?tok :token/-document ?doc]
                                    [?tok :token/layer ?tokl]]
                            :in [[?doc ?tokl]]}
                          [doc-id id])
                    (into [] (comp (map first)
                                   (map token/format)
                                   (map #(dissoc % :token/layer))))
                    tokl/sort-token-records
                    vec)
        ;; Get vocab-links for tokens in this layer and document
        vocab-links (->> (xt/q db
                               '{:find [(pull ?vl [*])]
                                 :where [[?vl :vocab-link/tokens ?tok]
                                         [?tok :token/-document ?doc]
                                         [?tok :token/layer ?tokl]]
                                 :in [[?doc ?tokl]]}
                               [doc-id id])
                         (map first)
                         (map vocab-link/format))
        ;; Group vocab-links by vocab-layer and build vocab structure
        vocabs (->> vocab-links
                    (group-by (fn [link]
                                ;; Get vocab-item to find its layer
                                (let [vocab-item-record (vocab-item/get db (:vocab-link/vocab-item link))]
                                  (:vocab-item/layer vocab-item-record))))
                    (mapv (fn [[vocab-layer-id links]]
                            (let [vocab-layer-record (vocab-layer/get db vocab-layer-id)
                                  ;; Expand vocab-items in each link
                                  expanded-links (mapv (fn [link]
                                                         (let [vocab-item-record (vocab-item/get db (:vocab-link/vocab-item link))]
                                                           (assoc link :vocab-link/vocab-item vocab-item-record)))
                                                       links)]
                              (assoc vocab-layer-record :vocab-layer/vocab-links expanded-links))))
                    (filterv #(some? (first %))))]
    (-> (select-keys token-layer [:token-layer/id :token-layer/name :config])
        (assoc :token-layer/tokens tokens)
        (assoc :token-layer/span-layers (mapv #(get-doc-info db doc-id id [:span-layer/id %]) sl-ids))
        (assoc :token-layer/vocabs vocabs))))

(defmethod get-doc-info :span-layer/id [db doc-id parent-id [key id]]
  (let [span-layer (pxc/entity db id)
        rl-ids (:span-layer/relation-layers span-layer)
        spans (into [] (comp (map first)
                             (map s/format)
                             (map #(dissoc % :span/layer)))
                    (xt/q db
                          '{:find [(pull ?s [*])]
                            :where [[?s :span/-document ?doc]
                                    [?s :span/layer ?sl]]
                            :in [[?doc ?sl]]}
                          [doc-id id]))]
    (-> (select-keys span-layer [:span-layer/id :span-layer/name :config])
        (assoc :span-layer/spans spans)
        (assoc :span-layer/relation-layers (mapv #(get-doc-info db doc-id id [:relation-layer/id %]) rl-ids)))))

(defmethod get-doc-info :relation-layer/id [db doc-id parent-id [key id]]
  (let [relations (into [] (comp (map first)
                                 (map r/format)
                                 (map #(dissoc % :relation/layer)))
                        (xt/q db
                              '{:find [(pull ?r [*])]
                                :where [[?r :relation/-document ?doc]
                                        [?r :relation/layer ?rl]]
                                :in [[?doc ?rl]]}
                              [doc-id id]))]
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
               '{:find [?txtl]
                 :where [[?doc :document/project ?prj]
                         [?prj :project/text-layers ?txtl]]
                 :in [?doc]}
               id)
         (mapv #(hash-map :text-layer/id (first %))))))

(defn get-text-ids [db-like eid]
  (map first (xt/q (pxc/->db db-like)
                   '{:find [?txt]
                     :where [[?txt :text/document ?doc]]
                     :in [?doc]}
                   eid)))

;; Mutations ----------------------------------------------------------------------
(defn- document-attr?
  "Check if an attribute key belongs to document namespace (including metadata attributes)."
  [k]
  (= "document" (namespace k)))

(defn create* [xt-map attrs]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        document-attrs (filter (fn [[k v]] (document-attr? k)) attrs)
        {:document/keys [id project name] :as record} (clojure.core/merge (pxc/new-record "document")
                                                                          (into {} document-attrs))
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
  "Build an operation for creating a document with optional metadata"
  [xt-map attrs metadata]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        {:document/keys [project name]} attrs
        ;; Expand metadata into document attributes
        metadata-attrs (metadata/transform-metadata-for-storage metadata "document")
        attrs-with-metadata (clojure.core/merge attrs metadata-attrs)
        tx-ops (create* xt-map attrs-with-metadata)]
    (op/make-operation
     {:type :document/create
      :project project
      :document (-> tx-ops last last :xt/id)
      :description (str "Create document \"" name "\" in project " project
                        (when metadata (str " with " (count metadata) " metadata keys")))
      :tx-ops tx-ops})))

(defn create
  ([xt-map attrs user-id]
   (create xt-map attrs user-id nil))
  ([xt-map attrs user-id metadata]
   (submit-operations! xt-map [(create-operation xt-map attrs metadata)] user-id #(-> % last last :xt/id))))

(defn merge-operation
  "Build an operation for updating a document"
  [xt-map eid m]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        document (pxc/entity db eid)
        project-id (project-id db eid)
        tx-ops (do (when-let [name (:document/name m)]
                     (pxc/valid-name? name))
                   (pxc/merge* xt-map :document/id eid (select-keys m [:document/name])))]

    (op/make-operation
     {:type :document/update
      :project project-id
      :document eid
      :description (str "Update document " eid (when (:document/name m) (str " name to \"" (:document/name m) "\"")))
      :tx-ops tx-ops})))

(defn merge
  [{:keys [node db] :as xt-map} eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(defn delete* [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        text-ids (get-text-ids db eid)
        text-deletes (reduce into (mapv #(text/delete* xt-map %) text-ids))]

    (when-not (:document/id (pxc/entity db eid))
      (throw (ex-info (pxc/err-msg-not-found "Document" eid) {:code 404 :id eid})))

    ;; Clean up media file if it exists
    (when (media/media-exists? eid)
      (media/delete-media-file! eid))

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
     {:type :document/delete
      :project project-id
      :document eid
      :description (str "Delete document " eid " with " (count text-ids) " texts")
      :tx-ops tx-ops})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

(defn set-metadata [xt-map eid metadata user-id]
  (letfn [(project-id-fn [db eid] (project-id db eid))
          (document-id-fn [db document] eid)]
    (metadata/set-metadata xt-map eid metadata user-id "document" project-id-fn document-id-fn)))

(defn delete-metadata [xt-map eid user-id]
  (letfn [(project-id-fn [db eid] (project-id db eid))
          (document-id-fn [db document] eid)]
    (metadata/delete-metadata xt-map eid user-id "document" project-id-fn document-id-fn)))

