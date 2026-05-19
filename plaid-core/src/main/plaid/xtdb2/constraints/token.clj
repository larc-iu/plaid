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
  "ASSERT tx-op ensuring the ONLY tokens in layer+doc are the ones being inserted
  (inserted-ids). XTDB evaluates ASSERTs against the in-tx state including this
  tx's own put-docs, so we exclude the inserted ids and assert nothing else
  exists. This makes partitioning bulk-create safe against a concurrent
  establishment that committed first (the pre-flight emptiness read is not enough
  on its own — see operation-coordinator: regular ops are not serialized against
  each other)."
  [layer-id doc-id inserted-ids]
  (if (seq inserted-ids)
    (let [ph (str/join ", " (repeat (count inserted-ids) "?"))]
      [:sql (str "ASSERT NOT EXISTS (SELECT 1 FROM tokens"
                 " WHERE token$layer = ? AND token$document = ?"
                 " AND _id NOT IN (" ph "))")
       (into [layer-id doc-id] inserted-ids)])
    [:sql (str "ASSERT NOT EXISTS (SELECT 1 FROM tokens"
               " WHERE token$layer = ? AND token$document = ?)")
     [layer-id doc-id]]))

;; ---------------------------------------------------------------------------
;; Partition validation
;; ---------------------------------------------------------------------------

(defn validate-partition!
  "Validate that a set of tokens forms a complete, gap-free, overlap-free
  partition of [0, text-length). Tokens must be sorted by :token/begin.
  Throws on violation."
  [tokens text-length]
  (when (empty? tokens)
    (when (pos? text-length)
      (throw (ex-info "Partitioning layer requires tokens covering the entire text"
                      {:code 400 :text-length text-length}))))
  (let [sorted (sort-by :token/begin tokens)]
    ;; Check first token starts at 0
    (when (not= 0 (:token/begin (first sorted)))
      (throw (ex-info "Partitioning requires first token to start at 0"
                      {:code 400 :first-begin (:token/begin (first sorted))})))
    ;; Check last token ends at text-length
    (when (not= text-length (:token/end (last sorted)))
      (throw (ex-info "Partitioning requires last token to end at text length"
                      {:code 400 :last-end (:token/end (last sorted)) :text-length text-length})))
    ;; Check contiguous (no gaps, no overlaps)
    (doseq [[a b] (partition 2 1 sorted)]
      (when (not= (:token/end a) (:token/begin b))
        (throw (ex-info "Partitioning requires contiguous tokens (no gaps or overlaps)"
                        {:code 400
                         :token-a-end (:token/end a)
                         :token-b-begin (:token/begin b)}))))
    ;; Check no zero-width tokens
    (doseq [t sorted]
      (when (= (:token/begin t) (:token/end t))
        (throw (ex-info "Zero-width tokens are not allowed in partitioning mode"
                        {:code 400 :token-id (:xt/id t)}))))))

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

(defn enforce
  "Run overlap-mode constraint enforcement for a token op and return base-ops
  augmented with TOCTOU-safety ops. Pre-flight checks throw ex-info with a :code
  on violation. This is the only place overlap-mode is interpreted for token
  writes; the `*` fns are constraint-unaware.

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
          records (vec (put-token-records base-ops))]
      (check-bulk-create! overlap-mode node layer doc-id records text-length)
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
    :shift (enforce-shift node ctx base-ops)))

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
            (if (not= mode :partitioning)
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
