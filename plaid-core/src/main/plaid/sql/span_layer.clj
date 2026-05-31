(ns plaid.sql.span-layer
  "SQL port of plaid.xtdb2.span-layer. Span layers live in the
  `span_layers` table; ordering within a token layer is by `order_idx`.

  External API mirrors xtdb2: same fn names + arglists, `db` replaces
  `node-or-map`. Child rows (relation_layers, spans, span_tokens,
  relations) cascade-delete via FK ON DELETE CASCADE."
  (:require [taoensso.timbre :as log]
            [plaid.sql.common :as psc]
            [plaid.sql.operation :as op :refer [submit-operation!]])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:span-layer/id
                :span-layer/name
                :span-layer/token-layer
                :span-layer/project
                :config])

;; ============================================================
;; Row mapper
;; ============================================================

(defn- row->span-layer
  [row]
  (when row
    {:span-layer/id          (:id row)
     :span-layer/name        (:name row)
     :span-layer/token-layer (:token_layer_id row)
     :span-layer/project     (:project_id row)
     :config                 (psc/parse-config (:config row))}))

;; ============================================================
;; Reads
;; ============================================================

(defn get [db id]
  (row->span-layer (psc/fetch-by-id db :span_layers id)))

(defn project-id [db id]
  (:project_id (psc/fetch-by-id db :span_layers id)))

;; ============================================================
;; Mutations
;; ============================================================

(defn create
  "Create a new span layer in `token-layer-id`.

  `order_idx` is resolved by a scalar-subquery inside the INSERT itself
  (see `psc/next-order-idx-expr`) — atomic against concurrent creates
  against the same token_layer, and guarded by the
  `UNIQUE (token_layer_id, order_idx)` constraint on span_layers."
  [db attrs token-layer-id user-id]
  (let [{:span-layer/keys [name]} attrs
        new-id (psc/new-uuid)
        config (clojure.core/get attrs :config {})]
    (submit-operation! [tx db {:type :span-layer/create
                               :project (clojure.core/get
                                         (psc/fetch-by-id db :token_layers token-layer-id)
                                         :project_id)
                               :document nil
                               :description (str "Create span layer \"" name "\" in token layer "
                                                 token-layer-id)
                               :user user-id}]
                       ;; Validation inside the body (task #47).
                       (psc/valid-name? name)
                       (let [tokl (psc/fetch-by-id tx :token_layers token-layer-id)]
                         (when (nil? tokl)
                           (throw (ex-info (psc/err-msg-not-found "Token layer" token-layer-id)
                                           {:id token-layer-id :code 400})))
                         (psc/insert! tx :span_layers
                                      {:id new-id
                                       :name name
                                       :token_layer_id token-layer-id
                                       :project_id (:project_id tokl)
                                       :order_idx (psc/next-order-idx-expr
                                                   :span_layers
                                                   [:= :token_layer_id token-layer-id])
                                       :config (psc/serialize-config config)})
                         new-id))))

(defn merge
  [db eid m user-id]
  (submit-operation! [tx db {:type :span-layer/update
                             :project (project-id db eid)
                             :document nil
                             :description (str "Update span layer " eid)
                             :user user-id}]
                     (when-let [n (:span-layer/name m)]
                       (psc/valid-name? n))
                     (let [existing (psc/fetch-by-id tx :span_layers eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Span layer" eid) {:code 404 :id eid})))
                       (let [attrs (cond-> {}
                                     (some? (:span-layer/name m))
                                     (assoc :name (:span-layer/name m)))]
                         (when (seq attrs)
                           (psc/update-by-id! tx :span_layers eid attrs))
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

(defn shift-span-layer [db sl-id up? user-id]
  (submit-operation! [tx db {:type :span-layer/shift
                             :project (project-id db sl-id)
                             :document nil
                             :description (str "Shift span layer " sl-id " " (if up? "up" "down"))
                             :user user-id}]
                     (shift-layer! tx :span_layers sl-id :token_layer_id up?)))

(defn cascade-delete!
  "Tx-level cascade for a span_layer: audit every descendant entity
  (relations and their entity_metadata, relation_layers, spans and their
  entity_metadata) before any FK CASCADE fires. Then delete the
  span_layer row itself. Reused by `delete` here and by token-layer's
  cascade walker.

  Ordering rationale: `relation_layers` has
  `relations.relation_layer_id ON DELETE CASCADE` and `spans` has
  `relations.source_span_id ON DELETE CASCADE` /
  `relations.target_span_id ON DELETE CASCADE`. ANY relation_layer or
  span deletion will FK-sweep its relations without going through
  `psc/delete-by-id!` (which is what captures the audit pre-image from
  the live row). So we must audit-delete EVERY affected relation FIRST
  — including both the relations inside nested relation_layers AND the
  relations elsewhere that reference spans in this span_layer — before
  touching any relation_layer or span row."
  [tx eid]
  (let [rl-ids (->> (psc/q tx {:select [:id]
                               :from :relation_layers
                               :where [:= :span_layer_id eid]})
                    (mapv :id))
        span-ids (->> (psc/q tx {:select [:id]
                                 :from :spans
                                 :where [:= :span_layer_id eid]})
                      (mapv :id))
        ;; 1. Collect ALL affected relations in a single query:
        ;;    - relations inside nested relation_layers (rl-ids), AND
        ;;    - relations anywhere whose source/target span is in this
        ;;      span_layer (span-ids). DISTINCT collapses any overlap.
        rel-where (cond
                    (and (seq rl-ids) (seq span-ids))
                    [:or
                     [:in :relation_layer_id rl-ids]
                     [:in :source_span_id span-ids]
                     [:in :target_span_id span-ids]]
                    (seq rl-ids)
                    [:in :relation_layer_id rl-ids]
                    (seq span-ids)
                    [:or
                     [:in :source_span_id span-ids]
                     [:in :target_span_id span-ids]]
                    :else nil)
        rel-ids (if rel-where
                  (->> (psc/q tx {:select-distinct [:id]
                                  :from :relations
                                  :where rel-where})
                       (mapv :id))
                  [])]
    ;; 2. Audit-delete every affected relation BEFORE any
    ;;    relation_layer or span row goes away. One bulk DELETE ...
    ;;    RETURNING * fans out per-id audit rows via delete-where!.
    (when (seq rel-ids)
      (psc/delete-where! tx :relations [:in :id rel-ids])
      (psc/execute! tx
                    {:delete-from :entity_metadata
                     :where [:and
                             [:= :entity_type "relation"]
                             [:in :entity_id rel-ids]]}))
    ;; 3. Relation_layers under this span_layer + their
    ;;    entity_metadata. Relations under them were drained in step 2,
    ;;    so the FK cascade on `relations.relation_layer_id` is a no-op.
    (when (seq rl-ids)
      (psc/delete-where! tx :relation_layers [:in :id rl-ids])
      (psc/execute! tx
                    {:delete-from :entity_metadata
                     :where [:and
                             [:= :entity_type "relation-layer"]
                             [:in :entity_id rl-ids]]}))
    ;; 4. Spans in this layer + their entity_metadata. Relations
    ;;    referencing these spans were drained in step 2, so FK cascade
    ;;    on `relations.source_span_id` / `target_span_id` is a no-op.
    (when (seq span-ids)
      (psc/delete-where! tx :spans [:in :id span-ids])
      (psc/execute! tx
                    {:delete-from :entity_metadata
                     :where [:and
                             [:= :entity_type "span"]
                             [:in :entity_id span-ids]]})))
  ;; 5. The span_layer itself + its own entity_metadata.
  (psc/execute! tx
                {:delete-from :entity_metadata
                 :where [:and
                         [:= :entity_type "span-layer"]
                         [:= :entity_id eid]]})
  (psc/delete-by-id! tx :span_layers eid))

(defn delete
  "Delete a span layer. Walks the descendant subtree (relation_layers,
  relations, spans) deleting each through the audited helpers so
  audit_writes captures the change — FK ON DELETE CASCADE would
  otherwise silently sweep them. Entity_metadata rows (no FK) are also
  cleaned up explicitly."
  [db eid user-id]
  (submit-operation! [tx db {:type :span-layer/delete
                             :project (project-id db eid)
                             :document nil
                             :description (str "Delete span layer " eid)
                             :user user-id}]
                     (let [existing (psc/fetch-by-id tx :span_layers eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Span layer" eid) {:code 404 :id eid})))
                       (cascade-delete! tx eid)
                       eid)))
