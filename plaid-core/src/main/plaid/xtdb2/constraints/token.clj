(ns plaid.xtdb2.constraints.token
  "Token constraint checking and compensation logic.
  Enforces overlap-mode invariants (:any, :non-overlapping, :partitioning)
  on token CRUD operations.

  `enforce` is the single entry point: token `-operation` fns build pure base
  tx-ops via their `*` fns, then call `enforce` once to run pre-flight checks and
  append TOCTOU-safety ops. All overlap-mode interpretation lives here, not in
  token.clj. `compensate-after-cascade` is the one other public fn, used by the
  text-body-edit cascade."
  (:require [xtdb.api :as xt]
            [clojure.string :as str]
            [plaid.xtdb2.common :as pxc]))

;; ---------------------------------------------------------------------------
;; Helpers
;; ---------------------------------------------------------------------------

(defn- layer-overlap-mode [node layer-id]
  (or (:token-layer/overlap-mode (pxc/entity node :token-layers layer-id)) :any))

(defn- layer-parent
  "The parent token-layer id of layer-id, or nil for a root (flat) layer."
  [node layer-id]
  (:token-layer/parent-token-layer (pxc/entity node :token-layers layer-id)))

(defn- containing-parent
  "The parent-layer token (same doc, with :xt/system-from) whose extent contains
  [begin, end), or nil. Containment is inclusive: a child equal to its parent's
  extent counts as contained."
  [node parent-layer-id doc-id begin end]
  (first (xt/q node [(str "SELECT *, _system_from FROM tokens"
                          " WHERE token$layer = ? AND token$document = ?"
                          " AND token$begin <= ? AND token$end >= ?")
                     parent-layer-id doc-id begin end])))

(defn- child-layer-ids
  "Token-layer ids that declare layer-id as their parent (the reverse of
  layer-parent)."
  [node layer-id]
  (->> (xt/q node ["SELECT _id FROM token_layers WHERE token_layer$parent_token_layer = ?" layer-id])
       (mapv :xt/id)))

(defn- children-in-extent
  "Tokens (with :xt/system-from) in any child layer of layer-id, in the same doc,
  fully within [lo, hi). Empty when layer-id has no child layers."
  [node layer-id doc-id lo hi]
  (let [clids (child-layer-ids node layer-id)]
    (if (empty? clids)
      []
      (let [ph (str/join ", " (repeat (count clids) "?"))]
        (xt/q node (into [(str "SELECT *, _system_from FROM tokens"
                               " WHERE token$layer IN (" ph ") AND token$document = ?"
                               " AND token$begin >= ? AND token$end <= ?")]
                         (concat clids [doc-id lo hi])))))))

(defn- no-children-assert-sql
  "ASSERT NOT EXISTS a child-layer token within [lo, hi) — TOCTOU guard for parent
  structural ops (a concurrent child create inside the affected region has no row
  to match*, so we assert it away)."
  [child-layer-ids doc-id lo hi]
  (let [ph (str/join ", " (repeat (count child-layer-ids) "?"))]
    [:sql (str "ASSERT NOT EXISTS (SELECT 1 FROM tokens"
               " WHERE token$layer IN (" ph ") AND token$document = ?"
               " AND token$begin >= ? AND token$end <= ?)")
     (into (vec child-layer-ids) [doc-id lo hi])]))

(defn- guard-parent-extent
  "Phase-1 reject-don't-cascade guard: if layer-id has child layers and any child
  currently sits in [lo, hi), reject the op (clear child tokens before
  re-segmenting the parent). Returns TOCTOU assert ops (empty if layer-id has no
  child layers)."
  [node layer-id doc-id lo hi]
  (let [clids (child-layer-ids node layer-id)]
    (if (empty? clids)
      []
      (do
        (when (seq (children-in-extent node layer-id doc-id lo hi))
          (throw (ex-info (str "Cannot modify this token: it has child-layer tokens nested within it. "
                               "Clear the child tokens first.")
                          {:code 400 :layer layer-id :begin lo :end hi})))
        [(no-children-assert-sql clids doc-id lo hi)]))))

(defn- put-token-records
  "Token records from the :put-docs :tokens ops in a tx-op vector."
  [tx-ops]
  (keep (fn [op]
          (when (and (vector? op) (= :put-docs (first op)) (= :tokens (second op)))
            (nth op 2)))
        tx-ops))

(defn- first-put-token-id [tx-ops]
  (:xt/id (first (put-token-records tx-ops))))

;; ---------------------------------------------------------------------------
;; Overlap queries
;; ---------------------------------------------------------------------------

(defn find-overlapping-tokens
  "Find tokens in the same layer+document that overlap with [begin, end),
  optionally excluding a specific token ID.
  Two tokens overlap when t.begin < end AND t.end > begin."
  [node layer-id doc-id begin end & {:keys [exclude-id]}]
  (let [base-sql (str "SELECT *, _system_from FROM tokens"
                      " WHERE token$layer = ? AND token$document = ?"
                      " AND token$begin < ? AND token$end > ?"
                      (when exclude-id " AND _id <> ?"))
        params (cond-> [layer-id doc-id end begin]
                 exclude-id (conj exclude-id))]
    (xt/q node (into [base-sql] params))))

(defn- overlap-assert-sql
  "Return a SQL ASSERT tx-op that ensures no overlapping tokens exist.
  Used inside transactions for TOCTOU safety."
  [layer-id doc-id begin end & {:keys [exclude-id]}]
  (if exclude-id
    [:sql (str "ASSERT NOT EXISTS ("
               "SELECT 1 FROM tokens"
               " WHERE token$layer = ? AND token$document = ?"
               " AND token$begin < ? AND token$end > ?"
               " AND _id <> ?)")
     [layer-id doc-id end begin exclude-id]]
    [:sql (str "ASSERT NOT EXISTS ("
               "SELECT 1 FROM tokens"
               " WHERE token$layer = ? AND token$document = ?"
               " AND token$begin < ? AND token$end > ?)")
     [layer-id doc-id end begin]]))

(defn- create-overlap-asserts
  "Return SQL ASSERT tx-ops for a token creation/extent-change, based on overlap
  mode. For :non-overlapping and :partitioning, returns an ASSERT NOT EXISTS that
  prevents concurrent overlap creation (TOCTOU safety)."
  [overlap-mode layer-id doc-id begin end & {:keys [exclude-id]}]
  (case overlap-mode
    :any []
    (:non-overlapping :partitioning)
    [(overlap-assert-sql layer-id doc-id begin end :exclude-id exclude-id)]))

(defn- partition-establish-assert-sql
  "ASSERT tx-op ensuring the ONLY tokens in layer+doc (optionally restricted to
  the range [lo, hi)) are the ones being inserted (inserted-ids). XTDB evaluates
  ASSERTs against the in-tx state including this tx's own put-docs, so we exclude
  the inserted ids and assert nothing else exists. This makes partitioning
  bulk-create safe against a concurrent establishment that committed first (the
  pre-flight emptiness read is not enough on its own — see operation-coordinator:
  regular ops are not serialized against each other). For a nested partitioning
  layer, pass :lo/:hi = the parent token's extent so the assert is scoped to that
  parent."
  [layer-id doc-id inserted-ids & {:keys [lo hi]}]
  (let [range? (and (some? lo) (some? hi))
        range-clause (when range? " AND token$begin >= ? AND token$end <= ?")
        range-params (when range? [lo hi])
        ids? (seq inserted-ids)
        id-clause (when ids?
                    (str " AND _id NOT IN (" (str/join ", " (repeat (count inserted-ids) "?")) ")"))]
    [:sql (str "ASSERT NOT EXISTS (SELECT 1 FROM tokens"
               " WHERE token$layer = ? AND token$document = ?"
               range-clause id-clause ")")
     (into (into [layer-id doc-id] range-params) (when ids? inserted-ids))]))

;; ---------------------------------------------------------------------------
;; Partition validation
;; ---------------------------------------------------------------------------

(defn validate-partition-range!
  "Validate that tokens form a complete, gap-free, overlap-free partition of
  [lo, hi). Throws on violation. The scope is [0, text-length) for a root
  partitioning layer, or a parent token's [begin, end) for a nested one."
  [tokens lo hi]
  (if (empty? tokens)
    (when (> hi lo)
      (throw (ex-info "Partitioning requires tokens covering the entire extent"
                      {:code 400 :lo lo :hi hi})))
    (let [sorted (sort-by :token/begin tokens)]
      (when (not= lo (:token/begin (first sorted)))
        (throw (ex-info "Partition must start at the extent's begin"
                        {:code 400 :expected-begin lo :actual-begin (:token/begin (first sorted))})))
      (when (not= hi (:token/end (last sorted)))
        (throw (ex-info "Partition must end at the extent's end"
                        {:code 400 :expected-end hi :actual-end (:token/end (last sorted))})))
      ;; Contiguous (no gaps, no overlaps)
      (doseq [[a b] (partition 2 1 sorted)]
        (when (not= (:token/end a) (:token/begin b))
          (throw (ex-info "Partition requires contiguous tokens (no gaps or overlaps)"
                          {:code 400
                           :token-a-end (:token/end a)
                           :token-b-begin (:token/begin b)}))))
      ;; No zero-width tokens
      (doseq [t sorted]
        (when (= (:token/begin t) (:token/end t))
          (throw (ex-info "Zero-width tokens are not allowed in partitioning mode"
                          {:code 400 :token-id (:xt/id t)})))))))

(defn validate-partition!
  "Validate that tokens partition [0, text-length). See validate-partition-range!."
  [tokens text-length]
  (validate-partition-range! tokens 0 text-length))

(defn- check-no-intra-batch-overlaps!
  "Validate that tokens within a batch don't overlap each other."
  [tokens]
  (let [sorted (sort-by :token/begin tokens)]
    (doseq [[a b] (partition 2 1 sorted)]
      (when (> (:token/end a) (:token/begin b))
        (throw (ex-info "Tokens in batch overlap each other"
                        {:code 400
                         :token-a-end (:token/end a)
                         :token-b-begin (:token/begin b)}))))))

;; ---------------------------------------------------------------------------
;; Pre-flight checks (UX layer — good error messages; safety comes from asserts)
;; ---------------------------------------------------------------------------

(defn- check-create! [overlap-mode node layer-id doc-id begin end]
  (case overlap-mode
    :any nil
    :non-overlapping
    (let [overlaps (find-overlapping-tokens node layer-id doc-id begin end)]
      (when (seq overlaps)
        (throw (ex-info "Token overlaps with existing token(s) in non-overlapping layer"
                        {:code 409 :overlapping-ids (mapv :xt/id overlaps)}))))
    :partitioning
    (throw (ex-info "Single token creation is not allowed on partitioning layers. Use bulk-create to establish a partition."
                    {:code 400}))))

(defn- check-update! [overlap-mode node layer-id doc-id token-id new-begin new-end]
  (case overlap-mode
    :any nil
    :non-overlapping
    (let [overlaps (find-overlapping-tokens node layer-id doc-id new-begin new-end
                                            :exclude-id token-id)]
      (when (seq overlaps)
        (throw (ex-info "Updated token would overlap with existing token(s)"
                        {:code 409 :overlapping-ids (mapv :xt/id overlaps)}))))
    :partitioning
    (throw (ex-info "Direct extent changes are not allowed on partitioning layers. Use shift-boundary endpoint."
                    {:code 400}))))

(defn- check-delete! [overlap-mode]
  (case overlap-mode
    :any nil
    :non-overlapping nil
    :partitioning
    (throw (ex-info "Single token deletion is not allowed on partitioning layers. Use merge-tokens endpoint."
                    {:code 400}))))

(defn- check-bulk-delete! [overlap-mode node layer-id doc-id eids]
  (case overlap-mode
    :any nil
    :non-overlapping nil
    :partitioning
    (let [all-tokens (pxc/find-entities node :tokens {:token/layer layer-id :token/document doc-id})
          all-ids (set (map :xt/id all-tokens))]
      (when-not (= all-ids (set eids))
        (throw (ex-info "Partial deletion not allowed on partitioning layers. Delete all tokens or use merge-tokens."
                        {:code 400
                         :total-tokens (count all-ids)
                         :deleting (count eids)}))))))

(defn- check-bulk-create! [overlap-mode node layer-id doc-id tokens text-length]
  (case overlap-mode
    :any nil
    :non-overlapping
    (do
      (check-no-intra-batch-overlaps! tokens)
      (doseq [t tokens]
        (let [overlaps (find-overlapping-tokens node layer-id doc-id
                                                (:token/begin t) (:token/end t))]
          (when (seq overlaps)
            (throw (ex-info "Bulk-created token overlaps with existing token(s)"
                            {:code 409
                             :begin (:token/begin t)
                             :end (:token/end t)
                             :overlapping-ids (mapv :xt/id overlaps)}))))))
    :partitioning
    (do
      (let [existing (pxc/find-entities node :tokens {:token/layer layer-id :token/document doc-id})]
        (when (seq existing)
          (throw (ex-info "Partitioning layer already has tokens for this document. Cannot bulk-create."
                          {:code 409 :existing-count (count existing)}))))
      (validate-partition! tokens text-length))))

;; ---------------------------------------------------------------------------
;; Op-specific enforcement (merge & shift carry more than overlap asserts)
;; ---------------------------------------------------------------------------

(defn- enforce-merge
  "Pre-check + assert the merged extent. Merge deletes the right token and grows
  the left (surviving) one to span both. For partitioning, the two must be
  adjacent; coverage is preserved because both originals are match*ed by the
  base ops."
  [node {:keys [layer doc-id t1 t2 surviving-id]} base-ops]
  (let [overlap-mode (layer-overlap-mode node layer)
        [left right] (if (<= (:token/begin t1) (:token/begin t2)) [t1 t2] [t2 t1])
        merged-begin (min (:token/begin t1) (:token/begin t2))
        merged-end (max (:token/end t1) (:token/end t2))]
    (case overlap-mode
      :any nil
      :non-overlapping
      (let [overlaps (find-overlapping-tokens node layer doc-id merged-begin merged-end
                                              :exclude-id (:xt/id t1))
            ;; t2 always shows up as overlapping — exclude it too
            other-overlaps (remove #(= (:xt/id %) (:xt/id t2)) overlaps)]
        (when (seq other-overlaps)
          (throw (ex-info "Merged token would overlap with existing token(s)"
                          {:code 409 :overlapping-ids (mapv :xt/id other-overlaps)}))))
      :partitioning
      (when (not= (:token/end left) (:token/begin right))
        (throw (ex-info "Tokens must be adjacent for merge on partitioning layers"
                        {:code 400
                         :left-end (:token/end left)
                         :right-begin (:token/begin right)}))))
    (into (vec base-ops)
          (create-overlap-asserts overlap-mode layer doc-id merged-begin merged-end
                                  :exclude-id surviving-id))))

(defn- enforce-shift
  "Pre-check + augment a boundary shift. For :non-overlapping, validate + assert
  no overlap. For :partitioning, auto-adjust the adjacent token so coverage is
  preserved; every boundary change touches BOTH adjacent tokens (each match*ed),
  so concurrent shifts on a shared boundary conflict and one rolls back."
  [node {:keys [layer doc-id token-id begin end new-begin new-end text-length]} base-ops]
  (let [overlap-mode (layer-overlap-mode node layer)
        constraint-ops
        (case overlap-mode
          :any []

          :non-overlapping
          (do
            (let [overlaps (find-overlapping-tokens node layer doc-id new-begin new-end
                                                    :exclude-id token-id)]
              (when (seq overlaps)
                (throw (ex-info "Shifted boundary would create overlap"
                                {:code 409 :overlapping-ids (mapv :xt/id overlaps)}))))
            (create-overlap-asserts :non-overlapping layer doc-id new-begin new-end
                                    :exclude-id token-id))

          :partitioning
          (cond-> []
            ;; If begin changed, find the token whose end == old begin and adjust it
            (not= new-begin begin)
            (into (let [left-neighbors (xt/q node
                                             [(str "SELECT *, _system_from FROM tokens"
                                                   " WHERE token$layer = ? AND token$document = ?"
                                                   " AND token$end = ? AND _id <> ?")
                                              layer doc-id begin token-id])]
                    (if-let [neighbor (first left-neighbors)]
                      [(pxc/match* :tokens neighbor)
                       [:put-docs :tokens (-> neighbor
                                              (pxc/strip-temporal)
                                              (assoc :token/end new-begin))]]
                      (when (not= new-begin 0)
                        (throw (ex-info "Cannot shift begin: no adjacent token found and new begin is not 0"
                                        {:code 400 :new-begin new-begin}))))))
            ;; If end changed, find the token whose begin == old end and adjust it
            (not= new-end end)
            (into (let [right-neighbors (xt/q node
                                              [(str "SELECT *, _system_from FROM tokens"
                                                    " WHERE token$layer = ? AND token$document = ?"
                                                    " AND token$begin = ? AND _id <> ?")
                                               layer doc-id end token-id])]
                    (if-let [neighbor (first right-neighbors)]
                      [(pxc/match* :tokens neighbor)
                       [:put-docs :tokens (-> neighbor
                                              (pxc/strip-temporal)
                                              (assoc :token/begin new-end))]]
                      (when (not= new-end text-length)
                        (throw (ex-info "Cannot shift end: no adjacent token found and new end is not text length"
                                        {:code 400 :new-end new-end :text-length text-length}))))))))]
    (into (vec base-ops) constraint-ops)))

;; ---------------------------------------------------------------------------
;; Single entry point
;; ---------------------------------------------------------------------------

(defn- enforce-overlap
  "Overlap-mode enforcement (axis 1). Returns base-ops augmented with overlap
  ASSERTs / shift neighbor ops. Nesting (axis 2) is layered on by enforce-nesting.

  ctx keys by op:
    :create       {:layer :doc-id :begin :end}
    :update       {:layer :doc-id :eid :new-begin :new-end :extents-changing?}
    :delete       {:layer}                       ; nil layer (missing token) → skip
    :bulk-create  {:layer :doc-id :text-length}  ; token records read from base-ops
    :bulk-delete  {:tokens-by-layer {layer-id [tokens]}}
    :merge        {:layer :doc-id :t1 :t2 :surviving-id}
    :shift        {:layer :doc-id :token-id :begin :end :new-begin :new-end :text-length}"
  [op node ctx base-ops]
  (case op
    :create
    (let [{:keys [layer doc-id begin end]} ctx
          overlap-mode (layer-overlap-mode node layer)]
      (check-create! overlap-mode node layer doc-id begin end)
      (into (vec base-ops)
            (create-overlap-asserts overlap-mode layer doc-id begin end
                                    :exclude-id (first-put-token-id base-ops))))

    :update
    (let [{:keys [layer doc-id eid new-begin new-end extents-changing?]} ctx
          overlap-mode (layer-overlap-mode node layer)]
      (if extents-changing?
        (do
          (check-update! overlap-mode node layer doc-id eid new-begin new-end)
          (into (vec base-ops)
                (create-overlap-asserts overlap-mode layer doc-id new-begin new-end
                                        :exclude-id eid)))
        (vec base-ops)))

    :delete
    (do
      (when-let [layer (:layer ctx)]
        (check-delete! (layer-overlap-mode node layer)))
      (vec base-ops))

    :bulk-create
    (let [{:keys [layer doc-id text-length]} ctx
          overlap-mode (layer-overlap-mode node layer)
          nested? (some? (layer-parent node layer))
          records (vec (put-token-records base-ops))]
      (case overlap-mode
        :non-overlapping
        (do
          (check-bulk-create! :non-overlapping node layer doc-id records text-length)
          (into (vec base-ops)
                (mapcat (fn [rec]
                          (create-overlap-asserts :non-overlapping layer doc-id
                                                  (:token/begin rec) (:token/end rec)
                                                  :exclude-id (:xt/id rec)))
                        records)))
        :partitioning
        (if nested?
          ;; Nested partitioning is validated per parent extent by enforce-nesting,
          ;; not against the whole text — skip the root partition checks here.
          (vec base-ops)
          (do
            (check-bulk-create! :partitioning node layer doc-id records text-length)
            (conj (vec base-ops)
                  (partition-establish-assert-sql layer doc-id (mapv :xt/id records)))))
        (vec base-ops)))

    :bulk-delete
    (do
      (doseq [[layer-id tokens] (:tokens-by-layer ctx)]
        (check-bulk-delete! (layer-overlap-mode node layer-id) node layer-id
                            (:token/document (first tokens)) (mapv :xt/id tokens)))
      (vec base-ops))

    :merge (enforce-merge node ctx base-ops)
    :shift (enforce-shift node ctx base-ops)
    ;; split has no overlap constraints (both halves stay within the original
    ;; extent); the parent-side guard runs in enforce-parent-guard
    :split (vec base-ops)))

;; ---------------------------------------------------------------------------
;; Nesting enforcement (axis 2): child tokens must be contained in a parent token
;; ---------------------------------------------------------------------------

(defn- enforce-nesting
  "If the operated layer declares a parent token layer, enforce containment:
  every new/changed child token in `ops` must sit inside some parent-layer token
  (same document). Each containing parent is match*ed so a concurrent parent
  delete/shrink rolls this tx back. For a nested :partitioning layer being
  established via bulk-create, the children must additionally tile each touched
  parent extent (validate + scoped establish ASSERT). Containment also makes
  cross-parent merge/shift impossible: a merged/shifted extent that escapes its
  parent has no containing token and is rejected.

  Only create/update/bulk-create/merge/shift can introduce/move a child; delete
  and bulk-delete never break containment, so they are passed through."
  [op node ctx ops]
  (let [layer (:layer ctx)
        parent-layer (when layer (layer-parent node layer))]
    (if (or (nil? parent-layer)
            (not (contains? #{:create :update :bulk-create :merge :shift} op)))
      ops
      (let [doc-id (:doc-id ctx)
            child-records (filter #(= layer (:token/layer %)) (put-token-records ops))
            child+parent
            (mapv (fn [rec]
                    (let [b (:token/begin rec) e (:token/end rec)
                          p (containing-parent node parent-layer doc-id b e)]
                      (when (nil? p)
                        (throw (ex-info "Token is not contained within any parent-layer token"
                                        {:code 400 :begin b :end e :parent-layer parent-layer})))
                      [rec p]))
                  child-records)
            parent-match-ops (->> child+parent
                                  (reduce (fn [m [_ p]] (assoc m (:xt/id p) p)) {})
                                  vals
                                  (mapv #(pxc/match* :tokens %)))
            tiling-ops (if (and (= op :bulk-create)
                                (= :partitioning (layer-overlap-mode node layer)))
                         (->> (group-by (fn [[_ p]] (:xt/id p)) child+parent)
                              (mapcat (fn [[_pid pairs]]
                                        (let [p (second (first pairs))
                                              recs (map first pairs)]
                                          (validate-partition-range! recs (:token/begin p) (:token/end p))
                                          [(partition-establish-assert-sql
                                            layer doc-id (mapv :xt/id recs)
                                            :lo (:token/begin p) :hi (:token/end p))])))
                              vec)
                         [])]
        (into (vec ops) (concat parent-match-ops tiling-ops))))))

;; ---------------------------------------------------------------------------
;; Parent-side guard (axis 2, reverse): structural ops on a token that has
;; child-layer tokens nested in it are rejected (phase 1: clear children first)
;; ---------------------------------------------------------------------------

(defn- enforce-parent-guard
  "Reject structural ops on a parent token that would orphan nested child-layer
  tokens. Phase 1 is reject-don't-cascade: if the operated/affected token sits in
  a layer that has child layers and any child currently nests within it, throw.
  Appends a TOCTOU ASSERT NOT EXISTS child-in-extent. No-op for layers with no
  child layers (so flat/leaf layers are unaffected).

  Needs ctx :doc-id and the affected extent: :begin/:end for
  :delete/:shift/:split, old :begin/:end for :update (extent change). :bulk-delete
  reads :tokens-by-layer."
  [op node ctx ops]
  (case op
    (:delete :split)
    (let [{:keys [layer doc-id begin end]} ctx]
      (if (and layer (some? begin) (some? end))
        (into (vec ops) (guard-parent-extent node layer doc-id begin end))
        (vec ops)))

    (:shift :update)
    (let [{:keys [layer doc-id begin end extents-changing?]} ctx]
      (if (and layer (some? begin) (some? end) (not (false? extents-changing?)))
        (into (vec ops) (guard-parent-extent node layer doc-id begin end))
        (vec ops)))

    :bulk-delete
    (into (vec ops)
          (mapcat (fn [[layer-id tokens]]
                    (let [doc-id (:token/document (first tokens))]
                      (mapcat (fn [t] (guard-parent-extent node layer-id doc-id
                                                           (:token/begin t) (:token/end t)))
                              tokens)))
                  (:tokens-by-layer ctx)))

    (vec ops)))

;; ---------------------------------------------------------------------------
;; Single entry point
;; ---------------------------------------------------------------------------

(defn enforce
  "Run constraint enforcement for a token op and return base-ops augmented with
  TOCTOU-safety ops. Composes three concerns: overlap-mode (within-layer), nesting
  containment (child must sit in a parent), and the parent-side guard (don't
  orphan children). Pre-flight checks throw ex-info with a :code on violation.
  This is the only place token-layer constraints are interpreted; the `*` fns are
  constraint-unaware. See enforce-overlap for ctx keys by op."
  [op node ctx base-ops]
  (->> (enforce-overlap op node ctx base-ops)
       (enforce-nesting op node ctx)
       (enforce-parent-guard op node ctx)))

;; ---------------------------------------------------------------------------
;; Cascade compensation
;; ---------------------------------------------------------------------------

(defn compensate-after-cascade
  "After a text body edit causes token deletions/resizing, produce additional
  tx-ops to maintain partitioning invariants.

  For partitioning layers, when tokens are deleted and gaps would appear,
  we extend adjacent tokens to fill the gaps.

  Arguments:
    node          - XTDB node
    new-tokens    - surviving tokens after cascade (with updated extents)
    deleted-ids   - set of token IDs that were deleted
    new-text-len  - length of the new text body
    tokens-sys-from - the pre-edit tokens with :xt/system-from (the caller already
                      fetched these; we index by :xt/id to build match* ops without
                      re-querying)

  Returns a vector of additional tx-ops (may be empty)."
  [node new-tokens deleted-ids new-text-len tokens-sys-from]
  (if (empty? deleted-ids)
    []
    ;; Group surviving tokens by layer
    (let [sys-from-by-id (into {} (map (juxt :xt/id identity)) tokens-sys-from)
          tokens-by-layer (group-by :token/layer new-tokens)]
      (vec
       (mapcat
        (fn [[layer-id layer-tokens]]
          (let [mode (layer-overlap-mode node layer-id)]
            ;; Only gap-fill ROOT partitioning layers against the whole text. A
            ;; nested partitioning layer (e.g. morphemes) tiles each parent token,
            ;; not [0, text-len); its tokens are resized consistently by the text
            ;; edit (every layer clips to the same body), preserving per-parent
            ;; tiling, so we must NOT fill it against the whole text here.
            (if (or (not= mode :partitioning)
                    (some? (layer-parent node layer-id)))
              []
              ;; For partitioning: check if the surviving tokens still form a partition
              ;; If text is now empty and no tokens survive, that's fine
              (if (and (zero? new-text-len) (empty? layer-tokens))
                []
                ;; If there are surviving tokens, fill gaps
                (let [sorted (sort-by :token/begin layer-tokens)
                      gap-fills
                      (concat
                       ;; Gap at start?
                       (when (and (seq sorted) (pos? (:token/begin (first sorted))))
                         (let [te (get sys-from-by-id (:xt/id (first sorted)))]
                           [(pxc/match* :tokens te)
                            [:put-docs :tokens (-> te
                                                   (pxc/strip-temporal)
                                                   (assoc :token/begin 0))]]))
                       ;; Gaps between tokens
                       (mapcat
                        (fn [[a b]]
                          (when (< (:token/end a) (:token/begin b))
                            ;; Extend token a's end to fill gap
                            (let [te (get sys-from-by-id (:xt/id a))]
                              [(pxc/match* :tokens te)
                               [:put-docs :tokens (-> te
                                                      (pxc/strip-temporal)
                                                      (assoc :token/end (:token/begin b)))]])))
                        (partition 2 1 sorted))
                       ;; Gap at end?
                       (when (and (seq sorted) (< (:token/end (last sorted)) new-text-len))
                         (let [te (get sys-from-by-id (:xt/id (last sorted)))]
                           [(pxc/match* :tokens te)
                            [:put-docs :tokens (-> te
                                                   (pxc/strip-temporal)
                                                   (assoc :token/end new-text-len))]])))
                      ;; Validate: apply gap-fills to get final token state, then check partition
                      updates (into {}
                                    (keep (fn [op]
                                            (when (and (vector? op) (= :put-docs (first op)))
                                              [(:xt/id (nth op 2)) (nth op 2)])))
                                    gap-fills)
                      final-tokens (map (fn [t] (or (get updates (:xt/id t)) t)) sorted)]
                  (validate-partition! final-tokens new-text-len)
                  (vec gap-fills))))))
        tokens-by-layer)))))
