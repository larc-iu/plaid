(ns plaid.sql.token-layer
  "SQL port of plaid.xtdb2.token-layer. Token layers live in the
  `token_layers` table; ordering within a text layer is by `order_idx`.

  `parent_token_layer_id` is immutable and may only point to another
  token_layer in the same text_layer whose overlap_mode is
  :non-overlapping or :partitioning — validated at create time.

  External API mirrors xtdb2: same fn names + arglists, `db` replaces
  `node-or-map`. Heavy token-overlap enforcement lives in
  plaid.sql.constraints.token, not here."
  (:require [clojure.string :as str]
            [taoensso.timbre :as log]
            [plaid.sql.common :as psc]
            [plaid.sql.constraints.token :as tc]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.sql.span-layer :as span-layer]
            [plaid.sql.token :as token])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:token-layer/id
                :token-layer/name
                :token-layer/text-layer
                :token-layer/project
                :token-layer/overlap-mode
                :token-layer/parent-token-layer
                :config])

(def valid-overlap-modes #{:any :non-overlapping :partitioning})

;; ============================================================
;; Row mapper
;; ============================================================

(defn- row->token-layer
  "Translate a `token_layers` row to the namespaced shape. overlap_mode
  comes back as a string from the DB; convert to keyword."
  [row]
  (when row
    {:token-layer/id                   (:id row)
     :token-layer/name                 (:name row)
     :token-layer/text-layer           (:text_layer_id row)
     :token-layer/project              (:project_id row)
     :token-layer/overlap-mode         (some-> (:overlap_mode row) keyword)
     :token-layer/parent-token-layer   (:parent_token_layer_id row)
     :config                           (psc/parse-config (:config row))}))

;; ============================================================
;; Reads
;; ============================================================

(defn get [db id]
  (row->token-layer (psc/fetch-by-id db :token_layers id)))

(defn project-id [db id]
  (:project_id (psc/fetch-by-id db :token_layers id)))

(defn overlap-mode
  "Returns the keyword overlap-mode for a token layer (default :any)."
  [db id]
  (or (some-> (psc/fetch-by-id db :token_layers id)
              :overlap_mode
              keyword)
      :any))

(defn sort-token-records
  "Pure helper: deterministically sort token records (task #101, revised
  2026-06-02). Ordering matches the SQL ORDER BY in get-with-layer-data and
  plaid.sql.token/get-tokens — the canonical token order, precedence OUTRANKS
  extent (see plaid.sql.query.compile):
    1. :token/begin ASC
    2. :token/precedence ASC, NULLS LAST (a nil precedence ranks AFTER any
       integer precedence)
    3. :token/end ASC (shorter token first, among equal begin+precedence)
    4. :token/id ASC (final deterministic tiebreaker)

  Used by document/get-with-layer-data after grouping the pre-ordered
  token rows by token-layer; sort key is identical so the resulting
  per-layer list is stable across DB engines whose ORDER BY may
  re-stabilize differently for nulls."
  [tokens]
  (sort-by (fn [t]
             [(:token/begin t)
              ;; NULLS LAST: tag nil with 1, non-nil with 0, then compare
              ;; the precedence (using 0 as a placeholder for nil — its
              ;; partition is already separated by the leading tag).
              (if (nil? (:token/precedence t)) 1 0)
              (or (:token/precedence t) 0)
              (:token/end t)
              (str (:token/id t))])
           tokens))

;; ============================================================
;; Mutations
;; ============================================================

(defn- validate-parent!
  "Validate the parent_token_layer reference. Throws ex-info 400 on
  any violation. Returns nil on success or when no parent is given."
  [tx parent-tl-id text-layer-id overlap-mode-kw]
  (when parent-tl-id
    (cond
      ;; Partitioning is only meaningful on root layers — see v2 rationale.
      (= :partitioning overlap-mode-kw)
      (throw (ex-info (str "A nested token layer may not use overlap-mode :partitioning"
                           " (partitioning is only allowed on root token layers).")
                      {:overlap-mode overlap-mode-kw
                       :parent-token-layer parent-tl-id
                       :code 400})))
    (let [parent (psc/fetch-by-id tx :token_layers parent-tl-id)]
      (cond
        (nil? parent)
        (throw (ex-info (psc/err-msg-not-found "Parent token layer" parent-tl-id)
                        {:id parent-tl-id :code 400}))

        (not= (:text_layer_id parent) text-layer-id)
        (throw (ex-info "Parent token layer must belong to the same text layer as this layer."
                        {:parent-token-layer parent-tl-id :code 400}))

        (not (#{"non-overlapping" "partitioning"} (:overlap_mode parent)))
        (throw (ex-info (str "Parent token layer must be :non-overlapping or :partitioning"
                             " (a parent's tokens must be disjoint so child containment is unambiguous).")
                        {:parent-token-layer parent-tl-id
                         :parent-overlap-mode (some-> (:overlap_mode parent) keyword)
                         :code 400}))))))

(defn create
  "Create a new token layer in `text-layer-id`. `attrs` may include
  :token-layer/name, :token-layer/overlap-mode (defaults :any),
  :token-layer/parent-token-layer, and :config.

  `order_idx` is resolved by a scalar-subquery inside the INSERT itself
  (see `psc/next-order-idx-expr`) — atomic against concurrent creates
  against the same text_layer, and guarded by the
  `UNIQUE (text_layer_id, order_idx)` constraint on token_layers."
  [db attrs text-layer-id user-id]
  (let [{:token-layer/keys [name]} attrs
        overlap-mode-kw (or (:token-layer/overlap-mode attrs) :any)
        new-id (psc/new-uuid)
        config (clojure.core/get attrs :config {})
        parent-tl-id (:token-layer/parent-token-layer attrs)]
    (submit-operation! [tx db {:type :token-layer/create
                               :project (clojure.core/get
                                         (psc/fetch-by-id db :text_layers text-layer-id)
                                         :project_id)
                               :document nil
                               :description (str "Create token layer \"" name "\" in text layer "
                                                 text-layer-id)
                               :user user-id}]
                       ;; Validation inside the body (task #47) so name + overlap-mode
                       ;; rejections produce {:success false :code 400}.
                       (psc/valid-name? name)
                       (when-not (valid-overlap-modes overlap-mode-kw)
                         (throw (ex-info (str "Invalid overlap-mode: " overlap-mode-kw
                                              ". Must be one of: "
                                              (str/join ", " (map clojure.core/name valid-overlap-modes)))
                                         {:overlap-mode overlap-mode-kw :code 400})))
                       (let [txtl (psc/fetch-by-id tx :text_layers text-layer-id)]
                         (when (nil? txtl)
                           (throw (ex-info (psc/err-msg-not-found "Text layer" text-layer-id)
                                           {:id text-layer-id :code 400})))
                         (validate-parent! tx parent-tl-id text-layer-id overlap-mode-kw)
                         (psc/insert! tx :token_layers
                                      {:id new-id
                                       :name name
                                       :text_layer_id text-layer-id
                                       :project_id (:project_id txtl)
                                       :overlap_mode (clojure.core/name overlap-mode-kw)
                                       :parent_token_layer_id parent-tl-id
                                       :order_idx (psc/next-order-idx-expr
                                                   :token_layers
                                                   [:= :text_layer_id text-layer-id])
                                       :config (psc/serialize-config config)})
                         new-id))))

(defn merge
  "Update mutable fields. Only :token-layer/name is mutable;
  parent_token_layer_id and overlap_mode are immutable post-create."
  [db eid m user-id]
  (submit-operation! [tx db {:type :token-layer/update
                             :project (project-id db eid)
                             :document nil
                             :description (str "Update token layer " eid)
                             :user user-id}]
                     (when-let [n (:token-layer/name m)]
                       (psc/valid-name? n))
                     (let [existing (psc/fetch-by-id tx :token_layers eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Token layer" eid) {:code 404 :id eid})))
                       (let [attrs (cond-> {}
                                     (some? (:token-layer/name m))
                                     (assoc :name (:token-layer/name m)))]
                         (when (seq attrs)
                           (psc/update-by-id! tx :token_layers eid attrs))
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

(defn shift-token-layer [db tokl-id up? user-id]
  (submit-operation! [tx db {:type :token-layer/shift
                             :project (project-id db tokl-id)
                             :document nil
                             :description (str "Shift token layer " tokl-id " " (if up? "up" "down"))
                             :user user-id}]
                     (shift-layer! tx :token_layers tokl-id :text_layer_id up?)))

(defn- descendant-token-layer-ids
  "Vector of descendant token_layer ids (transitive over
  parent_token_layer_id), INCLUDING `root-id` itself, ordered from
  leaves up to the root.

  Delegates the descendant walk to
  `plaid.sql.constraints.token/descendant-layer-ids`, which uses a
  cycle-safe `UNION` recursive CTE (see its docstring). We then prepend
  the root and compute leaves-first depth ordering in-Clojure via one
  parent_token_layer_id lookup over the full id set. Deepest-first is
  load-bearing: FK on parent_token_layer_id is ON DELETE CASCADE, so
  the explicit audited delete must reach a child layer before its
  parent layer's row goes away."
  [tx root-id]
  (let [desc-ids (tc/descendant-layer-ids tx root-id)
        all-ids (cons root-id desc-ids)]
    (if (empty? desc-ids)
      [root-id]
      (let [rows (psc/q tx {:select [:id :parent_token_layer_id]
                            :from :token_layers
                            :where [:in :id (vec all-ids)]})
            parent-of (into {} (map (juxt :id :parent_token_layer_id)) rows)
            depth-of (fn [id]
                       ;; Walk parent chain to root-id (or until parent ∉ set,
                       ;; which only happens for root-id itself). Visited-set
                       ;; bound by all-ids count guards against any cycle the
                       ;; CTE's UNION dedup couldn't prevent above.
                       (loop [cur id seen #{} d 0]
                         (cond
                           (= cur root-id) d
                           (contains? seen cur) d
                           :else (if-let [p (clojure.core/get parent-of cur)]
                                   (recur p (conj seen cur) (inc d))
                                   d))))]
        (vec (sort-by (comp - depth-of) all-ids))))))

(defn cascade-delete!
  "Tx-level cascade for a token_layer. Walks the descendant subtree
  (child token_layers via parent_token_layer_id, plus the
  span_layer → relation_layer chain under each layer), auditing every
  row deletion before the FK CASCADE fires.

  Order:
    1. Descendant token_layers (deepest first, since each
       cascade-delete! recurses into its own subtree).
    2. Vocab_links touching ANY descendant layer's tokens — collected
       once across the full descendant set and deleted once (a
       cross-layer vocab_link otherwise gets one audit row per layer
       it spans, and a re-delete attempt on a still-present-in-cache
       id would also fail).
    3. For each token_layer (in deepest-first order): span_layers under
       it (span-layer/cascade-delete!), then tokens themselves (via
       token/multi-delete!), then the token_layer row and its
       entity_metadata.

  Reused by text_layer's cascade walker as well as `delete` here."
  [tx root-id]
  ;; Resolve once: child token_layers (deepest first).
  (let [layer-ids (descendant-token-layer-ids tx root-id)]
    ;; Step 1: drop vocab_links touching tokens in ANY descendant layer
    ;; in one pass — dedupes cross-layer links so each is audited once.
    (let [vl-ids (->> (psc/q tx {:select-distinct [:vl.id]
                                 :from [[:vocab_links :vl]]
                                 :join [[:vocab_link_tokens :vlt] [:= :vlt.vocab_link_id :vl.id]
                                        [:tokens :t] [:= :t.id :vlt.token_id]]
                                 :where [:in :t.token_layer_id (vec layer-ids)]})
                      (mapv :id))]
      (when (seq vl-ids)
        (psc/delete-where! tx :vocab_links [:in :id vl-ids])
        (psc/execute! tx
                      {:delete-from :entity_metadata
                       :where [:and
                               [:= :entity_type "vocab-link"]
                               [:in :entity_id vl-ids]]})))
    ;; Step 2: per-layer span_layers, tokens, then the layer row.
    (doseq [tl-id layer-ids]
      ;; span_layers under this token_layer.
      (let [sl-ids (->> (psc/q tx {:select [:id]
                                   :from :span_layers
                                   :where [:= :token_layer_id tl-id]})
                        (mapv :id))]
        (doseq [sl-id sl-ids]
          (span-layer/cascade-delete! tx sl-id)))
      ;; Tokens in this token_layer (token/multi-delete! cascades to
      ;; spans/relations/vocab_links + entity_metadata for tokens).
      ;; vocab_links touching these tokens have already been swept above.
      (let [tok-ids (->> (psc/q tx {:select [:id]
                                    :from :tokens
                                    :where [:= :token_layer_id tl-id]})
                         (mapv :id))]
        (when (seq tok-ids)
          (token/multi-delete! tx tok-ids)))
      ;; Token_layer's own entity_metadata + row.
      (psc/execute! tx
                    {:delete-from :entity_metadata
                     :where [:and
                             [:= :entity_type "token-layer"]
                             [:= :entity_id tl-id]]})
      (psc/delete-by-id! tx :token_layers tl-id))))

(defn delete
  "Delete a token layer. Walks the descendant subtree (child
  token_layers via parent_token_layer_id, plus span_layers →
  relation_layers and the tokens/spans/relations/vocab_links they
  reach) and audits each row deletion through the audited helpers so
  audit_writes captures every change — FK ON DELETE CASCADE would
  otherwise silently sweep them."
  [db eid user-id]
  (submit-operation! [tx db {:type :token-layer/delete
                             :project (project-id db eid)
                             :document nil
                             :description (str "Delete token layer " eid)
                             :user user-id}]
                     (let [existing (psc/fetch-by-id tx :token_layers eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Token layer" eid) {:code 404 :id eid})))
                       (cascade-delete! tx eid)
                       eid)))
