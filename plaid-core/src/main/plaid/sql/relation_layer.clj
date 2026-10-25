(ns plaid.sql.relation-layer
  "Relation layers: the `relation_layers` table, ordered within a span
  layer by `order_idx`. Relations cascade-delete via FK ON DELETE CASCADE."
  (:require [taoensso.timbre :as log]
            [plaid.sql.cascade-statistics :as cascade-stats]
            [plaid.sql.common :as psc]
            [plaid.sql.crud :as crud]
            [plaid.sql.layer :as layer]
            [plaid.sql.operation :as op :refer [submit-operation!]])
  (:refer-clojure :exclude [get merge]))

;; ============================================================
;; Row mapper
;; ============================================================

(defn- row->relation-layer
  [row]
  (when row
    {:relation-layer/id         (:id row)
     :relation-layer/name       (:name row)
     :relation-layer/span-layer (:span_layer_id row)
     :relation-layer/project    (:project_id row)
     :config                    (psc/parse-config (:config row))
     :constraints               (psc/parse-config (:constraints row))}))

;; ============================================================
;; Reads
;; ============================================================

(def ^{:doc "Read one relation layer by id, or nil."
       :arglists '([db id])}
  get (layer/reader :relation_layers row->relation-layer))

(defn project-id
  "The project owning this relation layer."
  [db id]
  (layer/project-id db :relation_layers id))

;; ============================================================
;; Mutations
;; ============================================================

(defn create
  "Create a new relation layer in `span-layer-id`. `:relation-layer/id`
  in `attrs` names its id (a client's UUIDv7), else the server mints one.

  `order_idx` is resolved by a scalar-subquery inside the INSERT itself
  (see `psc/next-order-idx-expr`) — atomic against concurrent creates
  against the same span_layer, and guarded by the
  `UNIQUE (span_layer_id, order_idx)` constraint on relation_layers."
  [db attrs span-layer-id user-id]
  (let [{:relation-layer/keys [name]} attrs
        new-id (or (:relation-layer/id attrs) (psc/new-uuid))
        config (clojure.core/get attrs :config {})]
    (submit-operation! [tx db {:type :relation-layer/create
                               :project (clojure.core/get
                                         (psc/fetch-by-id db :span_layers span-layer-id)
                                         :project_id)
                               :document nil
                               :description (str "Create relation layer \"" name "\" in span layer "
                                                 span-layer-id)
                               :user user-id}]
                       ;; Validation inside the body.
                       (psc/assert-valid-name! name)
                       (psc/claim-ids! tx :relation_layers "relation layer" [(:relation-layer/id attrs)])
                       (let [sl (psc/fetch-by-id tx :span_layers span-layer-id)]
                         (when (nil? sl)
                           (throw (ex-info (psc/err-msg-not-found "Span layer" span-layer-id)
                                           {:id span-layer-id :code 400})))
                         (crud/insert! tx :relation_layers
                                       {:id new-id
                                        :name name
                                        :span_layer_id span-layer-id
                                        :project_id (:project_id sl)
                                        :order_idx (psc/next-order-idx-expr
                                                    :relation_layers
                                                    [:= :span_layer_id span-layer-id])
                                        :config (psc/serialize-config config)})
                         new-id))))

(defn- cascade-delete!
  "Delete a relation layer. FK ON DELETE CASCADE would remove its
  relations at the DB layer, but FK cascades bypass audit_writes. We
  audit each child relation explicitly (relations are leaves; they have
  their own entity_metadata cleaned up here too), then drop the
  relation_layer row. The layer's own entity_metadata rows are also
  swept (no FK there)."
  [tx eid]
  ;; Audited per-relation delete before the FK cascade fires, read by the
  ;; layer's index and deleted in chunks by id (per-id audits via
  ;; delete-ids!).
  (cascade-stats/prepare! tx)
  (let [rel-ids (mapv :id (crud/select-in tx :relations "id" :relation_layer_id
                                          "idx_relations_layer_doc" [eid]))]
    (crud/delete-entities! tx :relations rel-ids))
  ;; Sweep entity_metadata for the relation-layer itself (no FK; no
  ;; auto-cascade).
  (crud/delete-entity-metadata! tx "relation-layer" [eid])
  (crud/delete-by-id! tx :relation_layers eid))

(def ^:private spec
  {:table :relation_layers :kind "relation-layer" :noun "relation layer" :parent-col :span_layer_id :cascade! cascade-delete!})

(def merge "Rename a relation layer (see `layer/rename`)." (partial layer/rename spec))
(def shift "Move a relation layer one place (see `layer/shift`)." (partial layer/shift spec))
(def delete "Delete a relation layer and everything under it (see `layer/delete`)." (partial layer/delete spec))
