(ns plaid.sql.relation-layer
  "SQL port of plaid.xtdb2.relation-layer. Relation layers live in
  the `relation_layers` table; ordering within a span layer is by
  `order_idx`.

  External API mirrors xtdb2: same fn names + arglists, `db` replaces
  `node-or-map`. Relations cascade-delete via FK ON DELETE CASCADE."
  (:require [taoensso.timbre :as log]
            [plaid.sql.common :as psc]
            [plaid.sql.operation :as op :refer [submit-operation!]])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:relation-layer/id
                :relation-layer/name
                :relation-layer/span-layer
                :relation-layer/project
                :config])

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
     :config                    (psc/parse-config (:config row))}))

;; ============================================================
;; Reads
;; ============================================================

(defn get [db id]
  (row->relation-layer (psc/fetch-by-id db :relation_layers id)))

(defn project-id [db id]
  (:project_id (psc/fetch-by-id db :relation_layers id)))

;; ============================================================
;; Mutations
;; ============================================================

(defn create
  "Create a new relation layer in `span-layer-id`.

  `order_idx` is resolved by a scalar-subquery inside the INSERT itself
  (see `psc/next-order-idx-expr`) — atomic against concurrent creates
  against the same span_layer, and guarded by the
  `UNIQUE (span_layer_id, order_idx)` constraint on relation_layers."
  [db attrs span-layer-id user-id]
  (let [{:relation-layer/keys [name]} attrs
        new-id (psc/new-uuid)
        config (clojure.core/get attrs :config {})]
    (submit-operation! [tx db {:type :relation-layer/create
                               :project (clojure.core/get
                                         (psc/fetch-by-id db :span_layers span-layer-id)
                                         :project_id)
                               :document nil
                               :description (str "Create relation layer \"" name "\" in span layer "
                                                 span-layer-id)
                               :user user-id}]
                       ;; Validation inside the body (task #47).
                       (psc/valid-name? name)
                       (let [sl (psc/fetch-by-id tx :span_layers span-layer-id)]
                         (when (nil? sl)
                           (throw (ex-info (psc/err-msg-not-found "Span layer" span-layer-id)
                                           {:id span-layer-id :code 400})))
                         (psc/insert! tx :relation_layers
                                      {:id new-id
                                       :name name
                                       :span_layer_id span-layer-id
                                       :project_id (:project_id sl)
                                       :order_idx (psc/next-order-idx-expr
                                                   :relation_layers
                                                   [:= :span_layer_id span-layer-id])
                                       :config (psc/serialize-config config)})
                         new-id))))

(defn merge
  [db eid m user-id]
  (submit-operation! [tx db {:type :relation-layer/update
                             :project (project-id db eid)
                             :document nil
                             :description (str "Update relation layer " eid)
                             :user user-id}]
                     (when-let [n (:relation-layer/name m)]
                       (psc/valid-name? n))
                     (let [existing (psc/fetch-by-id tx :relation_layers eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Relation layer" eid) {:code 404 :id eid})))
                       (let [attrs (cond-> {}
                                     (some? (:relation-layer/name m))
                                     (assoc :name (:relation-layer/name m)))]
                         (when (seq attrs)
                           (psc/update-by-id! tx :relation_layers eid attrs))
                         eid))))

(defn- shift-layer!
  [tx table eid parent-col up?]
  (let [row (psc/fetch-by-id tx table eid)]
    (when (nil? row)
      (throw (ex-info (psc/err-msg-not-found (clojure.core/name table) eid)
                      {:code 404 :id eid})))
    (let [parent (clojure.core/get row parent-col)
          my-idx (:order_idx row)
          neighbor (psc/q1 tx {:select [:*]
                               :from [table]
                               :where [:and
                                       [:= parent-col parent]
                                       (if up?
                                         [:< :order_idx my-idx]
                                         [:> :order_idx my-idx])]
                               :order-by [[:order_idx (if up? :desc :asc)]]
                               :limit 1})]
      (when neighbor
        (let [tmp -1
              their-idx (:order_idx neighbor)
              their-id (:id neighbor)]
          (psc/update-by-id! tx table eid {:order_idx tmp})
          (psc/update-by-id! tx table their-id {:order_idx my-idx})
          (psc/update-by-id! tx table eid {:order_idx their-idx})))
      eid)))

(defn shift-relation-layer [db rl-id up? user-id]
  (submit-operation! [tx db {:type :relation-layer/shift
                             :project (project-id db rl-id)
                             :document nil
                             :description (str "Shift relation layer " rl-id " " (if up? "up" "down"))
                             :user user-id}]
                     (shift-layer! tx :relation_layers rl-id :span_layer_id up?)))

(defn delete
  "Delete a relation layer. FK ON DELETE CASCADE would remove its
  relations at the DB layer, but FK cascades bypass audit_writes. We
  audit each child relation explicitly (relations are leaves; they have
  their own entity_metadata cleaned up here too), then drop the
  relation_layer row. The layer's own entity_metadata rows are also
  swept (no FK there)."
  [db eid user-id]
  (submit-operation! [tx db {:type :relation-layer/delete
                             :project (project-id db eid)
                             :document nil
                             :description (str "Delete relation layer " eid)
                             :user user-id}]
                     (let [existing (psc/fetch-by-id tx :relation_layers eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Relation layer" eid) {:code 404 :id eid})))
                       ;; Audited per-relation delete before the FK cascade fires.
                       ;; One bulk DELETE ... RETURNING * collapses the per-row
                       ;; loop into a single round-trip (per-id audits via
                       ;; delete-where!).
                       (let [rel-ids (->> (psc/q tx {:select [:id]
                                                     :from :relations
                                                     :where [:= :relation_layer_id eid]})
                                          (mapv :id))]
                         (when (seq rel-ids)
                           (psc/delete-where! tx :relations [:in :id rel-ids])
                           (psc/execute! tx
                                         {:delete-from :entity_metadata
                                          :where [:and
                                                  [:= :entity_type "relation"]
                                                  [:in :entity_id rel-ids]]})))
                       ;; Sweep entity_metadata for the relation-layer itself
                       ;; (no FK; no auto-cascade).
                       (psc/execute! tx
                                     {:delete-from :entity_metadata
                                      :where [:and
                                              [:= :entity_type "relation-layer"]
                                              [:= :entity_id eid]]})
                       (psc/delete-by-id! tx :relation_layers eid)
                       eid)))
