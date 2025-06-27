(ns plaid.xtdb.relation
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations! submit-operations-with-extras!]]
            [plaid.xtdb.relation-layer :as rl]
            [plaid.xtdb.metadata :as metadata]
            [clojure.string :as str])
  (:refer-clojure :exclude [get merge]))

(def core-attr-keys [:relation/id
                     :relation/layer
                     :relation/source
                     :relation/target
                     :relation/value])

;; Queries ------------------------------------------------------------------------
(defn format [raw-record]
  (let [core-attrs (select-keys raw-record [:relation/id :relation/layer :relation/source :relation/target :relation/value])]
    (metadata/add-metadata-to-response core-attrs raw-record "relation")))

(defn get
  "Get a relation by ID, formatted for external consumption (API responses)."
  [db-like id]
  (when-let [relation-entity (pxc/find-entity (pxc/->db db-like) {:relation/id id})]
    (format relation-entity)))

(defn project-id [db-like id]
  (-> (xt/q (pxc/->db db-like)
            '{:find  [?prj]
              :where [[?prj :project/text-layers ?txtl]
                      [?txtl :text-layer/token-layers ?tokl]
                      [?tokl :token-layer/span-layers ?sl]
                      [?sl :span-layer/relation-layers ?rl]
                      [?r :relation/layer ?rl]]
              :in    [?r]}
            id)
      first
      first))

(defn- project-id-from-layer [db-like layer-id]
  (-> (xt/q (pxc/->db db-like)
            '{:find  [?prj]
              :where [[?prj :project/text-layers ?txtl]
                      [?txtl :text-layer/token-layers ?tokl]
                      [?tokl :token-layer/span-layers ?sl]
                      [?sl :span-layer/relation-layers ?rl]]
              :in    [?rl]}
            layer-id)
      first
      first))

(defn- get-doc-id-of-span
  "Get document id of a span"
  [db-like span-id]
  (ffirst
    (xt/q (pxc/->db db-like)
          '{:find  [?doc]
            :where [[?s :span/tokens ?tok]
                    [?tok :token/text ?txt]
                    [?txt :text/document ?doc]]
            :in    [?s]}
          span-id)))

;; Mutations --------------------------------------------------------------------------------
(defn- relation-attr? 
  "Check if an attribute key belongs to relation namespace (including metadata attributes)."
  [k]
  (= "relation" (namespace k)))

(defn create* [xt-map attrs]
  (let [{:keys [db node] :as xt-map} (pxc/ensure-db xt-map)
        relation-attrs (filter (fn [[k v]] (relation-attr? k)) attrs)
        {:relation/keys [id layer source target] :as r} (clojure.core/merge (pxc/new-record "relation")
                                                                            (into {} relation-attrs))
        source-record (pxc/entity db source)
        target-record (pxc/entity db target)]

    (cond
      ;; ID is not already taken?
      (some? (pxc/entity db id))
      (throw (ex-info (pxc/err-msg-already-exists "Relation" id) {:id id :code 409}))

      ;; Relation layer exists?
      (not (:relation-layer/id (pxc/entity db layer)))
      (throw (ex-info (pxc/err-msg-not-found "Relation layer" layer) {:id layer :code 400}))

      ;; Source span exists?
      (not (:span/id source-record))
      (throw (ex-info (str "Source span " source " does not exist") {:id source :code 400}))

      ;; Target span exists?
      (not (:span/id target-record))
      (throw (ex-info (str "Source span " target " does not exist") {:id target :code 400}))

      ;; Source and target spans in same layer?
      (not= (:span/layer source-record) (:span/layer target-record))
      (throw (ex-info "Source and target relations must be contained in a single span layer."
                      {:source-layer (:span/layer source-record)
                       :target-layer (:span/layer target-record)
                       :code         400}))

      ;; Relation layer linked to span layer?
      (not ((set (:span-layer/relation-layers (pxc/entity db (:span/layer source-record)))) layer))
      (throw (ex-info (str "Relation layer " layer " is not connected to span layer " (:span/layer source-record))
                      {:relation-layer layer :span-layer (:span/layer source-record) :code 400}))

      ;; Source and target spans in same doc?
      (not= (get-doc-id-of-span db source) (get-doc-id-of-span db target))
      (throw (ex-info "Source and target relations must be in a single document."
                      {:source-document (get-doc-id-of-span db source)
                       :target-document (get-doc-id-of-span db target)
                       :code            400}))

      :else
      [[::xt/match id nil]
       [::xt/match source source-record]
       [::xt/match target target-record]
       [::xt/match layer (pxc/entity db layer)]
       [::xt/put r]])))

(defn create-operation
  "Build an operation for creating a relation"
  [xt-map attrs metadata]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        {:relation/keys [layer source target]} attrs
        project-id (rl/project-id db layer)
        doc-id (get-doc-id-of-span db source)
        ;; Expand metadata into relation attributes
        metadata-attrs (metadata/transform-metadata-for-storage metadata "relation")
        attrs-with-metadata (clojure.core/merge attrs metadata-attrs)
        tx-ops (create* xt-map attrs-with-metadata)]
    (op/make-operation
     {:type        :relation/create
      :project     project-id
      :document    doc-id
      :description (str "Create relation from span " source " to span " target " in layer " layer
                        (when metadata (str " and " (count metadata) " metadata keys")))
      :tx-ops      tx-ops})))

(defn create
  ([xt-map attrs user-id]
   (create xt-map attrs user-id nil))
  ([xt-map attrs user-id metadata]
   (submit-operations-with-extras! xt-map [(create-operation xt-map attrs metadata)] user-id #(-> % last last :xt/id))))

(defn merge-operation
  "Build an operation for updating a relation's attributes"
  [xt-map eid m]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        relation (pxc/entity db eid)
        project-id (project-id db eid)
        doc-id (get-doc-id-of-span db (:relation/source relation))
        relation-attrs (filter (fn [[k v]] (relation-attr? k)) m)
        updates (into {} relation-attrs)]
    (op/make-operation
     {:type        :relation/update-attributes
      :project     project-id
      :document    doc-id
      :description (str "Update attributes of relation " eid)
      :tx-ops      (pxc/merge* xt-map eid updates)})))

(defn merge
  [{:keys [node db] :as xt-map} eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(defn set-end*
  "Modify either :relation/source or :relation/target, controlled by key"
  [xt-map eid key span-id]
  (let [{:keys [db node] :as xt-map} (pxc/ensure-db xt-map)
        {:relation/keys [id layer source target] :as r} (pxc/entity db eid)
        new-span (pxc/entity db span-id)
        other-span (if (= :relation/target key)
                     (pxc/entity db source)
                     (pxc/entity db target))]
    (cond
      ;; Relation exists?
      (nil? id)
      (throw (ex-info (pxc/err-msg-not-found "Relation" eid) {:id eid :code 404}))

      ;; Span exists?
      (not (:span/id new-span))
      (throw (ex-info (str "Span " span-id " does not exist") {:id span-id :code 400}))

      ;; Relation layer linked to span layer?
      (not ((set (:span-layer/relation-layers (pxc/entity db (:span/layer new-span)))) layer))
      (throw (ex-info (str "Relation layer " layer " is not connected to span layer " (:span/layer new-span))
                      {:relation-layer layer :span-layer (:span/layer new-span) :code 400}))

      ;; Key is valid?
      (not (#{:relation/source :relation/target} key))
      (throw (ex-info "Key must be either :relation/source or :relation/target"
                      {:code 500 :key key}))

      ;; Source and target spans in same doc?
      (not= (get-doc-id-of-span db (:span/id new-span)) (get-doc-id-of-span db (:span/id other-span)))
      (throw (ex-info "Source and target relations must be in a single document."
                      {:source-document (get-doc-id-of-span db (:span/id source))
                       :target-document (get-doc-id-of-span db (:span/id target))
                       :code            400}))


      ;; Spans in same layer?
      (not= (:span/layer other-span) (:span/layer new-span))
      (throw (ex-info "Source and target relations must be in the same layer."
                      {:current-layer (:span/layer other-span)
                       :new-layer     (:span/layer new-span)
                       :code          400}))

      :else
      [[::xt/match id r]
       [::xt/match source (pxc/entity db source)]
       [::xt/match target (pxc/entity db target)]
       [::xt/match layer (pxc/entity db layer)]
       [::xt/match span-id new-span]
       [::xt/put (assoc r key span-id)]])))

(defn set-end-operation
  "Build an operation for updating a relation's source or target"
  [xt-map eid key span-id]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        relation (pxc/entity db eid)
        project-id (project-id db eid)
        doc-id (get-doc-id-of-span db (:relation/source relation))
        end-type (if (= key :relation/source) "source" "target")
        tx-ops (set-end* xt-map eid key span-id)]
    (op/make-operation
     {:type        :relation/update-endpoint
      :project     project-id
      :document    doc-id
      :description (str "Update " end-type " of relation " eid " to span " span-id)
      :tx-ops      tx-ops})))

(defn set-end [xt-map eid key span-id user-id]
  (submit-operations! xt-map [(set-end-operation xt-map eid key span-id)] user-id))

(defn delete* [xt-map eid]
  (let [{:keys [db node] :as xt-map} (pxc/ensure-db xt-map)
        r (pxc/entity db eid)]

    (when-not (:relation/id (pxc/entity db eid))
      (throw (ex-info (pxc/err-msg-not-found "Relation" eid) {:code 404 :id eid})))

    [[::xt/match eid r]
     [::xt/delete eid]]))

(defn delete-operation
  "Build an operation for deleting a relation"
  [xt-map eid]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        relation (pxc/entity db eid)
        project-id (project-id db eid)
        doc-id (when relation (get-doc-id-of-span db (:relation/source relation)))
        tx-ops (delete* xt-map eid)]
    (op/make-operation
     {:type        :relation/delete
      :project     project-id
      :document    doc-id
      :description (str "Delete relation " eid)
      :tx-ops      tx-ops})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

(defn set-metadata*
  "Build transaction ops for replacing all metadata on a relation"
  [xt-map eid metadata]
  (metadata/set-metadata-tx-ops* xt-map eid metadata "relation"))

(defn set-metadata-operation
  "Build an operation for replacing all metadata on a relation"
  [xt-map eid metadata]
  (letfn [(project-id-fn [db eid] (project-id db eid))
          (document-id-fn [db relation] (get-doc-id-of-span db (:relation/source relation)))]
    (metadata/make-set-metadata-operation xt-map eid metadata "relation" project-id-fn document-id-fn)))

(defn set-metadata [xt-map eid metadata user-id]
  (letfn [(project-id-fn [db eid] (project-id db eid))
          (document-id-fn [db relation] (get-doc-id-of-span db (:relation/source relation)))]
    (metadata/set-metadata xt-map eid metadata user-id "relation" project-id-fn document-id-fn)))

(defn delete-metadata*
  "Build transaction ops for removing all metadata from a relation"
  [xt-map eid]
  (metadata/delete-metadata-tx-ops* xt-map eid "relation"))

(defn delete-metadata-operation
  "Build an operation for removing all metadata from a relation"
  [xt-map eid]
  (letfn [(project-id-fn [db eid] (project-id db eid))
          (document-id-fn [db relation] (get-doc-id-of-span db (:relation/source relation)))]
    (metadata/make-delete-metadata-operation xt-map eid "relation" project-id-fn document-id-fn)))

(defn delete-metadata [xt-map eid user-id]
  (letfn [(project-id-fn [db eid] (project-id db eid))
          (document-id-fn [db relation] (get-doc-id-of-span db (:relation/source relation)))]
    (metadata/delete-metadata xt-map eid user-id "relation" project-id-fn document-id-fn)))

(defn bulk-create*
  "Create multiple relations in a single transaction"
  [xt-map relations-attrs]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        layer (-> relations-attrs first :relation/layer)
        layer-entity (pxc/entity db layer)
        relations-attrs (mapv (fn [attrs]
                               (if (:metadata attrs)
                                 (let [metadata (:metadata attrs)
                                       relation-attrs (dissoc attrs :metadata)
                                       metadata-attrs (when metadata
                                                        (metadata/transform-metadata-for-storage metadata "relation"))]
                                   (clojure.core/merge relation-attrs metadata-attrs))
                                 (dissoc attrs :metadata)))
                             relations-attrs)]
    ;; Validate all relations are for the same layer
    (when-not (= 1 (->> relations-attrs (map :relation/layer) distinct count))
      (throw (ex-info "Relations must all belong to the same layer" {:code 400})))

    ;; Validate all relations belong to the same document (via their spans)
    (let [doc-ids (->> relations-attrs
                       (map :relation/source)
                       (map (partial get-doc-id-of-span db))
                       distinct)]
      (when-not (= 1 (count doc-ids))
        (throw (ex-info "Not all relations belong to the same document" {:document-ids doc-ids :code 400}))))

    ;; If validation passes, create transaction operations
    (vec
      (concat
        [[::xt/match layer layer-entity]]
        (reduce
          (fn [tx-ops attrs]
            (let [relation-attrs (filter (fn [[k v]] (relation-attr? k)) attrs)
                  {:relation/keys [id layer source target] :as relation} (clojure.core/merge (pxc/new-record "relation")
                                                                                             (into {} relation-attrs))
                  source-record (pxc/entity db source)
                  target-record (pxc/entity db target)]
              ;; Validate this relation's attributes (same validation as single create)
              (cond
                ;; ID is not already taken?
                (some? (pxc/entity db id))
                (throw (ex-info (pxc/err-msg-already-exists "Relation" id) {:id id :code 409}))

                ;; Source span exists?
                (not (:span/id source-record))
                (throw (ex-info (str "Source span " source " does not exist") {:id source :code 400}))

                ;; Target span exists?
                (not (:span/id target-record))
                (throw (ex-info (str "Target span " target " does not exist") {:id target :code 400}))

                ;; Source and target spans in same layer?
                (not= (:span/layer source-record) (:span/layer target-record))
                (throw (ex-info "Source and target relations must be contained in a single span layer."
                                {:source-layer (:span/layer source-record)
                                 :target-layer (:span/layer target-record)
                                 :code         400}))

                ;; Relation layer linked to span layer?
                (not ((set (:span-layer/relation-layers (pxc/entity db (:span/layer source-record)))) layer))
                (throw (ex-info (str "Relation layer " layer " is not connected to span layer " (:span/layer source-record))
                                {:relation-layer layer :span-layer (:span/layer source-record) :code 400}))

                ;; Source and target spans in same doc?
                (not= (get-doc-id-of-span db source) (get-doc-id-of-span db target))
                (throw (ex-info "Source and target relations must be in a single document."
                                {:source-document (get-doc-id-of-span db source)
                                 :target-document (get-doc-id-of-span db target)
                                 :code            400}))

                :else
                (into tx-ops [[::xt/match id nil]
                              [::xt/match source source-record]
                              [::xt/match target target-record]
                              [::xt/put relation]]))))
          []
          relations-attrs)))))

(defn bulk-create-operation
  "Build an operation for creating multiple relations"
  [xt-map relations-attrs]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        ;; Get project and document info from first relation (assuming all in same project/doc)
        first-attrs (first relations-attrs)
        {:relation/keys [layer source]} first-attrs
        project-id (project-id-from-layer db layer)
        doc-id (get-doc-id-of-span db source)
        tx-ops (bulk-create* xt-map relations-attrs)]
    (op/make-operation
      {:type        :relation/bulk-create
       :project     project-id
       :document    doc-id
       :description (str "Bulk create " (count relations-attrs) " relations in layer " layer)
       :tx-ops      tx-ops})))

(defn bulk-create
  "Create multiple relations in a single operation"
  [xt-map relations-attrs user-id]
  (submit-operations-with-extras!
    xt-map
    [(bulk-create-operation xt-map relations-attrs)]
    user-id
    (fn [tx]
      (vec (for [[op-type record] tx
                 :when (and (= op-type ::xt/put)
                            (:relation/id record))]
             (:relation/id record))))))

(defn bulk-delete*
  "Delete multiple relations in a single transaction"
  [xt-map eids]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        relations-attrs (mapv #(pxc/entity db %) eids)]
    ;; Validate all relations belong to the same document
    (let [doc-ids (->> relations-attrs
                       (map :relation/source)
                       (map (partial get-doc-id-of-span db))
                       distinct)]
      (when-not (= 1 (count doc-ids))
        (throw (ex-info "Not all relations belong to the same document" {:document-ids doc-ids :code 400}))))

    ;; Delete all relations
    (vec
      (for [eid eids
            :let [relation (pxc/entity db eid)]
            :when relation
            op [[::xt/match eid relation]
                [::xt/delete eid]]]
        op))))

(defn bulk-delete-operation
  "Build an operation for deleting multiple relations"
  [xt-map eids]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        ;; Get project info from first relation
        first-relation (pxc/entity db (first eids))
        project-id (when first-relation (project-id db (first eids)))
        doc-id (when first-relation (get-doc-id-of-span db (:relation/source first-relation)))
        tx-ops (bulk-delete* xt-map eids)]
    (op/make-operation
      {:type        :relation/bulk-delete
       :project     project-id
       :document    doc-id
       :description (str "Bulk delete " (count eids) " relations")
       :tx-ops      tx-ops})))

(defn bulk-delete
  "Delete multiple relations in a single operation"
  [xt-map eids user-id]
  (submit-operations! xt-map [(bulk-delete-operation xt-map eids)] user-id))