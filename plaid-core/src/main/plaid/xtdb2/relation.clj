(ns plaid.xtdb2.relation
  (:require [xtdb.api :as xt]
            [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.operation :as op :refer [submit-operations!]]
            [plaid.xtdb2.relation-layer :as rl]
            [plaid.xtdb2.metadata :as metadata])
  (:refer-clojure :exclude [get merge format]))

(def core-attr-keys [:relation/id
                     :relation/layer
                     :relation/source
                     :relation/target
                     :relation/value])

;; Queries ------------------------------------------------------------------------

(defn format [raw-record]
  (let [core-attrs (select-keys raw-record core-attr-keys)]
    (metadata/add-metadata-to-response core-attrs raw-record "relation")))

(defn get [node-or-map id]
  (when-let [e (pxc/entity node-or-map :relations id)]
    (when (:relation/id e)
      (format e))))

(defn project-id [node-or-map id]
  (let [r (pxc/entity node-or-map :relations id)]
    (when r
      (rl/project-id node-or-map (:relation/layer r)))))

(defn get-doc-id-of-span
  "Get document id from the stored :span/document attribute."
  [node-or-map span-id]
  (:span/document (pxc/entity node-or-map :spans span-id)))

;; Mutations ----------------------------------------------------------------------

(defn- check-relation-invariants!
  [node {:relation/keys [layer source target]} source-record target-record]
  (when-not (:span/id source-record)
    (throw (ex-info (str "Source span " source " does not exist") {:id source :code 400})))
  (when-not (:span/id target-record)
    (throw (ex-info (str "Target span " target " does not exist") {:id target :code 400})))
  (when-not (= (:span/layer source-record) (:span/layer target-record))
    (throw (ex-info "Source and target relations must be contained in a single span layer."
                    {:source-layer (:span/layer source-record)
                     :target-layer (:span/layer target-record)
                     :code 400})))
  (let [sl (pxc/entity node :span-layers (:span/layer source-record))]
    (when-not (some #{layer} (:span-layer/relation-layers sl))
      (throw (ex-info (str "Relation layer " layer " is not connected to span layer " (:span/layer source-record))
                      {:relation-layer layer :span-layer (:span/layer source-record) :code 400}))))
  (when-not (= (get-doc-id-of-span node source) (get-doc-id-of-span node target))
    (throw (ex-info "Source and target relations must be in a single document."
                    {:code 400}))))

(defn- relation-attr? [k]
  (= "relation" (namespace k)))

(defn create* [xt-map attrs]
  (let [node (pxc/->node xt-map)
        rel-attrs (filter (fn [[k _]] (relation-attr? k)) attrs)
        {:relation/keys [id layer source target] :as r}
        (clojure.core/merge (pxc/new-record "relation")
                            {:relation/document (get-doc-id-of-span node (:relation/source attrs))}
                            (into {} rel-attrs))
        source-record (pxc/entity node :spans source)
        target-record (pxc/entity node :spans target)
        layer-e (pxc/entity-with-sys-from node :relation-layers layer)
        source-e (pxc/entity-with-sys-from node :spans source)
        target-e (pxc/entity-with-sys-from node :spans target)]
    (when (pxc/entity node :relations id)
      (throw (ex-info (pxc/err-msg-already-exists "Relation" id) {:id id :code 409})))
    (when-not (:relation-layer/id (pxc/entity node :relation-layers layer))
      (throw (ex-info (pxc/err-msg-not-found "Relation layer" layer) {:id layer :code 400})))
    (check-relation-invariants! node r source-record target-record)
    [[:sql "ASSERT NOT EXISTS (SELECT 1 FROM relations WHERE _id = ?)" [id]]
     (pxc/match* :spans source-e)
     (pxc/match* :spans target-e)
     (pxc/match* :relation-layers layer-e)
     [:put-docs :relations r]]))

(defn create-operation [xt-map attrs metadata]
  (let [node (pxc/->node xt-map)
        {:relation/keys [layer source target]} attrs
        doc-id (get-doc-id-of-span node source)
        meta-attrs (metadata/transform-metadata-for-storage metadata "relation")
        attrs-with-meta (clojure.core/merge attrs meta-attrs)
        tx-ops (create* xt-map attrs-with-meta)]
    (op/make-operation
     {:type :relation/create
      :project (rl/project-id xt-map layer)
      :document doc-id
      :description (str "Create relation from span " source " to span " target " in layer " layer)
      :tx-ops tx-ops})))

(defn create
  ([xt-map attrs user-id]
   (create xt-map attrs user-id nil))
  ([xt-map attrs user-id metadata]
   (submit-operations! xt-map [(create-operation xt-map attrs metadata)] user-id
                       #(-> % last last :xt/id))))

(defn merge-operation [xt-map eid m]
  (let [node (pxc/->node xt-map)
        r (pxc/entity node :relations eid)
        doc-id (:relation/document r)
        updates (into {} (filter (fn [[k _]] (relation-attr? k)) m))]
    (op/make-operation
     {:type :relation/update-attributes
      :project (project-id xt-map eid)
      :document doc-id
      :description (str "Update attributes of relation " eid)
      :tx-ops (pxc/merge* xt-map :relations :relation/id eid updates)})))

(defn merge [xt-map eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(defn set-end* [xt-map eid key span-id]
  (let [node (pxc/->node xt-map)
        {:relation/keys [layer source target] :as r} (pxc/entity node :relations eid)
        r-e (pxc/entity-with-sys-from node :relations eid)
        new-span (pxc/entity node :spans span-id)
        new-span-e (pxc/entity-with-sys-from node :spans span-id)
        source-e (pxc/entity-with-sys-from node :spans source)
        target-e (pxc/entity-with-sys-from node :spans target)
        layer-e (pxc/entity-with-sys-from node :relation-layers layer)]
    (when-not r
      (throw (ex-info (pxc/err-msg-not-found "Relation" eid) {:code 404 :id eid})))
    (when-not (#{:relation/source :relation/target} key)
      (throw (ex-info "Key must be either :relation/source or :relation/target" {:code 500 :key key})))
    (let [test-source-id (if (= :relation/source key) span-id source)
          test-target-id (if (= :relation/target key) span-id target)
          test-source (if (= :relation/source key) new-span (pxc/entity node :spans source))
          test-target (if (= :relation/target key) new-span (pxc/entity node :spans target))
          test-r (assoc r :relation/source test-source-id :relation/target test-target-id)]
      (check-relation-invariants! node test-r test-source test-target))
    [(pxc/match* :relations r-e)
     (pxc/match* :spans source-e)
     (pxc/match* :spans target-e)
     (pxc/match* :relation-layers layer-e)
     (pxc/match* :spans new-span-e)
     [:put-docs :relations (-> r-e
                               (dissoc :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)
                               (assoc key span-id))]]))

(defn set-end-operation [xt-map eid key span-id]
  (let [node (pxc/->node xt-map)
        r (pxc/entity node :relations eid)
        doc-id (:relation/document r)
        end-type (if (= key :relation/source) "source" "target")]
    (op/make-operation
     {:type :relation/update-endpoint
      :project (project-id xt-map eid)
      :document doc-id
      :description (str "Update " end-type " of relation " eid " to span " span-id)
      :tx-ops (set-end* xt-map eid key span-id)})))

(defn set-end [xt-map eid key span-id user-id]
  (submit-operations! xt-map [(set-end-operation xt-map eid key span-id)] user-id))

(defn delete* [xt-map eid]
  (let [node (pxc/->node xt-map)
        r (pxc/entity-with-sys-from node :relations eid)]
    (when (nil? (:relation/id r))
      (throw (ex-info (pxc/err-msg-not-found "Relation" eid) {:code 404 :id eid})))
    [(pxc/match* :relations r)
     [:delete-docs :relations eid]]))

(defn delete-operation [xt-map eid]
  (let [node (pxc/->node xt-map)
        r (pxc/entity node :relations eid)
        doc-id (when r (:relation/document r))]
    (op/make-operation
     {:type :relation/delete
      :project (project-id xt-map eid)
      :document doc-id
      :description (str "Delete relation " eid)
      :tx-ops (delete* xt-map eid)})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

;; Metadata
(defn set-metadata [xt-map eid metadata user-id]
  (metadata/set-metadata xt-map eid metadata user-id "relation" project-id :relation/document))

(defn delete-metadata [xt-map eid user-id]
  (metadata/delete-metadata xt-map eid user-id "relation" project-id :relation/document))

;; Bulk operations
(defn- check-relations-consistency! [relations-attrs]
  (when-not (= 1 (->> relations-attrs (map :relation/layer) distinct count))
    (throw (ex-info "Relations must all belong to the same layer" {:code 400}))))

(defn bulk-create* [xt-map relations-attrs]
  (let [node (pxc/->node xt-map)
        layer (-> relations-attrs first :relation/layer)
        layer-e (pxc/entity-with-sys-from node :relation-layers layer)
        relations-attrs (mapv (fn [attrs]
                                (if (:metadata attrs)
                                  (let [meta-attrs (metadata/transform-metadata-for-storage (:metadata attrs) "relation")]
                                    (clojure.core/merge (dissoc attrs :metadata) meta-attrs))
                                  (dissoc attrs :metadata)))
                              relations-attrs)
        ;; Collect all referenced span IDs and fetch them once
        all-span-ids (->> relations-attrs (mapcat (fn [a] [(:relation/source a) (:relation/target a)])) distinct)
        span-cache (into {} (map (fn [sid]
                                   [sid (pxc/entity-with-sys-from node :spans sid)])
                                 all-span-ids))
        ;; Derive doc-id and span-layer from first source
        first-source (clojure.core/get span-cache (-> relations-attrs first :relation/source))
        doc-id (:span/document first-source)
        span-layer-id (:span/layer first-source)
        sl (pxc/entity node :span-layers span-layer-id)
        project-id (rl/project-id node layer)]
    (check-relations-consistency! relations-attrs)
    ;; Document consistency check using cache
    (let [doc-ids (->> relations-attrs (map :relation/source) (map #(:span/document (clojure.core/get span-cache %))) distinct)]
      (when-not (= 1 (count doc-ids))
        (throw (ex-info "Not all relations belong to the same document" {:document-ids doc-ids :code 400}))))
    ;; Layer linkage check (once)
    (when-not (some #{layer} (:span-layer/relation-layers sl))
      (throw (ex-info (str "Relation layer " layer " is not connected to span layer " span-layer-id)
                      {:relation-layer layer :span-layer span-layer-id :code 400})))
    {:tx-ops
     (vec
      (concat
       [(pxc/match* :relation-layers layer-e)]
       (reduce
        (fn [tx-ops attrs]
          (let [rel-attrs (filter (fn [[k _]] (relation-attr? k)) attrs)
                {:relation/keys [id layer source target] :as r}
                (clojure.core/merge (pxc/new-record "relation")
                                    {:relation/document doc-id}
                                    (into {} rel-attrs))
                source-record (clojure.core/get span-cache source)
                target-record (clojure.core/get span-cache target)
                source-e (clojure.core/get span-cache source)
                target-e (clojure.core/get span-cache target)]
            ;; Validate source/target exist
            (when-not (:span/id source-record)
              (throw (ex-info (str "Source span " source " does not exist") {:id source :code 400})))
            (when-not (:span/id target-record)
              (throw (ex-info (str "Target span " target " does not exist") {:id target :code 400})))
            (when-not (= (:span/layer source-record) (:span/layer target-record))
              (throw (ex-info "Source and target relations must be contained in a single span layer."
                              {:source-layer (:span/layer source-record)
                               :target-layer (:span/layer target-record)
                               :code 400})))
            (when-not (= (:span/document source-record) (:span/document target-record))
              (throw (ex-info "Source and target relations must be in a single document."
                              {:code 400})))
            (into tx-ops [[:sql "ASSERT NOT EXISTS (SELECT 1 FROM relations WHERE _id = ?)" [id]]
                          (pxc/match* :spans source-e)
                          (pxc/match* :spans target-e)
                          [:put-docs :relations r]])))
        []
        relations-attrs)))
     :doc-id doc-id
     :project-id project-id}))

(defn bulk-create-operation [xt-map relations-attrs]
  (let [{:keys [tx-ops doc-id project-id]} (bulk-create* xt-map relations-attrs)
        layer (-> relations-attrs first :relation/layer)]
    (op/make-operation
     {:type :relation/bulk-create
      :project project-id
      :document doc-id
      :description (str "Bulk create " (count relations-attrs) " relations in layer " layer)
      :tx-ops tx-ops})))

(defn bulk-create [xt-map relations-attrs user-id]
  (submit-operations!
   xt-map
   [(bulk-create-operation xt-map relations-attrs)]
   user-id
   (fn [entity-ops]
     (vec (for [[op-type _table record] entity-ops
                :when (and (= op-type :put-docs) (:relation/id record))]
            (:relation/id record))))))

(defn bulk-delete* [xt-map eids]
  (let [node (pxc/->node xt-map)
        relations (mapv #(pxc/entity node :relations %) eids)]
    (let [doc-ids (->> relations (map :relation/document) distinct)]
      (when-not (= 1 (count doc-ids))
        (throw (ex-info "Not all relations belong to the same document" {:document-ids doc-ids :code 400}))))
    (vec
     (for [eid eids
           :let [r (pxc/entity-with-sys-from node :relations eid)]
           :when (:relation/id r)
           op [(pxc/match* :relations r) [:delete-docs :relations eid]]]
       op))))

(defn bulk-delete-operation [xt-map eids]
  (let [node (pxc/->node xt-map)
        first-r (pxc/entity node :relations (first eids))
        doc-id (when first-r (get-doc-id-of-span node (:relation/source first-r)))]
    (op/make-operation
     {:type :relation/bulk-delete
      :project (when first-r (project-id xt-map (first eids)))
      :document doc-id
      :description (str "Bulk delete " (count eids) " relations")
      :tx-ops (bulk-delete* xt-map eids)})))

(defn bulk-delete [xt-map eids user-id]
  (submit-operations! xt-map [(bulk-delete-operation xt-map eids)] user-id))
