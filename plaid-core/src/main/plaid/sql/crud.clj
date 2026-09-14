(ns plaid.sql.crud
  "The audited row primitives every entity namespace writes through.

  One helper per shape of change — `insert!`, `update-by-id!`, `delete-by-id!`,
  `merge*` for a single row; `insert-many!`, `bulk-update-by-id!`,
  `delete-where!` for many — each capturing the post-image and emitting the
  matching `audit_writes` row. They require `plaid.sql.audit-write/*op*` to be
  bound, i.e. that the caller is inside `submit-operation!`.

  The join-table helpers at the bottom are the deliberate exception: they are
  not audited, because the parent entity's own audit row already carries the
  junction state."
  (:require [plaid.sql.audit-write :as psaw]
            [plaid.sql.common :as psc]))

;; ============================================================
;; Write primitives with audit capture
;;
;; All entity-table mutations should go through these helpers so audit_writes
;; rows are populated uniformly. They require `psaw/*op*` to be bound (i.e. you are
;; inside submit-operation!) — calls outside that context throw. The bootstrap
;; path (e.g. admin-user creation at startup) opts out by `(binding [psaw/*op* ::skip] ...)`.
;;
;; Join-table writes (project_users, span_tokens, vocab_link_tokens, etc.) use
;; the unaudited `add-join!` / `remove-join!` helpers below — their churn is
;; high-volume and the parent entity's audit row already captures the change.
;; ============================================================

(defn insert!
  "Insert one row into `table`. Returns the inserted row (the RETURNING *
  post-image, so DB defaults / generated columns are reflected). Records an
  audit_writes row. Single round-trip: INSERT ... RETURNING * captures both
  the write and the post-image."
  ([tx table row]
   (insert! tx table row {}))
  ([tx table row {:keys [id-col] :or {id-col :id}}]
   (psaw/ensure-op-bound!)
   (let [id (get row id-col)]
     (when (nil? id)
       (throw (ex-info "insert! requires the row to carry its primary key"
                       {:table table :id-col id-col :code 500})))
     (let [post (psc/execute-returning-one! tx {:insert-into table
                                                :values [row]
                                                :returning [:*]})]
       (psaw/record-audit-write! tx table id :insert nil post)
       (or post row)))))

(defn update-by-id!
  "Update a single row by id with the given attrs (column-keyed map).
  No-ops (does not audit) if the row doesn't exist. Also skips the
  audit_writes row when the post-image equals the pre-image (i.e. the
  caller wrote the same values back) — these are noise for the audit
  log / ETL consumers. Returns the post-image row, or nil if the row
  was missing. Pre-image still requires a SELECT (needed before the
  UPDATE), but the post-image is captured via `UPDATE ... RETURNING *`
  in the same round-trip as the write."
  ([tx table id attrs]
   (update-by-id! tx table id attrs {}))
  ([tx table id attrs {:keys [id-col] :or {id-col :id}}]
   (psaw/ensure-op-bound!)
   (let [pre (psc/fetch-by-id tx table id-col id)]
     (when (some? pre)
       (let [post (psc/execute-returning-one! tx {:update table
                                                  :set attrs
                                                  :where [:= id-col id]
                                                  :returning [:*]})]
         (when (not= pre post)
           (psaw/record-audit-write! tx table id :update pre post))
         post)))))

(defn delete-by-id!
  "Delete a row by id. Returns the pre-image row (handy for cascade callers),
  or nil if no row matched. No-ops (does not audit) if the row doesn't exist.
  Single round-trip: `DELETE ... RETURNING *` simultaneously deletes the row,
  reports existence, and yields the pre-image for the audit row."
  ([tx table id]
   (delete-by-id! tx table id {}))
  ([tx table id {:keys [id-col] :or {id-col :id}}]
   (psaw/ensure-op-bound!)
   (let [pre (psc/execute-returning-one! tx {:delete-from table
                                             :where [:= id-col id]
                                             :returning [:*]})]
     (when (some? pre)
       (psaw/record-audit-write! tx table id :delete pre nil)
       pre))))

(defn merge*
  "Read-modify-write helper. Validates the row exists, applies `attrs`
  (column-keyed map), and audits the update. Throws ex-info with :code 404
  when the row is missing. Returns the post-image row. Pre-image still
  requires a SELECT (we need it to 404 before the UPDATE), but the
  post-image is captured via `UPDATE ... RETURNING *` in the same
  round-trip as the write. Skips the audit_writes row when the post-image
  equals the pre-image (caller wrote the same values back) — matches the
  `update-by-id!` contract and keeps no-op updates out of the audit log.

  Mirrors the v2 `plaid.xtdb2.common/merge*` contract for ergonomic parity."
  ([tx table id attrs]
   (merge* tx table id attrs {}))
  ([tx table id attrs {:keys [id-col not-found-kind] :or {id-col :id}}]
   (psaw/ensure-op-bound!)
   (let [pre (psc/fetch-by-id tx table id-col id)]
     (when (nil? pre)
       (throw (ex-info (psc/err-msg-not-found (or not-found-kind (name table)) id)
                       {:id id :code 404})))
     (let [post (psc/execute-returning-one! tx {:update table
                                                :set attrs
                                                :where [:= id-col id]
                                                :returning [:*]})]
       (when (not= pre post)
         (psaw/record-audit-write! tx table id :update pre post))
       post))))

;; ============================================================
;; Bulk write helpers
;; ============================================================

(defn insert-many!
  "Bulk-insert rows. Each row gets its own audit_writes entry. Returns
  the count inserted.

  Chunks the input to stay under SQLite's SQLITE_MAX_VARIABLE_NUMBER
  ceiling (~32766 in sqlite-jdbc 3.50.x's bundled SQLite). With each
  multi-row INSERT carrying ~7 parameters per row, ~4000 rows per
  call is the safe upper bound; we issue N batched INSERTs in the
  same tx and one audit_writes row per inserted entity regardless of
  chunking. Each chunked INSERT uses `RETURNING *` to capture the
  post-images inline, eliminating the previous post-IN SELECT round-trip."
  [tx table rows]
  (psaw/ensure-op-bound!)
  (if (empty? rows)
    0
    (let [rows (vec rows)
          chunks (partition-all psc/bulk-chunk-size rows)]
      (doseq [chunk chunks]
        (let [posts (psc/execute-returning! tx {:insert-into table
                                                :values (vec chunk)
                                                :returning [:*]})]
          (psaw/record-audit-writes! tx table :insert
                                     (map (fn [post] [(:id post) nil post]) posts))))
      (count rows))))

(defn bulk-update-by-id!
  "Apply per-id attribute updates in a single CASE-driven UPDATE statement.

  Accepts EITHER:
    - a map `id → attrs-map` (legacy API; audit rows emit in `(sort ids)`
      order for determinism), OR
    - a sequence of `[id attrs-map]` pairs (preferred; audit rows emit in
      the supplied pair order, letting callers control ordering — e.g.
      sort by source position so the audit log reflects document order).

  Each row's attrs-map should carry the same set of columns (the helper
  builds one CASE expression per column union — rows that don't supply a
  particular column fall through to the column's existing value via
  `ELSE <col>`). Per-id no-ops (pre == post for the supplied attrs) are
  skipped from the audit log, matching `update-by-id!` / `merge*`.

  NOTE: the `ELSE <col>` self-reference means columns whose write path
  expects pre-serialized JSON (notably `:config`) must be serialized by
  the caller BEFORE handing the attrs map to this helper. The helper
  does not call `psc/serialize-config` on its own — pass the raw map and
  the `:case … :else col` fallback would compare the raw map against
  the stored JSON string and treat every row as a change.

  Round-trip shape: 1 SELECT (pre-images, only when not empty) + 1 UPDATE
  with RETURNING * (post-images), regardless of input size. Chunks the
  input to respect SQLite's SQLITE_MAX_VARIABLE_NUMBER (~32766) ceiling —
  each id contributes ~(2 * cols + 1) parameters to the statement, so we
  pick a conservative chunk size.

  Returns a vector of post-image rows (across all chunks). Row order
  within each chunk follows the database's RETURNING order; audit row
  order is the deterministic order described above."
  ([tx table id->updates]
   (bulk-update-by-id! tx table id->updates {}))
  ([tx table id->updates {:keys [id-col] :or {id-col :id}}]
   (psaw/ensure-op-bound!)
   (if (empty? id->updates)
     []
     (let [;; Normalize to a sequence of [id attrs] pairs in audit-emit
           ;; order: caller-supplied order for seqs, sorted-by-id for maps.
           pairs (cond
                   (map? id->updates) (mapv (fn [id] [id (get id->updates id)])
                                            (sort (keys id->updates)))
                   :else (vec id->updates))
           ids (mapv first pairs)
           id->attrs (into {} pairs)
           ;; Union of columns supplied across all rows (in stable order).
           ;; Defensive guard: drop columns that are keyed nowhere across
           ;; the input (i.e. `(contains? attrs col)` is false for every
           ;; row). Without this, `(into [:case] ...)` would yield a bare
           ;; `[:case :else col]` and HoneySQL would render
           ;; `CASE ELSE col END` — invalid SQL. The check is a no-op
           ;; for today's callers (both `text/apply-text-edits` and
           ;; relation-layer bulk-shift populate every column on every
           ;; row), but the guard keeps the helper composable for
           ;; future callers and removes a sharp edge.
           cols (vec (distinct
                      (filter (fn [col]
                                (some #(contains? (second %) col) pairs))
                              (mapcat (comp keys second) pairs))))
           ;; Conservative chunk: each row contributes (2*cols + 1) params
           ;; (WHEN id THEN val per column, plus one id in the IN list).
           ;; Plus 1 :else col-ref per column (no param). Stay under ~30k.
           max-rows-per-chunk (max 1 (long (/ 30000 (+ 1 (* 2 (max 1 (count cols)))))))
           chunks (partition-all (min psc/bulk-chunk-size max-rows-per-chunk) ids)]
       (into []
             (mapcat
              (fn [chunk-ids]
                (let [chunk-ids (vec chunk-ids)
                      ;; Pre-image SELECT for the chunk.
                      pres (psc/q tx {:select [:*]
                                      :from [table]
                                      :where [:in id-col chunk-ids]})
                      pre-by-id (into {} (map (juxt id-col identity)) pres)
                      ;; Skip ids not present in DB (mirrors update-by-id!
                      ;; "no-op if missing" semantics).
                      present-ids (filterv #(contains? pre-by-id %) chunk-ids)]
                  (if (empty? present-ids)
                    []
                    (let [set-clause
                          (into {}
                                (map (fn [col]
                                       [col (into [:case]
                                                  (mapcat (fn [id]
                                                            (let [attrs (get id->attrs id)]
                                                              (when (contains? attrs col)
                                                                [[:= id-col id] (get attrs col)])))
                                                          present-ids))]))
                                cols)
                          ;; Each :case must have an :else fallback so rows
                          ;; whose attrs map omits a column keep their
                          ;; existing value.
                          set-clause-with-else
                          (into {}
                                (map (fn [[col case-expr]]
                                       [col (conj case-expr :else col)]))
                                set-clause)
                          posts (psc/execute-returning! tx {:update table
                                                            :set set-clause-with-else
                                                            :where [:in id-col present-ids]
                                                            :returning [:*]})
                          post-by-id (into {} (map (juxt id-col identity)) posts)]
                      ;; One audit row per id (in input order), skipping
                      ;; no-ops where pre == post.
                      (psaw/record-audit-writes!
                       tx table :update
                       (keep (fn [id]
                               (let [pre (get pre-by-id id)
                                     post (get post-by-id id)]
                                 (when (and (some? post) (not= pre post))
                                   [id pre post])))
                             present-ids))
                      posts)))))
             chunks)))))

(defn delete-where!
  "Delete rows matching `where-clause` (HoneySQL fragment) and audit each
  deletion individually. Returns the deleted pre-images. Single round-trip:
  `DELETE ... WHERE ... RETURNING *` yields the pre-images of every deleted
  row, eliminating the prior pre-IN SELECT."
  ([tx table where-clause]
   (delete-where! tx table where-clause {}))
  ([tx table where-clause {:keys [id-col] :or {id-col :id}}]
   (psaw/ensure-op-bound!)
   (let [pres (psc/execute-returning! tx {:delete-from table
                                          :where where-clause
                                          :returning [:*]})]
     (psaw/record-audit-writes! tx table :delete
                                (map (fn [pre] [(get pre id-col) pre nil]) pres))
     pres)))

;; ============================================================
;; Join-table write helpers (unaudited; the parent entity audits cover them)
;; ============================================================

(defn- where-map->vector [m]
  (into [:and] (map (fn [[k v]] [:= k v]) m)))

(defn add-join!
  "INSERT into a join table. `row` is a column-keyed map. Caller is
  responsible for idempotency — guard with `(when-not (q1 ...) (add-join! ...))`
  if you need that. Not audited."
  [tx table row]
  (psc/execute! tx {:insert-into table :values [row]}))

(defn add-join-if-absent!
  "INSERT a join row, no-op if a conflicting row already exists. Relies on
  the join table's UNIQUE/PRIMARY KEY constraint plus `ON CONFLICT DO NOTHING`
  for atomicity — the prior SELECT-then-INSERT pattern raced when the outer
  context was a SAVEPOINT (no BEGIN IMMEDIATE lock) rather than a top-level
  write tx. Callers ignore the return value.

  GOTCHA: the bare `:on-conflict []` form here omits an explicit conflict
  target, so SQLite treats it as \"do nothing on ANY unique-constraint
  violation on this table\". That's safe today because every join table
  has exactly one UNIQUE constraint (the membership tuple), but if a
  future schema migration adds a second UNIQUE constraint to one of
  these tables (e.g. a unique-id column alongside the membership pair),
  silently swallowing a violation on the new constraint would mask
  bugs. Pin to the conflict target columns explicitly
  (`:on-conflict [:col-a :col-b]`) before adding any second UNIQUE
  constraint to a table that this helper writes to."
  [tx table row]
  (psc/execute! tx {:insert-into table
                    :values [row]
                    :on-conflict []
                    :do-nothing []}))

(defn remove-join!
  "DELETE from a join table by column-keyed where map. Idempotent.
  Does not audit (see add-join!)."
  [tx table where-map]
  (psc/execute! tx {:delete-from table :where (where-map->vector where-map)}))
