(ns plaid.xtdb2.document
  (:require [xtdb.api :as xt]
            [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.operation :as op :refer [submit-operations!]]
            [plaid.xtdb2.text :as text]
            [plaid.xtdb2.token :as token]
            [plaid.xtdb2.span :as s]
            [plaid.xtdb2.relation :as r]
            [plaid.xtdb2.metadata :as metadata]
            [plaid.xtdb2.vocab-item :as vocab-item]
            [plaid.xtdb2.vocab-layer :as vocab-layer]
            [plaid.xtdb2.vocab-link :as vocab-link]
            [plaid.xtdb2.token-layer :as tokl]
            [plaid.media.storage :as media])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:document/id
                :document/name
                :document/time-created
                :document/time-modified
                :document/version
                :document/project])

;; Queries -----------------------------------------------------------------------

(defn get
  "Get a document by ID, formatted for external consumption."
  [node-or-map id]
  (when-let [doc (pxc/entity node-or-map :documents id)]
    (when (:document/id doc)
      (let [node (pxc/->node node-or-map)
            ;; Find audits that reference this document, sorted by time
            doc-audits (->> (xt/q node (xt/template
                                        (-> (from :audits [{:xt/id _aid :audit/id audit-id
                                                            :audit/documents docs :audit/time t}])
                                            (unnest {:d docs})
                                            (where (= d ~id))
                                            (return audit-id t))))
                            (sort-by :t))
            latest-audit (last doc-audits)
            earliest-audit (first doc-audits)
            ;; nil timestamps are expected when no audit records exist yet
            ;; (e.g. freshly created documents before audit log is written)
            time-created (:t earliest-audit)
            time-modified (:t latest-audit)
            latest-audit-id (:audit-id latest-audit)
            core-attrs (select-keys doc attr-keys)
            core-with-version (assoc core-attrs
                                     :document/version latest-audit-id
                                     :document/time-created time-created
                                     :document/time-modified time-modified)
            core-with-media (if (media/media-exists? id)
                              (assoc core-with-version :document/media-url (str "/api/v1/documents/" id "/media"))
                              core-with-version)]
        (metadata/add-metadata-to-response core-with-media doc "document")))))

(defn project-id [node-or-map id]
  (:document/project (pxc/entity node-or-map :documents id)))

(defmulti get-doc-info (fn [node doc-id parent-id [key id]] key))

(defmethod get-doc-info :document/id [node doc-id parent-id [key id]]
  (let [doc (pxc/entity node :documents id)
        prj-id (:document/project doc)
        prj (pxc/entity node :projects prj-id)
        txtl-ids (:project/text-layers prj)]
    {:document/text-layers (mapv #(get-doc-info node doc-id id [:text-layer/id %]) txtl-ids)}))

(defmethod get-doc-info :text-layer/id [node doc-id parent-id [key id]]
  (let [text-layer (pxc/entity node :text-layers id)
        tokl-ids (:text-layer/token-layers text-layer)
        text-entity (pxc/find-entity node :texts {:text/document parent-id :text/layer id})
        text (when text-entity (dissoc (text/get node (:text/id text-entity)) :text/layer))
        token-layers (mapv #(get-doc-info node doc-id id [:token-layer/id %]) tokl-ids)]
    (-> (select-keys text-layer [:text-layer/id :text-layer/name :config])
        (pxc/deserialize-config)
        (assoc :text-layer/token-layers token-layers)
        (assoc :text-layer/text text))))

(defmethod get-doc-info :token-layer/id [node doc-id parent-id [key id]]
  (let [token-layer (pxc/entity node :token-layers id)
        sl-ids (:token-layer/span-layers token-layer)
        ;; Find tokens for this doc and layer (compound WHERE pushed to SQL)
        all-tokens (->> (pxc/find-entities node :tokens {:token/layer id :token/document doc-id})
                        (map token/format)
                        (map #(dissoc % :token/layer))
                        (vec)
                        (tokl/sort-token-records))
        ;; Get vocab-links for tokens in this layer and document (single query)
        token-ids (set (map :token/id all-tokens))
        vocab-link-ids (->> (xt/q node '(-> (from :vocab-links [{:xt/id vlid :vocab-link/tokens toks}])
                                            (unnest {:t toks})
                                            (return vlid t)))
                            (filter #(contains? token-ids (:t %)))
                            (map :vlid)
                            distinct)
        vocab-links (->> vocab-link-ids
                         (map #(pxc/entity node :vocab-links %))
                         (map vocab-link/format))
        ;; Cache vocab-item lookups to avoid fetching each one twice
        vi-cache (into {} (map (fn [link]
                                 [(:vocab-link/vocab-item link)
                                  (vocab-item/get node (:vocab-link/vocab-item link))])
                               vocab-links))
        ;; Group vocab-links by vocab-layer
        vocabs (->> vocab-links
                    (group-by #(:vocab-item/layer (vi-cache (:vocab-link/vocab-item %))))
                    (mapv (fn [[vl-id links]]
                            (let [vl-rec (vocab-layer/get node vl-id)
                                  expanded-links (mapv #(assoc % :vocab-link/vocab-item
                                                               (vi-cache (:vocab-link/vocab-item %)))
                                                       links)]
                              (assoc vl-rec :vocab-layer/vocab-links expanded-links))))
                    (filterv #(some? (first %))))]
    (-> (select-keys token-layer [:token-layer/id :token-layer/name :config])
        (pxc/deserialize-config)
        (assoc :token-layer/tokens all-tokens)
        (assoc :token-layer/span-layers (mapv #(get-doc-info node doc-id id [:span-layer/id %]) sl-ids))
        (assoc :token-layer/vocabs vocabs))))

(defmethod get-doc-info :span-layer/id [node doc-id parent-id [key id]]
  (let [span-layer (pxc/entity node :span-layers id)
        rl-ids (:span-layer/relation-layers span-layer)
        ;; Find spans for this doc and layer (compound WHERE pushed to SQL)
        all-spans (->> (pxc/find-entities node :spans {:span/layer id :span/document doc-id})
                       (map s/format)
                       (map #(dissoc % :span/layer))
                       vec)]
    (-> (select-keys span-layer [:span-layer/id :span-layer/name :config])
        (pxc/deserialize-config)
        (assoc :span-layer/spans all-spans)
        (assoc :span-layer/relation-layers (mapv #(get-doc-info node doc-id id [:relation-layer/id %]) rl-ids)))))

(defmethod get-doc-info :relation-layer/id [node doc-id parent-id [key id]]
  (let [rl (pxc/entity node :relation-layers id)
        ;; Filter relations using compound WHERE pushed to SQL
        all-relations (->> (pxc/find-entities node :relations {:relation/layer id :relation/document doc-id})
                           (map r/format)
                           (map #(dissoc % :relation/layer))
                           vec)]
    (-> (select-keys rl [:relation-layer/id :relation-layer/name :config])
        (pxc/deserialize-config)
        (assoc :relation-layer/relations all-relations))))

(defn get-with-layer-data [node-or-map id]
  (let [node (pxc/->node node-or-map)
        doc (get node-or-map id)]
    (when doc
      (clojure.core/merge doc (get-doc-info node id nil [:document/id id])))))

(defn get-text-layers [node-or-map id]
  (let [node (pxc/->node node-or-map)
        doc (pxc/entity node :documents id)
        prj-id (:document/project doc)
        prj (pxc/entity node :projects prj-id)]
    (mapv #(hash-map :text-layer/id %) (:project/text-layers prj))))

(defn get-text-ids [node-or-map eid]
  (->> (pxc/find-entities node-or-map :texts {:text/document eid})
       (map :xt/id)))

;; Mutations ---------------------------------------------------------------------

(defn create* [xt-map attrs]
  (let [node (pxc/->node xt-map)
        document-attrs (into {} (filter (fn [[k _]] (= "document" (namespace k))) attrs))
        {:document/keys [id project name] :as record} (clojure.core/merge
                                                       (pxc/new-record "document")
                                                       document-attrs)
        prj-e (pxc/entity-with-sys-from node :projects project)]
    (pxc/valid-name? name)
    (cond
      (nil? (:project/id prj-e))
      (throw (ex-info (pxc/err-msg-not-found "Project" project) {:id project :code 400}))

      :else
      [[:sql "ASSERT NOT EXISTS (SELECT 1 FROM documents WHERE _id = ?)" [id]]
       (pxc/match* :projects prj-e)
       [:put-docs :documents record]])))

(defn create-operation
  "Build an operation for creating a document with optional metadata."
  [xt-map attrs metadata-map]
  (let [{:document/keys [project name]} attrs
        metadata-attrs (metadata/transform-metadata-for-storage metadata-map "document")
        attrs-with-metadata (clojure.core/merge attrs metadata-attrs)
        tx-ops (create* xt-map attrs-with-metadata)
        doc-id (-> tx-ops last last :xt/id)]
    (op/make-operation
     {:type :document/create
      :project project
      :document doc-id
      :description (str "Create document \"" name "\" in project " project
                        (when metadata-map (str " with " (count metadata-map) " metadata keys")))
      :tx-ops tx-ops})))

(defn create
  ([xt-map attrs user-id]
   (create xt-map attrs user-id nil))
  ([xt-map attrs user-id metadata-map]
   (submit-operations! xt-map [(create-operation xt-map attrs metadata-map)] user-id
                       #(-> % last last :xt/id))))

(defn merge-operation
  "Build an operation for updating a document."
  [xt-map eid m]
  (let [node (pxc/->node xt-map)
        doc (pxc/entity node :documents eid)
        prj-id (project-id xt-map eid)
        tx-ops (do (when-let [name (:document/name m)]
                     (pxc/valid-name? name))
                   (pxc/merge* xt-map :documents :document/id eid (select-keys m [:document/name])))]
    (op/make-operation
     {:type :document/update
      :project prj-id
      :document eid
      :description (str "Update document " eid (when (:document/name m) (str " name to \"" (:document/name m) "\"")))
      :tx-ops tx-ops})))

(defn merge [xt-map eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(defn delete* [xt-map eid]
  (let [node (pxc/->node xt-map)
        doc-e (pxc/entity-with-sys-from node :documents eid)]
    (when-not (:document/id doc-e)
      (throw (ex-info (pxc/err-msg-not-found "Document" eid) {:code 404 :id eid})))
    (let [text-ids (get-text-ids xt-map eid)
          text-deletes (reduce into [] (mapv #(text/delete* xt-map %) text-ids))]
      (reduce into [text-deletes
                    [(pxc/match* :documents doc-e)
                     [:delete-docs :documents eid]]]))))

(defn delete-operation
  "Build an operation for deleting a document."
  [xt-map eid]
  (let [node (pxc/->node xt-map)
        doc (pxc/entity node :documents eid)
        prj-id (project-id xt-map eid)
        text-ids (get-text-ids xt-map eid)
        tx-ops (delete* xt-map eid)]
    (op/make-operation
     {:type :document/delete
      :project prj-id
      :document eid
      :description (str "Delete document " eid " with " (count text-ids) " texts")
      :tx-ops tx-ops})))

(defn delete [xt-map eid user-id]
  (let [result (submit-operations! xt-map [(delete-operation xt-map eid)] user-id)]
    (when (and (:success result) (media/media-exists? eid))
      (media/delete-media-file! eid))
    result))

(defn set-metadata [xt-map eid metadata-map user-id]
  (metadata/set-metadata xt-map eid metadata-map user-id "document" project-id :document/id))

(defn delete-metadata [xt-map eid user-id]
  (metadata/delete-metadata xt-map eid user-id "document" project-id :document/id))
