(ns plaid.sql.constraints.token
  "Token constraint checking for the SQL port.

  Enforces three axes of token-layer invariants on every token mutation:
    1. Overlap-mode (:any / :non-overlapping / :partitioning) within the
       layer.
    2. Nesting containment — a child token must sit inside some
       parent-layer token (same document) when the layer declares
       :token-layer/parent-token-layer.
    3. Parent-side orphan guard — structural ops on a parent token that
       would orphan nested child-layer tokens are rejected (the caller's
       cascade has already removed/resized the children).

  This is the SQL translation of plaid.xtdb2.constraints.token. The
  single biggest change: XTDB v2 used `match*` + `[:sql \"ASSERT NOT
  EXISTS …\"]` ops as TOCTOU fences against concurrent writers; under
  SQLite's serializable-on-write isolation, every read inside the tx
  already sees a consistent snapshot and the writer is alone. So all of
  the ASSERT-emitting helpers from the v2 version are gone — `enforce!`
  is purely pre-flight validation now.

  `enforce!` is the single entry point. Each token mutation in
  plaid.sql.token calls it once with the op keyword, a ctx map of
  relevant fields, and the open tx. On violation it throws ex-info with
  :code 400 (validation) or 409 (conflict). On success it returns nil."
  (:require [plaid.sql.common :as psc])
  (:refer-clojure :exclude [get]))

;; ---------------------------------------------------------------------------
;; Row mapper (parent_token_layer_id / overlap_mode coming back from DB)
;; ---------------------------------------------------------------------------

(defn- token-row->light
  "Lightweight token shape for in-memory use by the constraint code.
  Keeps the same keys the v2 enforcement code reads (:token/id,
  :token/layer, :token/begin, :token/end, :token/document), plus
  `:token/precedence` (task #115) so the in-memory containment matcher
  can apply the same load-bearing precedence tiebreaker the SQL ORDER
  BY uses."
  [row]
  (when row
    {:token/id         (:id row)
     :token/layer      (:token_layer_id row)
     :token/document   (:document_id row)
     :token/begin      (:begin row)
     :token/end        (:end_ row)
     :token/precedence (:precedence row)}))

;; ---------------------------------------------------------------------------
;; Layer reads
;; ---------------------------------------------------------------------------

(defn layer-overlap-mode
  "Return the overlap-mode keyword (:any / :non-overlapping /
  :partitioning) for `layer-id`. Defaults to :any if the layer or
  column is missing (matches v2 behavior)."
  [db layer-id]
  (or (some-> (psc/q1 db {:select [:overlap_mode]
                          :from [:token_layers]
                          :where [:= :id layer-id]})
              :overlap_mode
              keyword)
      :any))

(defn- layer-parent
  "Return the parent_token_layer_id (or nil for a root layer)."
  [db layer-id]
  (:parent_token_layer_id (psc/q1 db {:select [:parent_token_layer_id]
                                      :from [:token_layers]
                                      :where [:= :id layer-id]})))

(defn descendant-layer-ids
  "Return all transitive descendant token-layer ids of `layer-id`
  (children, grandchildren, …) as a vector. Empty if `layer-id` has no
  children.

  Uses `UNION` (not `UNION ALL`) to give the recursive CTE a built-in
  seen-set defense: SQLite does not detect cycles in `WITH RECURSIVE`,
  so a hypothetical future schema migration or raw UPDATE introducing
  a cycle in `parent_token_layer_id` would make `UNION ALL` loop
  forever. `UNION` deduplicates the running set and so terminates
  naturally on any reachable cycle. The schema today makes
  parent_token_layer_id immutable + create-time-validated, but this
  defends against drift.

  This mirrors the v2 implementation's seen-set guard."
  [db layer-id]
  (->> (psc/q db ["WITH RECURSIVE descendants(id) AS (
                     SELECT id FROM token_layers WHERE parent_token_layer_id = ?
                     UNION
                     SELECT tl.id FROM token_layers tl
                       JOIN descendants d ON tl.parent_token_layer_id = d.id
                   )
                   SELECT id FROM descendants"
                  layer-id])
       (mapv :id)))

;; ---------------------------------------------------------------------------
;; Descendant token reads (used by cascades in plaid.sql.token)
;; ---------------------------------------------------------------------------

(defn- descendant-token-where
  "Common WHERE skeleton for descendant scans: dlids restriction +
  doc-id. Returns a HoneySQL :and vector that callers can extend with
  more conditions."
  [dlids doc-id]
  [:and
   [:in :token_layer_id (vec dlids)]
   [:= :document_id doc-id]])

(defn descendant-tokens-in-extent
  "Descendant tokens (in the given descendant-layer set, same doc) whose
  extent is wholly inside [lo, hi). Returns a vector of light token maps.
  Empty if `dlids` is empty."
  [db dlids doc-id lo hi]
  (if (empty? dlids)
    []
    (let [rows (psc/q db {:select [:id :token_layer_id :document_id :begin :end_]
                          :from :tokens
                          :where (conj (descendant-token-where dlids doc-id)
                                       [:>= :begin lo]
                                       [:<= :end_ hi])})]
      (mapv token-row->light rows))))

(defn straddling-descendant-tokens-at
  "Descendant tokens (same doc) straddling position `p` — strict on both
  sides: begin < p AND end_ > p. Doc-wide scan; used by the partitioning
  resize cascade where the moved boundary lies in exactly one parent."
  [db dlids doc-id p]
  (if (empty? dlids)
    []
    (let [rows (psc/q db {:select [:id :token_layer_id :document_id :begin :end_]
                          :from :tokens
                          :where (conj (descendant-token-where dlids doc-id)
                                       [:< :begin p]
                                       [:> :end_ p])})]
      (mapv token-row->light rows))))

(defn straddling-descendant-tokens-in
  "Like straddling-descendant-tokens-at, but restricted to descendants
  whose extent sits within [lo, hi). Used by the split cascade so only
  descendants inside the SPLIT token's extent are touched — siblings'
  descendants elsewhere in the document must not be. (A historical
  rationale here referenced parents on :any layers; parent layers have
  required :non-overlapping/:partitioning since create-time validation
  landed, but the extent restriction is still what scopes the cascade.)"
  [db dlids doc-id lo hi p]
  (if (empty? dlids)
    []
    (let [rows (psc/q db {:select [:id :token_layer_id :document_id :begin :end_]
                          :from :tokens
                          :where (conj (descendant-token-where dlids doc-id)
                                       [:>= :begin lo]
                                       [:<= :end_ hi]
                                       [:< :begin p]
                                       [:> :end_ p])})]
      (mapv token-row->light rows))))

;; ---------------------------------------------------------------------------
;; Overlap query
;; ---------------------------------------------------------------------------

(defn find-overlapping-tokens
  "Find tokens in the same (layer, document) that overlap [begin, end).
  Two tokens overlap when t.begin < end AND t.end_ > begin.
  Optional :exclude-id excludes one token id (typical for update/shift)."
  [db layer-id doc-id begin end & {:keys [exclude-id]}]
  (let [rows (psc/q db {:select [:id :token_layer_id :document_id :begin :end_]
                        :from :tokens
                        :where (cond-> [:and
                                        [:= :token_layer_id layer-id]
                                        [:= :document_id doc-id]
                                        [:< :begin end]
                                        [:> :end_ begin]]
                                 exclude-id (conj [:<> :id exclude-id]))})]
    (mapv token-row->light rows)))

;; ---------------------------------------------------------------------------
;; Parent containment (axis 2, forward)
;; ---------------------------------------------------------------------------

(defn containing-parent
  "Return the parent-layer token whose extent contains [begin, end), or
  nil. Containment is inclusive: a child equal in extent to its parent
  counts as contained. ORDER BY: tightest extent first (largest begin,
  then smallest end), then precedence (ASC, NULLS LAST), then id —
  deterministic insurance if the parent layer presents overlapping
  candidates. Task #115: with #101's overlap-mode constraints landed,
  same-extent parents on `:any` layers are common, and `:token/precedence`
  is now the load-bearing tiebreaker between them — id-only ordering
  picked a parent that was a function of UUID bytes, not the
  user-controlled precedence the constraint spec promises."
  [db parent-layer-id doc-id begin end]
  (-> (psc/q1 db {:select [:id :token_layer_id :document_id :begin :end_ :precedence]
                  :from :tokens
                  :where [:and
                          [:= :token_layer_id parent-layer-id]
                          [:= :document_id doc-id]
                          [:<= :begin begin]
                          [:>= :end_ end]]
                  :order-by [[:begin :desc]
                             [:end_ :asc]
                             [:precedence :asc-nulls-last]
                             [:id :asc]]
                  :limit 1})
      token-row->light))

(defn- parent-tokens-for-doc
  "All tokens in the parent layer (same doc). Used to resolve
  containment for a batch of children with one read instead of an
  N+1 of single-row containing-parent lookups."
  [db parent-layer-id doc-id]
  (->> (psc/q db {:select [:id :token_layer_id :document_id :begin :end_ :precedence]
                  :from :tokens
                  :where [:and
                          [:= :token_layer_id parent-layer-id]
                          [:= :document_id doc-id]]})
       (mapv token-row->light)))

(defn- containing-parent-in-memory
  "In-memory equivalent of containing-parent over a pre-fetched parent
  token seq. Same deterministic preference as the SQL ORDER BY:
  tightest extent (largest begin, then smallest end), then precedence
  (ASC, NULLS LAST — task #115), then id.

  NULLS LAST is encoded by mapping nil precedence to Long/MAX_VALUE so
  it sorts after every real precedence value under Clojure's < ordering."
  [parents begin end]
  (->> parents
       (filter (fn [p] (and (<= (:token/begin p) begin)
                            (>= (:token/end p) end))))
       (sort-by (juxt (comp - :token/begin)
                      :token/end
                      #(or (:token/precedence %) Long/MAX_VALUE)
                      (comp str :token/id)))
       first))

;; ---------------------------------------------------------------------------
;; Partition validation (used by bulk-create on :partitioning layers, and
;; by the text-edit gap-fill compensator in plaid.sql.token)
;; ---------------------------------------------------------------------------

(defn validate-partition-range!
  "Throw 400 unless `tokens` form a complete, gap-free, overlap-free,
  zero-width-free partition of [lo, hi). Empty + (= lo hi) is OK; empty
  + a non-empty extent throws.

  Task #104 defensive note: zero-width tokens are forbidden here, BUT
  `plaid.sql.token/compensate-partition-layers!` (the text-edit gap-fill
  compensator) re-runs this validation against the post-edit token set.
  Today the asymmetry is unreachable — zero-widths can't be created on
  partitioning layers in the first place (`check-create-overlap!` /
  `check-bulk-create-overlap!` reject them) — but a future migration
  that introduced zero-width survivors on a partitioning layer would
  trip the `Zero-width tokens are not allowed` branch below during the
  next text edit, even though #71's zero-width-preservation rule
  promises that those tokens survive structural compensation. Worth
  flagging because the two rules are designed independently and the
  conflict only surfaces under that hypothetical schema drift."
  [tokens lo hi]
  (if (empty? tokens)
    (when (> hi lo)
      (throw (ex-info "Partitioning requires tokens covering the entire extent"
                      {:code 400 :lo lo :hi hi})))
    (let [sorted (sort-by :token/begin tokens)]
      (when (not= lo (:token/begin (first sorted)))
        (throw (ex-info "Partition must start at the extent's begin"
                        {:code 400
                         :expected-begin lo
                         :actual-begin (:token/begin (first sorted))})))
      (when (not= hi (:token/end (last sorted)))
        (throw (ex-info "Partition must end at the extent's end"
                        {:code 400
                         :expected-end hi
                         :actual-end (:token/end (last sorted))})))
      (doseq [[a b] (partition 2 1 sorted)]
        (when (not= (:token/end a) (:token/begin b))
          (throw (ex-info "Partition requires contiguous tokens (no gaps or overlaps)"
                          {:code 400
                           :token-a-end (:token/end a)
                           :token-b-begin (:token/begin b)}))))
      (doseq [t sorted]
        (when (= (:token/begin t) (:token/end t))
          (throw (ex-info "Zero-width tokens are not allowed in partitioning mode"
                          {:code 400 :token-id (:token/id t)})))))))

(defn validate-partition!
  "Validate that tokens partition [0, text-length).

  Task #100 V3: an EMPTY partitioning layer (0 tokens) over a non-empty
  text is permitted as a transient state — the layer simply hasn't been
  populated yet. `validate-partition!` is fired ONLY from
  `check-bulk-create-overlap!` (where the caller is supplying the
  tokens themselves) and from `compensate-partition-layers!` (where the
  layer is known to be populated post-edit). Steady-state readers do
  not invoke this check, so an empty layer + non-empty text is
  reachable without ever tripping `validate-partition-range!`."
  [tokens text-length]
  (validate-partition-range! tokens 0 text-length))

(defn- check-no-intra-batch-overlaps!
  "Throw 400 if any two tokens in `tokens` overlap each other."
  [tokens]
  (let [sorted (sort-by :token/begin tokens)]
    (doseq [[a b] (partition 2 1 sorted)]
      (when (> (:token/end a) (:token/begin b))
        (throw (ex-info "Tokens in batch overlap each other"
                        {:code 400
                         :token-a-end (:token/end a)
                         :token-b-begin (:token/begin b)}))))))

;; ---------------------------------------------------------------------------
;; Pre-flight checks per op (overlap axis)
;;
;; Under serializable isolation, these are both the UX layer (good
;; error messages) AND the safety layer — no separate ASSERT pass is
;; needed because no other writer can interleave.
;; ---------------------------------------------------------------------------

(defn- check-create-overlap! [overlap-mode db layer-id doc-id begin end]
  (case overlap-mode
    :any nil
    :non-overlapping
    (let [overlaps (find-overlapping-tokens db layer-id doc-id begin end)]
      (when (seq overlaps)
        (throw (ex-info "Token overlaps with existing token(s) in non-overlapping layer"
                        {:code 409 :overlapping-ids (mapv :token/id overlaps)}))))
    :partitioning
    (throw (ex-info "Single token creation is not allowed on partitioning layers. Use bulk-create to establish a partition."
                    {:code 400}))))

(defn- check-update-overlap! [overlap-mode db layer-id doc-id eid new-begin new-end]
  (case overlap-mode
    :any nil
    :non-overlapping
    (let [overlaps (find-overlapping-tokens db layer-id doc-id new-begin new-end
                                            :exclude-id eid)]
      (when (seq overlaps)
        (throw (ex-info "Updated token would overlap with existing token(s)"
                        {:code 409 :overlapping-ids (mapv :token/id overlaps)}))))
    :partitioning
    (throw (ex-info "Direct extent changes are not allowed on partitioning layers. Use shift-boundary endpoint."
                    {:code 400}))))

(defn- check-delete-overlap! [overlap-mode]
  (case overlap-mode
    :any nil
    :non-overlapping nil
    :partitioning
    (throw (ex-info "Single token deletion is not allowed on partitioning layers. Use merge-tokens endpoint."
                    {:code 400}))))

(defn- count-tokens-in-layer-doc
  "Count of tokens (layer, doc). Cheaper than fetching everything when
  the bulk-delete partition check just needs to compare totals."
  [db layer-id doc-id]
  (or (:c (psc/q1 db {:select [[[:count :*] :c]]
                      :from :tokens
                      :where [:and
                              [:= :token_layer_id layer-id]
                              [:= :document_id doc-id]]}))
      0))

(defn- token-ids-in-layer-doc
  [db layer-id doc-id]
  (->> (psc/q db {:select [:id]
                  :from :tokens
                  :where [:and
                          [:= :token_layer_id layer-id]
                          [:= :document_id doc-id]]})
       (mapv :id)))

(defn- check-bulk-delete-overlap! [overlap-mode db layer-id doc-id eids]
  (case overlap-mode
    :any nil
    :non-overlapping nil
    :partitioning
    ;; Partitioning bulk-delete is all-or-nothing: deleting a subset
    ;; would leave a partial cover, which is not a valid partition.
    (let [total (count-tokens-in-layer-doc db layer-id doc-id)
          requested (count eids)]
      (when-not (= total requested)
        (let [all-ids (set (token-ids-in-layer-doc db layer-id doc-id))]
          (when-not (= all-ids (set eids))
            (throw (ex-info "Partial deletion not allowed on partitioning layers. Delete all tokens or use merge-tokens."
                            {:code 400
                             :total-tokens total
                             :deleting requested}))))))))

(defn- check-bulk-create-overlap! [overlap-mode db layer-id doc-id tokens text-length]
  (case overlap-mode
    :any nil
    :non-overlapping
    (do
      (check-no-intra-batch-overlaps! tokens)
      (doseq [t tokens]
        (let [overlaps (find-overlapping-tokens db layer-id doc-id
                                                (:token/begin t) (:token/end t))]
          (when (seq overlaps)
            (throw (ex-info "Bulk-created token overlaps with existing token(s)"
                            {:code 409
                             :begin (:token/begin t)
                             :end (:token/end t)
                             :overlapping-ids (mapv :token/id overlaps)}))))))
    :partitioning
    (do
      (let [existing (count-tokens-in-layer-doc db layer-id doc-id)]
        (when (pos? existing)
          (throw (ex-info "Partitioning layer already has tokens for this document. Cannot bulk-create."
                          {:code 409 :existing-count existing}))))
      (validate-partition! tokens text-length))))

;; ---------------------------------------------------------------------------
;; Op-specific overlap enforcement
;; ---------------------------------------------------------------------------

(defn- enforce-overlap-create [db ctx]
  (let [{:keys [layer doc-id begin end]} ctx]
    (check-create-overlap! (layer-overlap-mode db layer) db layer doc-id begin end)))

(defn- enforce-overlap-update [db ctx]
  (let [{:keys [layer doc-id eid new-begin new-end extents-changing?]} ctx]
    (when extents-changing?
      (check-update-overlap! (layer-overlap-mode db layer) db layer doc-id eid new-begin new-end))))

(defn- enforce-overlap-delete [db ctx]
  (when-let [layer (:layer ctx)]
    (check-delete-overlap! (layer-overlap-mode db layer))))

(defn- enforce-overlap-bulk-create [db ctx]
  (let [{:keys [layer doc-id text-length records]} ctx]
    (check-bulk-create-overlap! (layer-overlap-mode db layer) db layer doc-id records text-length)))

(defn- enforce-overlap-bulk-delete [db ctx]
  ;; The partitioning all-or-nothing check is a pre-cascade-only rule:
  ;; once multi-delete! has run, the layer's token count has already
  ;; dropped to zero and re-firing this check would either misfire or
  ;; (more practically) just confuse the intent. Guard with :phase.
  ;;
  ;; Grouping is by [layer doc] tuple: a partitioning layer spans
  ;; documents, and the all-or-nothing check has to compare each
  ;; (layer, doc) pair's token count against the eids requested for
  ;; THAT pair. Grouping by layer alone would pick one doc's count and
  ;; treat the other doc's eids as if they were requested for the
  ;; chosen doc — counts misfire either way.
  (when (not= :post (:phase ctx))
    (doseq [[[layer-id doc-id] tokens] (:tokens-by-layer-doc ctx)]
      (check-bulk-delete-overlap! (layer-overlap-mode db layer-id) db layer-id
                                  doc-id
                                  (mapv :token/id tokens)))))

(defn- enforce-overlap-merge
  "Merge-tokens: union the extents of t1 and t2. For :non-overlapping
  the merged extent must not overlap anything else; for :partitioning
  the two must be adjacent (so coverage is preserved)."
  [db ctx]
  (let [{:keys [layer doc-id t1 t2]} ctx
        overlap-mode (layer-overlap-mode db layer)
        [left right] (if (<= (:token/begin t1) (:token/begin t2)) [t1 t2] [t2 t1])
        merged-begin (min (:token/begin t1) (:token/begin t2))
        merged-end (max (:token/end t1) (:token/end t2))]
    (case overlap-mode
      :any nil
      :non-overlapping
      (let [overlaps (find-overlapping-tokens db layer doc-id merged-begin merged-end
                                              :exclude-id (:token/id t1))
            ;; t2 always shows up as overlapping — exclude it too
            other-overlaps (remove #(= (:token/id %) (:token/id t2)) overlaps)]
        (when (seq other-overlaps)
          (throw (ex-info "Merged token would overlap with existing token(s)"
                          {:code 409 :overlapping-ids (mapv :token/id other-overlaps)}))))
      :partitioning
      (when (not= (:token/end left) (:token/begin right))
        (throw (ex-info "Tokens must be adjacent for merge on partitioning layers"
                        {:code 400
                         :left-end (:token/end left)
                         :right-begin (:token/begin right)}))))))

(defn neighbor-left
  "Return the (light-shape) token in (layer, doc) whose end_ == `b` and
  whose id is not `exclude-id`, or nil.

  Task #115: when more than one neighbor candidate is possible
  (same-boundary overlaps on an `:any` layer), pick deterministically
  using the same ordering containing-parent uses — tightest extent first
  (begin DESC, end_ ASC), then `precedence` (ASC NULLS LAST) as the
  load-bearing tiebreaker promised by #101, then id."
  [db layer doc-id b exclude-id]
  (-> (psc/q1 db {:select [:id :token_layer_id :document_id :begin :end_ :precedence]
                  :from :tokens
                  :where [:and
                          [:= :token_layer_id layer]
                          [:= :document_id doc-id]
                          [:= :end_ b]
                          [:<> :id exclude-id]]
                  :order-by [[:begin :desc]
                             [:end_ :asc]
                             [:precedence :asc-nulls-last]
                             [:id :asc]]
                  :limit 1})
      token-row->light))

(defn neighbor-right
  "Return the (light-shape) token in (layer, doc) whose begin == `e` and
  whose id is not `exclude-id`, or nil.

  Same deterministic ordering as `neighbor-left` — see its docstring for
  the rationale (task #115)."
  [db layer doc-id e exclude-id]
  (-> (psc/q1 db {:select [:id :token_layer_id :document_id :begin :end_ :precedence]
                  :from :tokens
                  :where [:and
                          [:= :token_layer_id layer]
                          [:= :document_id doc-id]
                          [:= :begin e]
                          [:<> :id exclude-id]]
                  :order-by [[:begin :desc]
                             [:end_ :asc]
                             [:precedence :asc-nulls-last]
                             [:id :asc]]
                  :limit 1})
      token-row->light))

(defn prepare-shift!
  "Pre-cascade validator for a shift-boundary. Three behaviors keyed
  on the layer's overlap-mode:

    :any              — returns [].
    :non-overlapping  — validates the new extent doesn't overlap any
                        other token in the layer; throws 409 if it
                        does. Returns [].
    :partitioning     — validates the moved boundary stays strictly
                        inside the neighbor's extent, AND returns
                        the neighbor adjustments
                        [{:id <token-id> :attrs {:begin … | :end_ …}} …]
                        the caller should apply in the same tx so
                        the partition coverage stays intact.

  ctx required keys: :layer :doc-id :token-id :begin :end :new-begin
  :new-end :text-length.

  Called separately from enforce! because the partitioning case
  produces neighbor writes that must run BEFORE the descendant resize
  cascade, while enforce! is a post-cascade orphan/containment guard."
  [tx ctx]
  (let [{:keys [layer doc-id token-id begin end new-begin new-end text-length]} ctx
        overlap-mode (layer-overlap-mode tx layer)]
    (case overlap-mode
      :any []

      :non-overlapping
      (do
        (let [overlaps (find-overlapping-tokens tx layer doc-id new-begin new-end
                                                :exclude-id token-id)]
          (when (seq overlaps)
            (throw (ex-info "Shifted boundary would create overlap"
                            {:code 409 :overlapping-ids (mapv :token/id overlaps)}))))
        [])

      :partitioning
      (do
        (when (>= new-begin new-end)
          (throw (ex-info "Shift would make the token zero-width, which is not allowed on partitioning layers"
                          {:code 400 :new-begin new-begin :new-end new-end})))
        (cond-> []
          (not= new-begin begin)
          (into (let [neighbor (neighbor-left tx layer doc-id begin token-id)]
                  (if neighbor
                    (do
                      (when (>= (:token/begin neighbor) new-begin)
                        (throw (ex-info (str "Shift would collapse or invert the adjacent token; a partitioning"
                                             " boundary may only move within the neighbor's extent")
                                        {:code 400 :new-begin new-begin
                                         :neighbor-begin (:token/begin neighbor)})))
                      [{:id (:token/id neighbor) :attrs {:end_ new-begin}}])
                    (when (not= new-begin 0)
                      (throw (ex-info "Cannot shift begin: no adjacent token found and new begin is not 0"
                                      {:code 400 :new-begin new-begin}))))))
          (not= new-end end)
          (into (let [neighbor (neighbor-right tx layer doc-id end token-id)]
                  (if neighbor
                    (do
                      (when (<= (:token/end neighbor) new-end)
                        (throw (ex-info (str "Shift would collapse or invert the adjacent token; a partitioning"
                                             " boundary may only move within the neighbor's extent")
                                        {:code 400 :new-end new-end
                                         :neighbor-end (:token/end neighbor)})))
                      [{:id (:token/id neighbor) :attrs {:begin new-end}}])
                    (when (not= new-end text-length)
                      (throw (ex-info "Cannot shift end: no adjacent token found and new end is not text length"
                                      {:code 400 :new-end new-end :text-length text-length})))))))))))

;; ---------------------------------------------------------------------------
;; Nesting enforcement (axis 2): child tokens must sit inside a parent
;; ---------------------------------------------------------------------------

(defn- enforce-nesting!
  "If the operated layer has a parent token layer, validate that every
  new/changed child token in `records` (each {:token/layer …
  :token/begin … :token/end …}) sits inside some token in the parent
  layer (same document). Only create/update/bulk-create/merge/shift can
  introduce or move a child — delete/bulk-delete/split never break
  containment, so they no-op.

  Zero-width tokens are forbidden on nested layers (containment would
  be ambiguous at a shared parent boundary)."
  [tx op ctx records]
  (let [layer (:layer ctx)]
    (when (and layer
               (contains? #{:create :update :bulk-create :merge :shift} op))
      (when-let [parent-layer (layer-parent tx layer)]
        (let [doc-id (:doc-id ctx)
              child-records (filter #(= layer (:token/layer %)) records)
              ;; Batch the parent lookup when checking >1 child.
              parents (when (> (count child-records) 1)
                        (parent-tokens-for-doc tx parent-layer doc-id))
              resolve-parent (fn [b e]
                               (if parents
                                 (containing-parent-in-memory parents b e)
                                 (containing-parent tx parent-layer doc-id b e)))]
          (doseq [rec child-records]
            (let [b (:token/begin rec) e (:token/end rec)]
              (when (= b e)
                (throw (ex-info "Zero-width tokens are not allowed on nested token layers"
                                {:code 400 :begin b :end e :layer layer})))
              (when (nil? (resolve-parent b e))
                (throw (ex-info "Token is not contained within any parent-layer token"
                                {:code 400 :begin b :end e :parent-layer parent-layer}))))))))))

;; ---------------------------------------------------------------------------
;; Parent-side guard (axis 2, reverse): structural ops on a parent token
;; that would orphan a nested child-layer token are rejected unless the
;; caller has already removed/resized the children.
;;
;; The token.clj cascades make the affected descendants conform BEFORE
;; calling enforce!, so by the time we run, the post-cascade state in
;; the tx is what we evaluate. We check the actual tx state — that's
;; the SQL equivalent of v2's "ASSERT NOT EXISTS after the cascade".
;; ---------------------------------------------------------------------------

(defn- assert-no-descendants-in-extent!
  "Throw if any descendant-layer token (same doc) still sits inside
  [lo, hi). Called after a delete cascade has run inside the tx."
  [tx dlids doc-id lo hi]
  (when (seq dlids)
    (let [orphans (descendant-tokens-in-extent tx dlids doc-id lo hi)]
      (when (seq orphans)
        (throw (ex-info (str "Cannot perform structural op: " (count orphans)
                             " descendant-layer token(s) would be orphaned.")
                        {:code 409
                         :orphan-ids (mapv :token/id orphans)}))))))

(defn- assert-no-straddler-at!
  "Throw if any descendant-layer token still straddles position `p`."
  [tx dlids doc-id p]
  (when (seq dlids)
    (let [orphans (straddling-descendant-tokens-at tx dlids doc-id p)]
      (when (seq orphans)
        (throw (ex-info (str "Cannot split: " (count orphans)
                             " descendant-layer token(s) still straddle the split position.")
                        {:code 409
                         :orphan-ids (mapv :token/id orphans)
                         :position p}))))))

(defn- assert-no-out-of-bounds-in!
  "Throw if any descendant-layer token within [b, e) falls outside
  [nb, ne) — called after a shift/update resize cascade has trimmed or
  deleted children that would otherwise be orphaned."
  [tx dlids doc-id b e nb ne]
  (when (seq dlids)
    (let [rows (psc/q tx {:select [:id :token_layer_id :document_id :begin :end_]
                          :from :tokens
                          :where (conj (descendant-token-where dlids doc-id)
                                       [:>= :begin b]
                                       [:<= :end_ e]
                                       [:or
                                        [:< :begin nb]
                                        [:> :end_ ne]])})]
      (when (seq rows)
        (throw (ex-info (str "Cannot resize: " (count rows)
                             " descendant-layer token(s) still fall outside the new extent.")
                        {:code 409
                         :orphan-ids (mapv :id rows)}))))))

(defn- enforce-parent-guard!
  "Post-cascade orphan check. Each branch trusts the caller has already
  performed the structural cascade for its op (delete-cascade,
  split-straddlers, resize-trim/delete) and verifies the post-state."
  [tx op ctx]
  (case op
    :delete
    (let [{:keys [layer doc-id begin end dlids]} ctx]
      (when layer
        (assert-no-descendants-in-extent! tx dlids doc-id begin end)))

    :bulk-delete
    ;; Mirror enforce-overlap-bulk-delete's phase guard: the orphan
    ;; guard is a post-cascade rule. Skip when the caller is doing the
    ;; pre-cascade partitioning check (phase=:pre and dlids-by-layer
    ;; empty). With phase=:post the caller passes the real
    ;; dlids-by-layer plus tokens-by-layer-doc (we need the original
    ;; pre-cascade extents to know which regions to check).
    ;;
    ;; Grouping key is [layer doc] (same reason as
    ;; enforce-overlap-bulk-delete) so the doc-id is read from the
    ;; tuple, not from a representative token. dlids are layer-keyed:
    ;; descendant-layer membership is a function of the layer alone.
    (when (not= :pre (:phase ctx))
      (doseq [[[layer-id doc-id] tokens] (:tokens-by-layer-doc ctx)]
        (let [dlids (clojure.core/get (:dlids-by-layer ctx) layer-id)]
          (doseq [t tokens]
            (assert-no-descendants-in-extent! tx dlids doc-id
                                              (:token/begin t) (:token/end t))))))

    :split
    (let [{:keys [doc-id position dlids]} ctx]
      (assert-no-straddler-at! tx dlids doc-id position))

    (:shift :update)
    (let [{:keys [layer doc-id begin end new-begin new-end extents-changing? dlids]} ctx]
      (when (and layer
                 (not (false? extents-changing?))
                 (seq dlids))
        (if (= :partitioning (layer-overlap-mode tx layer))
          ;; Straddlers were split at each moved boundary → assert none remain.
          (doseq [p (cond-> []
                      (not= new-begin begin) (conj new-begin)
                      (not= new-end end) (conj new-end))]
            (assert-no-straddler-at! tx dlids doc-id p))
          ;; Trim/delete cascade: assert no descendant in [begin,end] falls outside [nb,ne].
          (assert-no-out-of-bounds-in! tx dlids doc-id begin end new-begin new-end))))

    nil))

;; ---------------------------------------------------------------------------
;; Single entry point
;; ---------------------------------------------------------------------------

(def ^:private required-ctx-keys
  "ctx keys each op must supply to enforce!. Checked for PRESENCE (not
  non-nil — some values are legitimately nil, e.g. a delete-cascade on
  a missing token leaves :layer/:begin/:end as nil) so a producer that
  forgets a key fails loudly. Keep in sync with the call sites in
  plaid.sql.token."
  {:create      [:layer :doc-id :begin :end]
   :update      [:layer :doc-id :eid :begin :end :new-begin :new-end :extents-changing?]
   :delete      [:layer :doc-id :begin :end]
   :bulk-create [:layer :doc-id :text-length :records]
   :bulk-delete [:tokens-by-layer-doc]
   :split       [:layer :doc-id :begin :end :position]
   :merge       [:layer :doc-id :t1 :t2]
   :shift       [:layer :doc-id :token-id :begin :end :new-begin :new-end :text-length]})

(defn- check-ctx-present!
  [op ctx]
  (doseq [k (clojure.core/get required-ctx-keys op)]
    (when-not (contains? ctx k)
      (throw (ex-info (str "Internal error: constraint ctx missing key " k " for op " op)
                      {:op op :missing-key k :code 500})))))

(defn- enforce-overlap! [tx op ctx]
  (case op
    :create      (enforce-overlap-create tx ctx)
    :update      (enforce-overlap-update tx ctx)
    :delete      (enforce-overlap-delete tx ctx)
    :bulk-create (enforce-overlap-bulk-create tx ctx)
    :bulk-delete (enforce-overlap-bulk-delete tx ctx)
    :merge       (enforce-overlap-merge tx ctx)
    ;; :shift's overlap check is the prepare-shift! call the caller
    ;; runs BEFORE the descendant cascade — by the time we reach
    ;; enforce! the new boundary and any partitioning neighbor
    ;; adjustments are already in the tx state, so re-running the
    ;; overlap check here would double-fire (and on partitioning
    ;; could fail spuriously). Skip.
    :shift       nil
    :split       nil))

(defn enforce!
  "Run constraint enforcement for a token op and throw ex-info on
  violation. `tx` is the open SQL transaction (per-row writes from
  plaid.sql.token live in it); `op-kw` is the op keyword (see
  required-ctx-keys); `ctx` carries op-specific fields.

  Composes:
    1. overlap-mode (per-layer) — except for :shift, see prepare-shift!
    2. nesting containment (parent-layer must contain each new/changed child)
    3. parent-side orphan guard (no surviving descendant in the affected
       region after the caller's cascade)

  Call ordering for the structural ops:

    :create / :bulk-create   — call enforce! BEFORE the insert.
    :update (extent change)  — run resize-child-cascade!, apply the
                                parent update, THEN enforce!.
    :delete / :bulk-delete   — run multi-delete! over the parent +
                                its nested descendants, THEN enforce!.
    :split                   — split the parent + cascade to
                                straddling descendants, THEN enforce!.
    :merge                   — call enforce! BEFORE the structural
                                writes (adjacency/overlap is decided
                                against the pre-state).
    :shift                   — call prepare-shift! first to get any
                                partitioning neighbor adjustments;
                                apply them + the cascade + the
                                parent boundary update; THEN
                                enforce! against the post-state.

  Returns nil on success; throws ex-info with :code 400/409 on
  violation."
  [tx op-kw ctx]
  (check-ctx-present! op-kw ctx)
  (enforce-overlap! tx op-kw ctx)
  (enforce-nesting! tx op-kw ctx (clojure.core/get ctx :records []))
  (enforce-parent-guard! tx op-kw ctx)
  nil)
