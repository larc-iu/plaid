(ns plaid.xtdb2.constraints.token
  "Token constraint checking and compensation logic.
  Enforces overlap-mode invariants (:any, :non-overlapping, :partitioning)
  on token CRUD operations.

  `enforce` is the single entry point: token `-operation` fns build pure base
  tx-ops via their `*` fns, then call `enforce` once to run pre-flight checks and
  append TOCTOU-safety ops. All overlap-mode interpretation lives here, not in
  token.clj. `compensate-after-cascade` and `text-edit-partition-asserts` are the
  other public fns, used by the text-body-edit cascade."
  (:require [xtdb.api :as xt]
            [clojure.string :as str]
            [plaid.xtdb2.common :as pxc]))

;; ---------------------------------------------------------------------------
;; Helpers
;; ---------------------------------------------------------------------------

(defn layer-overlap-mode [node layer-id]
  (:token-layer/overlap-mode (pxc/entity node :token-layers layer-id)))

(defn- layer-parent
  "The parent token-layer id of layer-id, or nil for a root (flat) layer."
  [node layer-id]
  (:token-layer/parent-token-layer (pxc/entity node :token-layers layer-id)))

;; -- Parent containment (axis 2, forward) -----------------------------------

(defn- containing-parent
  "The parent-layer token (same doc, with :xt/system-from) whose extent contains
  [begin, end), or nil. Containment is inclusive: a child equal to its parent's
  extent counts as contained. Point-query form, for resolving a single child.

  Parent layers are restricted to disjoint overlap-modes (:non-overlapping /
  :partitioning — enforced at layer creation) and child tokens on a nested layer
  may not be zero-width (enforced in enforce-nesting), so for any valid child
  there is at most one containing parent. The ORDER BY (tightest extent first,
  then :xt/id) is deterministic insurance: if state ever does present overlapping
  candidates, create-time match* and cascade-time offset resolution still agree on
  the same parent."
  [node parent-layer-id doc-id begin end]
  (first (xt/q node [(str "SELECT *, _system_from FROM tokens"
                          " WHERE token$layer = ? AND token$document = ?"
                          " AND token$begin <= ? AND token$end >= ?"
                          " ORDER BY token$begin DESC, token$end ASC, _id ASC")
                     parent-layer-id doc-id begin end])))

(defn- parent-tokens-for-doc
  "All tokens (with :xt/system-from) in the parent layer for this doc. Read once
  when resolving containment for a batch of children, instead of a point query
  per child (containing-parent) — see enforce-nesting."
  [node parent-layer-id doc-id]
  (xt/q node ["SELECT *, _system_from FROM tokens WHERE token$layer = ? AND token$document = ?"
              parent-layer-id doc-id]))

(defn- containing-parent-in-memory
  "In-memory equivalent of containing-parent over a pre-fetched parent token seq.
  Same deterministic preference as the SQL ORDER BY: tightest extent (largest
  begin, then smallest end), then :xt/id."
  [parents begin end]
  (->> parents
       (filter (fn [p] (and (<= (:token/begin p) begin) (>= (:token/end p) end))))
       (sort-by (juxt (comp - :token/begin) :token/end (comp str :xt/id)))
       first))

;; -- Descendant layers + tokens (axis 2, reverse / cascades) -----------------

(defn- child-layer-ids
  "Token-layer ids that declare layer-id as their parent (the reverse of
  layer-parent)."
  [node layer-id]
  (->> (xt/q node ["SELECT _id FROM token_layers WHERE token_layer$parent_token_layer = ?" layer-id])
       (mapv :xt/id)))

(defn descendant-layer-ids
  "All transitive child layers of layer-id (children, grandchildren, ...). The
  parent graph is a tree (parent must pre-exist at creation, parentage is
  immutable), so this terminates; the `seen` set is cheap insurance against an
  otherwise-unreachable cycle. Public so callers compute it ONCE per op and
  thread it into the descendant-token helpers below (avoids recomputing the BFS
  per token in bulk ops)."
  [node layer-id]
  (loop [frontier [layer-id] seen #{} acc []]
    (let [kids (->> (mapcat #(child-layer-ids node %) frontier)
                    (remove seen)
                    vec)]
      (if (empty? kids)
        acc
        (recur kids (into seen kids) (into acc kids))))))

(defn- query-descendant-tokens
  "Core query over all tokens in the given descendant layers (same doc),
  restricted by an extra WHERE fragment + its params. `cols` is the projection
  (\"_id\" or \"*, _system_from\"). Returns [] when dlids is empty. dlids is
  passed in (precomputed via descendant-layer-ids) so an op resolves the
  descendant-layer set once rather than per call."
  [node dlids doc-id cols where-frag where-params]
  (if (empty? dlids)
    []
    (let [ph (str/join ", " (repeat (count dlids) "?"))
          sql (str "SELECT " cols " FROM tokens"
                   " WHERE token$layer IN (" ph ") AND token$document = ?"
                   where-frag)]
      (xt/q node (into [sql] (concat dlids [doc-id] where-params))))))

(defn straddling-descendant-token-ids-at
  "Ids of descendant tokens (same doc) straddling position p (begin < p < end),
  scanned doc-wide. Used by the partitioning resize cascade: a partitioning
  parent's tokens are disjoint, so p lies inside exactly one parent before the
  shift — the doc-wide scan finds the straddler whether the boundary moved into
  this token (shrink) or into its neighbor (grow), and matches nothing else."
  [node dlids doc-id p]
  (mapv :xt/id (query-descendant-tokens node dlids doc-id "_id"
                                        " AND token$begin < ? AND token$end > ?" [p p])))

(defn straddling-descendant-token-ids-in
  "Like -at, but restricted to descendants within [lo, hi). Used by the split
  cascade: the token being split may sit on an :any layer with overlapping
  siblings, so the scan is scoped to the token actually being split."
  [node dlids doc-id lo hi p]
  (mapv :xt/id (query-descendant-tokens node dlids doc-id "_id"
                                        (str " AND token$begin >= ? AND token$end <= ?"
                                             " AND token$begin < ? AND token$end > ?")
                                        [lo hi p p])))

(defn descendant-token-ids-in-extent
  "Ids of all descendant tokens (same doc) nested within [lo, hi). The delete
  cascade adds these to the delete set so deleting a parent also deletes the
  tokens nested in it (and, via multi-delete*, their dependents)."
  [node dlids doc-id lo hi]
  (mapv :xt/id (query-descendant-tokens node dlids doc-id "_id"
                                        " AND token$begin >= ? AND token$end <= ?" [lo hi])))

(defn descendant-token-entities-in-extent
  "Descendant tokens (with :xt/system-from) nested within [lo, hi). Used by the
  non-overlapping resize cascade to classify each descendant as inside / outside
  / straddling the new parent extent."
  [node dlids doc-id lo hi]
  (vec (query-descendant-tokens node dlids doc-id "*, _system_from"
                                " AND token$begin >= ? AND token$end <= ?" [lo hi])))

(defn- assert-no-tokens
  "An `ASSERT NOT EXISTS` tx-op over the tokens table with the given WHERE fragment
  (everything after `WHERE`) and its params — the shared skeleton for the TOCTOU
  guards below. Used inside transactions for TOCTOU safety against concurrently
  inserted rows that have no row to match*."
  [where-frag params]
  [:sql (str "ASSERT NOT EXISTS (SELECT 1 FROM tokens WHERE " where-frag ")")
   (vec params)])

(defn- layer-in-clause
  "SQL fragment `token$layer IN (?, ?, …)` for a seq of layer ids (params are the
  ids themselves, in order)."
  [layer-ids]
  (str "token$layer IN (" (str/join ", " (repeat (count layer-ids) "?")) ")"))

(defn- no-children-assert-sql
  "ASSERT NOT EXISTS a child-layer token within [lo, hi) — TOCTOU guard for parent
  structural ops (a concurrent child create inside the affected region has no row
  to match*, so we assert it away)."
  [child-layer-ids doc-id lo hi]
  (assert-no-tokens (str (layer-in-clause child-layer-ids)
                         " AND token$document = ? AND token$begin >= ? AND token$end <= ?")
                    (into (vec child-layer-ids) [doc-id lo hi])))

(defn- no-straddler-assert-sql
  "ASSERT NOT EXISTS a child-layer token straddling position p (begin < p < end) —
  TOCTOU guard for splitting a parent at p (a concurrent child created across p
  would be orphaned by the split)."
  [child-layer-ids doc-id p]
  (assert-no-tokens (str (layer-in-clause child-layer-ids)
                         " AND token$document = ? AND token$begin < ? AND token$end > ?")
                    (into (vec child-layer-ids) [doc-id p p])))

(defn- no-out-of-bounds-child-assert-sql
  "ASSERT NOT EXISTS a child-layer token within the old extent [b, e) that falls
  outside the new extent [nb, ne) — TOCTOU guard for resizing a parent (a
  concurrent child created in the part being removed would be orphaned)."
  [child-layer-ids doc-id b e nb ne]
  (assert-no-tokens (str (layer-in-clause child-layer-ids)
                         " AND token$document = ? AND token$begin >= ? AND token$end <= ?"
                         " AND (token$begin < ? OR token$end > ?)")
                    (into (vec child-layer-ids) [doc-id b e nb ne])))

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
  (assert-no-tokens (str "token$layer = ? AND token$document = ?"
                         " AND token$begin < ? AND token$end > ?"
                         (when exclude-id " AND _id <> ?"))
                    (cond-> [layer-id doc-id end begin]
                      exclude-id (conj exclude-id))))

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
  "ASSERT tx-op ensuring the ONLY tokens in layer+doc are the ones being inserted
  (inserted-ids). XTDB evaluates ASSERTs against the in-tx state including this
  tx's own put-docs, so we exclude the inserted ids and assert nothing else
  exists. This makes partitioning bulk-create safe against a concurrent
  establishment that committed first (the pre-flight emptiness read is not enough
  on its own — see operation-coordinator: regular ops are not serialized against
  each other). Partitioning layers are always root layers, so the partition
  covers the whole document — no per-parent range scoping is needed."
  [layer-id doc-id inserted-ids]
  (let [ids? (seq inserted-ids)
        id-clause (when ids?
                    (str " AND _id NOT IN (" (str/join ", " (repeat (count inserted-ids) "?")) ")"))]
    (assert-no-tokens (str "token$layer = ? AND token$document = ?" id-clause)
                      (into [layer-id doc-id] (when ids? inserted-ids)))))

;; ---------------------------------------------------------------------------
;; Partition validation
;; ---------------------------------------------------------------------------

(defn- validate-partition-range!
  "Validate that tokens form a complete, gap-free, overlap-free, zero-width-free
  partition of [lo, hi). Throws (400) on violation. Partitioning is root-only, so
  this is always called with [0, text-length) (via validate-partition!); the
  [lo,hi) parameterization is kept only for readability."
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
          ;; A partitioning shift moves a shared boundary between two adjacent
          ;; tokens. It must keep BOTH the shifted token and the adjusted neighbor
          ;; positive-width, so the new boundary stays strictly inside the
          ;; neighbor's extent — otherwise it would zero-width / invert / overlap a
          ;; token and break the partition. The layer is never re-validated after a
          ;; shift, so these guards are what keep "empty or a valid partition" true.
          (do
            (when (>= new-begin new-end)
              (throw (ex-info "Shift would make the token zero-width, which is not allowed on partitioning layers"
                              {:code 400 :new-begin new-begin :new-end new-end})))
            (cond-> []
              ;; If begin changed, find the token whose end == old begin and adjust it
              (not= new-begin begin)
              (into (let [left-neighbors (xt/q node
                                               [(str "SELECT *, _system_from FROM tokens"
                                                     " WHERE token$layer = ? AND token$document = ?"
                                                     " AND token$end = ? AND _id <> ?")
                                                layer doc-id begin token-id])]
                      (if-let [neighbor (first left-neighbors)]
                        (do
                          (when (>= (:token/begin neighbor) new-begin)
                            (throw (ex-info (str "Shift would collapse or invert the adjacent token; a partitioning"
                                                 " boundary may only move within the neighbor's extent")
                                            {:code 400 :new-begin new-begin
                                             :neighbor-begin (:token/begin neighbor)})))
                          [(pxc/match* :tokens neighbor)
                           [:put-docs :tokens (-> neighbor
                                                  (pxc/strip-temporal)
                                                  (assoc :token/end new-begin))]])
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
                        (do
                          (when (<= (:token/end neighbor) new-end)
                            (throw (ex-info (str "Shift would collapse or invert the adjacent token; a partitioning"
                                                 " boundary may only move within the neighbor's extent")
                                            {:code 400 :new-end new-end
                                             :neighbor-end (:token/end neighbor)})))
                          [(pxc/match* :tokens neighbor)
                           [:put-docs :tokens (-> neighbor
                                                  (pxc/strip-temporal)
                                                  (assoc :token/begin new-end))]])
                        (when (not= new-end text-length)
                          (throw (ex-info "Cannot shift end: no adjacent token found and new end is not text length"
                                          {:code 400 :new-end new-end :text-length text-length})))))))))]
    (into (vec base-ops) constraint-ops)))

;; ---------------------------------------------------------------------------
;; Single entry point
;; ---------------------------------------------------------------------------

(defn- enforce-overlap
  "Overlap-mode enforcement (axis 1). Returns base-ops augmented with overlap
  ASSERTs / shift neighbor ops. Nesting (axis 2) is layered on by enforce-nesting.

  The ctx keys each op requires are listed in `required-ctx-keys` (the single
  source of truth, checked for presence at the top of `enforce`). For a delete of
  a missing token the keys are present but nil, which correctly skips the checks."
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
    ;; Partitioning is only allowed on root (parentless) layers, so it always
    ;; tiles the whole text here — there is no per-parent establishment path.
    (let [{:keys [layer doc-id text-length]} ctx
          overlap-mode (layer-overlap-mode node layer)
          records (vec (put-token-records base-ops))]
      (check-bulk-create! overlap-mode node layer doc-id records text-length)  ; no-op for :any
      (case overlap-mode
        :non-overlapping
        (into (vec base-ops)
              (mapcat (fn [rec]
                        (create-overlap-asserts :non-overlapping layer doc-id
                                                (:token/begin rec) (:token/end rec)
                                                :exclude-id (:xt/id rec)))
                      records))
        :partitioning
        (conj (vec base-ops)
              (partition-establish-assert-sql layer doc-id (mapv :xt/id records)))
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
  delete/shrink rolls this tx back. Containment also makes cross-parent
  merge/shift impossible: a merged/shifted extent that escapes its parent has no
  containing token and is rejected.

  Nested layers are never :partitioning (partitioning is restricted to root
  layers), so there is no per-parent tiling to establish here — only containment.

  Only create/update/bulk-create/merge/shift can introduce/move a child; delete
  and bulk-delete never break containment, so they are passed through."
  [op node ctx ops]
  (let [layer (:layer ctx)
        ;; Only create/update/bulk-create/merge/shift can introduce or move a child.
        ;; Gate the layer-parent read on op membership FIRST so delete/bulk-delete/split
        ;; (which never break containment) don't pay a then-discarded ~10ms lookup —
        ;; per-query overhead dominates here, so a wasted single-id read is not free.
        parent-layer (when (and layer
                                (contains? #{:create :update :bulk-create :merge :shift} op))
                       (layer-parent node layer))]
    (if (nil? parent-layer)
      ops
      (let [doc-id (:doc-id ctx)
            child-records (filter #(= layer (:token/layer %)) (put-token-records ops))
            ;; Resolve each child's containing parent. For a batch (>1 child, i.e.
            ;; bulk-create) read the parent layer's tokens once and resolve in
            ;; memory, rather than a point query per child.
            parents (when (> (count child-records) 1)
                      (parent-tokens-for-doc node parent-layer doc-id))
            resolve-parent (fn [b e]
                             (if parents
                               (containing-parent-in-memory parents b e)
                               (containing-parent node parent-layer doc-id b e)))
            child+parent
            (mapv (fn [rec]
                    (let [b (:token/begin rec) e (:token/end rec)]
                      ;; A zero-width child at a shared parent boundary would be
                      ;; contained in BOTH adjacent parents, making containment
                      ;; ambiguous — disallow zero-width tokens on nested layers.
                      (when (= b e)
                        (throw (ex-info "Zero-width tokens are not allowed on nested token layers"
                                        {:code 400 :begin b :end e :layer layer})))
                      (let [p (resolve-parent b e)]
                        (when (nil? p)
                          (throw (ex-info "Token is not contained within any parent-layer token"
                                          {:code 400 :begin b :end e :parent-layer parent-layer})))
                        [rec p])))
                  child-records)
            parent-match-ops (->> child+parent
                                  (reduce (fn [m [_ p]] (assoc m (:xt/id p) p)) {})
                                  vals
                                  (mapv #(pxc/match* :tokens %)))]
        (into (vec ops) parent-match-ops)))))

;; ---------------------------------------------------------------------------
;; Parent-side guard (axis 2, reverse): structural ops on a token that has
;; child-layer tokens nested in it are rejected (phase 1: clear children first)
;; ---------------------------------------------------------------------------

(defn- guard-dlids
  "Descendant layer ids for the parent-side guard. The -operation fns already
  resolve these (to expand the cascade), so they thread them in via ctx :dlids;
  prefer that to avoid re-running the BFS. Fall back to computing for `layer` when
  ctx doesn't carry it (e.g. an internal caller that didn't precompute)."
  [node ctx layer]
  (if (contains? ctx :dlids)
    (:dlids ctx)
    (when layer (descendant-layer-ids node layer))))

(defn- enforce-parent-guard
  "Reject structural ops on a parent token that would orphan nested child-layer
  tokens (reject-don't-cascade). The check is precise per op rather than \"any
  child → reject\":

    :delete / :bulk-delete  — removing a parent orphans every child in it ⇒
                              reject if it has any child (coarse == precise here).
    :split at p             — only a child straddling p (begin < p < end) is
                              orphaned; a boundary-aligned split is allowed
                              (children re-derive their parent by offset).
    :shift / :update        — only a child outside the NEW extent [nb,ne) is
                              orphaned; growing/shifting that still covers all
                              children is allowed.

  Cascading ops (delete, bulk-delete, split) don't reject — the -operation fns
  expand the op to its nested descendants — so the guard only adds a TOCTOU ASSERT
  that no un-handled descendant remains. shift/update stay reject-don't-cascade
  (shrinking through a child has no clean tiling answer). No-op for layers with no
  descendant layers (flat/leaf layers are unaffected)."
  [op node ctx ops]
  (case op
    :delete
    ;; delete-operation cascade-deletes descendants; assert none remain in the extent
    (let [{:keys [layer doc-id begin end]} ctx
          dlids (guard-dlids node ctx layer)]
      (if (empty? dlids)
        (vec ops)
        (conj (vec ops) (no-children-assert-sql dlids doc-id begin end))))

    :bulk-delete
    ;; bulk-delete-operation threads :dlids-by-layer (one BFS per distinct layer);
    ;; prefer it, falling back to a per-layer compute only if absent.
    (let [dlids-by-layer (:dlids-by-layer ctx)]
      (into (vec ops)
            (mapcat (fn [[layer-id tokens]]
                      (let [doc-id (:token/document (first tokens))
                            dlids (if dlids-by-layer
                                    (get dlids-by-layer layer-id)
                                    (descendant-layer-ids node layer-id))]
                        (if (empty? dlids)
                          []
                          (mapv (fn [t] (no-children-assert-sql dlids doc-id
                                                                (:token/begin t) (:token/end t)))
                                tokens))))
                    (:tokens-by-layer ctx))))

    :split
    ;; split cascades: split-operation also splits every straddling descendant at
    ;; the position, so a split never orphans a child. We only add a TOCTOU assert
    ;; that no straddler remains across descendant layers (catches one created
    ;; concurrently after the cascade read).
    (let [{:keys [layer doc-id position]} ctx
          dlids (guard-dlids node ctx layer)]
      (if (empty? dlids)
        (vec ops)
        (conj (vec ops) (no-straddler-assert-sql dlids doc-id position))))

    (:shift :update)
    ;; resize cascades (built in token.clj's -operation): a :partitioning parent
    ;; grows its neighbor and straddlers are split to re-home there; a
    ;; non-overlapping/:any parent trims straddlers and deletes children left
    ;; outside. Here we only add the matching TOCTOU assert over descendant layers.
    (let [{:keys [layer doc-id begin end new-begin new-end extents-changing?]} ctx
          dlids (guard-dlids node ctx layer)]
      ;; :update may carry extents-changing? false (precedence-only change) → no
      ;; resize, no orphan risk. :shift always changes extents (no such key).
      (if (or (empty? dlids) (false? extents-changing?))
        (vec ops)
        (if (= :partitioning (layer-overlap-mode node layer))
          ;; straddlers were split at each moved boundary → assert none remain
          (into (vec ops)
                (keep (fn [p] (no-straddler-assert-sql dlids doc-id p))
                      (cond-> []
                        (not= new-begin begin) (conj new-begin)
                        (not= new-end end) (conj new-end))))
          ;; descendants outside the new extent were trimmed/deleted → assert none remain
          (conj (vec ops) (no-out-of-bounds-child-assert-sql dlids doc-id begin end new-begin new-end)))))

    (vec ops)))

;; ---------------------------------------------------------------------------
;; Single entry point
;; ---------------------------------------------------------------------------

(def ^:private required-ctx-keys
  "The ctx keys each op must supply to `enforce`. Checked for PRESENCE (not
  non-nil — some values are legitimately nil, e.g. a delete of a missing token
  carries nil :layer/:begin/:end) at the top of `enforce`, so a producer that
  forgets a key fails loudly rather than silently skipping a downstream check
  (e.g. a missing :extents-changing? would otherwise read as falsey and skip the
  overlap assert). Keep in sync with the ctx maps the token.clj -operation fns pass."
  {:create      [:layer :doc-id :begin :end]
   :update      [:layer :doc-id :eid :begin :end :new-begin :new-end :extents-changing?]
   :delete      [:layer :doc-id :begin :end]
   :bulk-create [:layer :doc-id :text-length]
   :bulk-delete [:tokens-by-layer]
   :split       [:layer :doc-id :begin :end :position]
   :merge       [:layer :doc-id :t1 :t2 :surviving-id]
   :shift       [:layer :doc-id :token-id :begin :end :new-begin :new-end :text-length]})

(defn- check-ctx-present!
  "Fail loudly if the ctx is missing a key op requires (see required-ctx-keys)."
  [op ctx]
  (doseq [k (get required-ctx-keys op)]
    (when-not (contains? ctx k)
      (throw (ex-info (str "Internal error: constraint ctx missing key " k " for op " op)
                      {:op op :missing-key k :code 500})))))

(defn enforce
  "Run constraint enforcement for a token op and return base-ops augmented with
  TOCTOU-safety ops. Composes three concerns: overlap-mode (within-layer), nesting
  containment (child must sit in a parent), and the parent-side guard (don't
  orphan children). Pre-flight checks throw ex-info with a :code on violation.
  This is the only place token-layer constraints are interpreted; the `*` fns are
  constraint-unaware. See enforce-overlap for ctx keys by op."
  [op node ctx base-ops]
  (check-ctx-present! op ctx)
  (->> (enforce-overlap op node ctx base-ops)
       (enforce-nesting op node ctx)
       (enforce-parent-guard op node ctx)))

;; ---------------------------------------------------------------------------
;; Cascade compensation
;; ---------------------------------------------------------------------------

(defn compensate-after-cascade
  "After a text-body edit reindexes/deletes tokens, produce additional tx-ops to
  keep every PARTITIONING layer a complete cover of the new text.

  A text edit can open a gap in a partitioning layer by deleting a token, by
  shifting tokens off the start/end, or by inserting characters at a token
  boundary — so this runs after EVERY body edit, not only deletions. For each
  partitioning layer that still has tokens it closes every gap by extending tokens,
  then validates; if the result is not a valid partition the whole edit is rejected
  (fail-closed). A partitioning layer left with no tokens is the permitted 'empty'
  state and is untouched. Non-partitioning layers allow gaps and need nothing.

  Arguments:
    node            - XTDB node
    new-tokens      - surviving tokens after the edit, reindexed, temporal keys stripped
    new-text-len    - length of the new text body
    tokens-sys-from - the pre-edit tokens (a seq) carrying :xt/system-from; indexed
                      internally by :xt/id to build match* ops without re-querying

  Returns a vector of additional tx-ops (may be empty)."
  [node new-tokens new-text-len tokens-sys-from]
  (let [sys-from-by-id (into {} (map (juxt :xt/id identity)) tokens-sys-from)
        tokens-by-layer (group-by :token/layer new-tokens)
        ;; Batch-fetch overlap-mode for the affected layers in ONE read instead of a
        ;; layer-overlap-mode query per layer group (per-query overhead dominates, so
        ;; an IN read costs ~the same as a single point lookup). Defaults nil -> :any,
        ;; matching layer-overlap-mode. Empty token set -> empty ids -> no query.
        mode-by-layer (into {}
                            (map (fn [e] [(:xt/id e) (or (:token-layer/overlap-mode e) :any)]))
                            (pxc/entities-with-sys-from node :token-layers (vec (keys tokens-by-layer))))]
    (vec
     (mapcat
      (fn [[layer-id layer-tokens]]
        ;; Partitioning is restricted to root layers, so this always fills against
        ;; the whole [0, text-len). Nested layers (non-overlapping / any) allow gaps
        ;; and need no compensation. A partitioning layer with NO surviving tokens is
        ;; the permitted 'empty' state (group-by omits it) and is untouched.
        (if (not= :partitioning (get mode-by-layer layer-id))
          []
          (let [sorted (vec (sort-by :token/begin layer-tokens))
                n (count sorted)
                ;; Close every gap by EXTENDING tokens (never shrinking), built from
                ;; the reindexed token so one that was both reindexed AND gap-filled
                ;; keeps its correct other coordinate: first token's begin -> 0; each
                ;; token's end -> next token's begin; last token's end -> text length.
                ;; The first token can need both (a leading gap plus a trailing gap).
                final-tokens
                (vec (map-indexed
                      (fn [i tok]
                        (cond-> tok
                          (zero? i) (assoc :token/begin 0)
                          true (assoc :token/end (if (= i (dec n))
                                                   new-text-len
                                                   (max (:token/end tok)
                                                        (:token/begin (nth sorted (inc i))))))))
                      sorted))
                gap-fills
                (vec (mapcat (fn [orig fin]
                               (when (not= (select-keys orig [:token/begin :token/end])
                                           (select-keys fin [:token/begin :token/end]))
                                 (let [te (get sys-from-by-id (:xt/id orig))]
                                   [(pxc/match* :tokens te)
                                    [:put-docs :tokens fin]])))
                             sorted final-tokens))]
            ;; Fail-closed: if the result still isn't a valid partition (e.g. a
            ;; reindex produced an overlap), the whole edit is rejected.
            (validate-partition! final-tokens new-text-len)
            gap-fills)))
      tokens-by-layer))))

(defn text-edit-partition-asserts
  "TOCTOU guards a text-body edit must add so a concurrent partition establishment
  can't leave a partitioning layer partially covering the (edited) text.

  compensate-after-cascade only sees the pre-edit token set. A partitioning layer
  that is EMPTY there is skipped — correct for the single-writer case (empty stays
  empty), but a concurrent bulk-create could establish that layer (validated against
  the OLD text length) and commit first; if this edit GROWS the text, the new
  partition would cover only the old extent and nothing would catch it. So for each
  root partitioning layer that was empty in the pre-edit set, assert it is STILL
  empty at commit. (Non-empty partitioning layers are extended by compensate and
  fenced by its per-token match*; a concurrent establishment of them is impossible
  since bulk-create requires an empty layer.)

  Returns one assert tx-op per empty partitioning layer."
  [node text-id text-layer-id tokens-sys-from]
  (let [token-layer-ids (:text-layer/token-layers (pxc/entity node :text-layers text-layer-id))
        ;; Batch-fetch the text-layer's token-layer rows in ONE read and classify in
        ;; memory, instead of a layer-overlap-mode query per token layer (the N+1 this
        ;; runs on every text-body edit). Per-query overhead dominates, so the IN read
        ;; costs ~the same as a single point lookup regardless of layer count.
        layers (pxc/entities-with-sys-from node :token-layers token-layer-ids)
        layers-with-tokens (set (map :token/layer tokens-sys-from))]
    (->> layers
         (filter #(= :partitioning (or (:token-layer/overlap-mode %) :any)))
         (map :xt/id)
         (remove layers-with-tokens)
         (mapv (fn [lid]
                 [:sql "ASSERT NOT EXISTS (SELECT 1 FROM tokens WHERE token$layer = ? AND token$text = ?)"
                  [lid text-id]])))))
