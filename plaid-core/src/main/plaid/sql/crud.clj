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

(def junction
  "Tables whose ordered token list lives in a junction table, as
  `[junction-table parent-column]`."
  {:spans [:span_tokens :span_id]
   :vocab_links [:vocab_link_tokens :vocab_link_id]})

(defn junction-token-ids
  "The token ids of row `id` of `table` (`:spans`, `:vocab_links`), in their
  order, from its junction table."
  [db table id]
  (let [[jtable jcol] (junction table)]
    (mapv :token_id (psc/q db {:select [:token_id] :from [jtable]
                               :where [:= jcol id] :order-by [:order_idx]}))))

;; ============================================================
;; Index-driven reads and deletes over many ids
;;
;; A delete reaches an unbounded set of rows (the 200,000 spans of a large
;; document), so every statement that takes the set as an IN list runs in
;; chunks of `psc/bulk-chunk-size`: one statement over all of them broke
;; SQLite's statement length limit (SQLITE_TOOBIG). Each one also names the
;; index it seeks (INDEXED BY), so a chunk costs its own ids' seeks whatever
;; the planner's statistics say. With statistics from a near-empty table,
;; SQLite planned `id IN (...)` as a scan of the whole table per chunk.
;; ============================================================

(defn- placeholders [n]
  (apply str (interpose ", " (repeat n "?"))))

(defn- pk-index
  "The index SQLite made for `table`'s TEXT PRIMARY KEY."
  [table]
  (str "sqlite_autoindex_" (name table) "_1"))

(defn- in-chunks
  "`(f chunk)` over `xs` (distinct) in chunks of `psc/bulk-chunk-size`,
  concatenated into a vector."
  [f xs]
  (into [] (mapcat f) (partition-all psc/bulk-chunk-size (distinct (seq xs)))))

(defn select-in
  "The rows (`cols`, a SQL column list) of `table` whose `col` is one of
  `vs`, read through `index`, which must lead with `col`."
  [db table cols col index vs]
  (in-chunks (fn [chunk]
               (psc/q db (into [(str "SELECT " cols " FROM " (name table) " INDEXED BY " index
                                     " WHERE " (name col) " IN (" (placeholders (count chunk)) ")")]
                               (map str chunk))))
             vs))

(defn rows-by-id
  "Map of id to row for the rows of `table` whose id is one of `ids`, read
  by the primary key's index."
  [db table ids]
  (into {} (map (juxt :id identity)) (select-in db table "*" :id (pk-index table) ids)))

(defn junction-token-ids-of
  "Map of row id to its token ids in order, for rows `ids` of `table`
  (`:spans`, `:vocab_links`), read from its junction table by its primary
  key. A row with no tokens is absent."
  [db table ids]
  (let [[jtable jcol] (junction table)
        rows (select-in db jtable (str (name jcol) ", token_id, order_idx") jcol (pk-index jtable) ids)]
    (->> rows
         (group-by jcol)
         (into {} (map (fn [[id rs]] [id (mapv :token_id (sort-by :order_idx rs))]))))))

(defn delete-entity-metadata!
  "Delete the `entity_metadata` rows of the `entity-type` entities `ids`, by
  that table's primary key. Unaudited: see the callers."
  [tx entity-type ids]
  (in-chunks (fn [chunk]
               (psc/execute! tx (into [(str "DELETE FROM entity_metadata INDEXED BY "
                                            (pk-index :entity_metadata)
                                            " WHERE entity_type = ? AND entity_id IN ("
                                            (placeholders (count chunk)) ")")
                                       entity-type]
                                      (map str chunk)))
               nil)
             ids)
  nil)

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
  `update-by-id!` contract and keeps no-op updates out of the audit log."
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
  "Apply per-id attribute updates, one UPDATE statement per chunk of ids.

  `pairs` is a sequence of `[id attrs-map]`. Audit rows are written in
  that order, so a caller controls it (sort by source position, say, so
  the audit log reflects document order).

  The new values travel as a VALUES table joined on the id
  (`UPDATE t SET col = v.columnN FROM (VALUES (?, ?, ...), ...) AS v
  WHERE t.id = v.column1`), so each row costs one index lookup. A
  `CASE WHEN id = ? THEN ?` per column, as this helper used before, is
  scanned for every row it updates, and a chunk cost its size squared:
  a thousand-edit text update spent 16 s here under the write lock.

  Rows may supply different columns. A column some row of the chunk
  leaves out gets a flag beside its value, and such a row keeps the
  column's existing value. Per-id no-ops (pre == post for the supplied
  attrs) are skipped from the audit log, matching `update-by-id!` /
  `merge*`.

  NOTE: values are written as given, so columns whose write path expects
  pre-serialized JSON (notably `:config`) must be serialized by the caller
  BEFORE handing the attrs map to this helper. A raw map would compare
  against the stored JSON string and read as a change on every row.

  Round-trip shape per chunk: 1 SELECT (pre-images) + 1 UPDATE with
  RETURNING * (post-images). Chunks the input to respect SQLite's
  SQLITE_MAX_VARIABLE_NUMBER (~32766) ceiling: each id contributes at most
  (2 * cols + 1) parameters to the statement.

  Returns a vector of post-image rows (across all chunks). Row order
  within each chunk follows the database's RETURNING order; audit row
  order is the deterministic order described above."
  ([tx table pairs]
   (bulk-update-by-id! tx table pairs {}))
  ([tx table pairs {:keys [id-col] :or {id-col :id}}]
   (psaw/ensure-op-bound!)
   (if (empty? pairs)
     []
     (let [pairs (vec pairs)
           ids (mapv first pairs)
           id->attrs (into {} pairs)
           ;; Union of columns supplied across all rows (in stable order).
           ;; A column no row supplies is not written at all.
           cols (vec (distinct
                      (filter (fn [col]
                                (some #(contains? (second %) col) pairs))
                              (mapcat (comp keys second) pairs))))
           max-rows-per-chunk (max 1 (long (/ 30000 (+ 1 (* 2 (max 1 (count cols)))))))
           chunks (partition-all (min psc/bulk-chunk-size max-rows-per-chunk) ids)
           qualified (keyword (str (name table) "." (name id-col)))]
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
                    (let [rows-ids (vec (distinct present-ids))
                          ;; Per column: whether every row of the chunk
                          ;; supplies it, else it carries a flag.
                          flagged (into #{}
                                        (remove (fn [col] (every? #(contains? (get id->attrs %) col) rows-ids)))
                                        cols)
                          ;; v.column1 is the id, then each column's value,
                          ;; each flagged one followed by its flag.
                          layout (loop [cols cols n 2 out []]
                                   (if-let [col (first cols)]
                                     (if (flagged col)
                                       (recur (rest cols) (+ n 2) (conj out [col n (inc n)]))
                                       (recur (rest cols) (inc n) (conj out [col n nil])))
                                     out))
                          vref (fn [n] (keyword (str "v.column" n)))
                          set-clause (into {}
                                           (map (fn [[col n f]]
                                                  [col (if f
                                                         [:case [:= (vref f) 1] (vref n) :else col]
                                                         (vref n))]))
                                           layout)
                          values (mapv (fn [id]
                                         (let [attrs (get id->attrs id)]
                                           (into [id]
                                                 (mapcat (fn [[col _ f]]
                                                           (let [has? (contains? attrs col)
                                                                 v (get attrs col)]
                                                             (if f [v (if has? 1 0)] [v]))))
                                                 layout)))
                                       rows-ids)
                          posts (psc/execute-returning! tx {:update table
                                                            :set set-clause
                                                            :from [[{:values values} :v]]
                                                            :where [:= qualified (vref 1)]
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

(defn delete-ids!
  "Delete the rows of `table` whose id is one of `ids` and audit each
  deletion, as `delete-where!` does over `[:in :id ids]`, but in chunks and
  by the primary key's index (see \"Index-driven reads and deletes\" above).
  Returns the deleted pre-images. An id with no row is skipped."
  [tx table ids]
  (psaw/ensure-op-bound!)
  (in-chunks (fn [chunk]
               (let [pres (psc/execute-returning!
                           tx (into [(str "DELETE FROM " (name table) " INDEXED BY " (pk-index table)
                                          " WHERE id IN (" (placeholders (count chunk)) ") RETURNING *")]
                                    (map str chunk)))]
                 (psaw/record-audit-writes! tx table :delete
                                            (map (fn [pre] [(:id pre) pre nil]) pres))
                 pres))
             ids))

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
