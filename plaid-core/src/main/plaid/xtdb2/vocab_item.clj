(ns plaid.xtdb2.vocab-item
  (:require [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.operation :as op :refer [submit-operations!]]
            [plaid.xtdb2.metadata :as metadata])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:vocab-item/id
                :vocab-item/layer
                :vocab-item/form])

;; Reads -------------------------------------------------------------------------

(defn get
  [node-or-map id]
  (when-let [item-entity (pxc/entity node-or-map :vocab-items id)]
    (when (:vocab-item/id item-entity)
      (let [core-attrs (select-keys item-entity attr-keys)]
        (metadata/add-metadata-to-response core-attrs item-entity "vocab-item")))))

(defn get-all-in-layer
  "Get all vocab items in a specific vocab layer."
  [node-or-map layer-id]
  (->> (pxc/find-entities node-or-map :vocab-items {:vocab-item/layer layer-id})
       (map #(metadata/add-metadata-to-response
              (select-keys % [:vocab-item/id :vocab-item/form :vocab-item/layer])
              %
              "vocab-item"))))

;; Mutations ---------------------------------------------------------------------

(defn create* [xt-map attrs]
  (let [node (pxc/->node xt-map)
        attrs (into {} (filter (fn [[k _]] (= "vocab-item" (namespace k))) attrs))
        {:vocab-item/keys [id layer] :as record} (clojure.core/merge
                                                   (pxc/new-record "vocab-item")
                                                   attrs)
        layer-e (pxc/entity-with-sys-from node :vocab-layers layer)]
    (cond
      (nil? (:vocab/id layer-e))
      (throw (ex-info (pxc/err-msg-not-found "Vocab layer" layer) {:code 404 :id layer}))

      :else
      [(pxc/match* :vocab-layers layer-e)
       [:put-docs :vocab-items record]])))

(defn create-operation
  [xt-map attrs metadata-map]
  (let [metadata-attrs (metadata/transform-metadata-for-storage metadata-map "vocab-item")
        attrs-with-metadata (clojure.core/merge attrs metadata-attrs)]
    (op/make-operation
     {:type        :vocab-item/create
      :description (format "Create vocab item '%s'" (:vocab-item/form attrs))
      :tx-ops      (create* xt-map attrs-with-metadata)
      :project     nil
      :document    nil})))

(defn create
  ([xt-map attrs user-id]
   (create xt-map attrs user-id nil))
  ([xt-map attrs user-id metadata-map]
   (submit-operations! xt-map [(create-operation xt-map attrs metadata-map)] user-id
                       #(-> % last last :xt/id))))

(defn merge-operation
  [xt-map eid m]
  (let [node (pxc/->node xt-map)
        current (pxc/entity node :vocab-items eid)]
    (when-not current
      (throw (ex-info (pxc/err-msg-not-found "Vocab item" eid) {:code 404 :id eid})))
    (op/make-operation
     {:type        :vocab-item/merge
      :description (format "Update vocab item '%s'" (:vocab-item/form current))
      :tx-ops      (pxc/merge* xt-map :vocab-items :vocab-item/id eid m)
      :project     nil
      :document    nil})))

(defn merge
  [xt-map eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(defn delete* [xt-map eid]
  (let [node (pxc/->node xt-map)
        record (pxc/entity-with-sys-from node :vocab-items eid)]
    (when-not (:vocab-item/id record)
      (throw (ex-info (pxc/err-msg-not-found "Vocab item" eid) {:code 404 :id eid})))
    (let [vl-ids (mapv :xt/id (pxc/find-entities node :vocab-links {:vocab-link/vocab-item eid}))
          vl-entities (pxc/entities-with-sys-from node :vocab-links vl-ids)]
      (into (pxc/batch-delete-ops :vocab-links vl-entities)
            [(pxc/match* :vocab-items record)
             [:delete-docs :vocab-items eid]]))))

(defn delete-operation
  [xt-map eid]
  (let [node (pxc/->node xt-map)
        current (pxc/entity node :vocab-items eid)]
    (op/make-operation
     {:type        :vocab-item/delete
      :description (format "Delete vocab item '%s'" (:vocab-item/form current))
      :tx-ops      (delete* xt-map eid)
      :project     nil
      :document    nil})))

(defn delete
  [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))
