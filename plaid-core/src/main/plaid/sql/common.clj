(ns plaid.sql.common
  "Foundation helpers for the SQL port of plaid.xtdb2.

  Ids, JSON ser/de, timestamps, name validation, query execution, and the
  read primitives every entity namespace is built from.

  The pool and the transaction wrapper live in `plaid.sql.datasource`, the
  audit-capture machinery in `plaid.sql.audit-write`, and the audited row
  writers in `plaid.sql.crud`."
  (:require [clojure.data.json :as json]
            [clojure.string :as str]
            [honey.sql :as sql]
            [next.jdbc :as jdbc]
            [next.jdbc.result-set :as rs]
            [taoensso.timbre :as log]
            [plaid.server.config :refer [config]])
  (:import (java.security SecureRandom)
           (java.time Instant)
           (java.util UUID)))

;; ============================================================
;; UUIDs (stored as TEXT for portability)
;; ============================================================

(defn ->uuid
  "Coerce input to a java.util.UUID. Accepts UUIDs and uuid-shaped strings."
  ^UUID [x]
  (cond
    (instance? UUID x) x
    (string? x) (UUID/fromString x)
    :else (throw (ex-info "Cannot coerce to UUID" {:value x :code 400}))))

(defn uuid-str
  "Render a UUID (or already-string form) as the canonical lowercase string the schema uses."
  ^String [x]
  (cond
    (instance? UUID x) (.toString ^UUID x)
    (string? x) (str/lower-case x)
    :else (throw (ex-info "Cannot render UUID" {:value x :code 400}))))

(def ^:private ^SecureRandom secure-random
  "Shared CSPRNG for id generation. SecureRandom#nextLong is thread-safe
  (internally synchronized), so one instance suffices. Using a CSPRNG keeps
  the 74 random bits unguessable — same non-enumerability the old v4
  `UUID/randomUUID` gave us."
  (SecureRandom.))

(def ^:private mono
  "The last millisecond an id was minted in, and how many were minted in it.
  RFC 9562's monotonic counter: `rand_a`'s 12 bits count within the
  millisecond, so ids minted in one millisecond still sort in the order they
  were made."
  (atom {:ts 0 :seq 0}))

(def ^:private MAX-SEQ 0xFFF)

(defn new-uuid
  "Generate a fresh time-ordered UUIDv7 (RFC 9562): a 48-bit big-endian
  Unix-millisecond timestamp, a 12-bit counter within that millisecond, then
  62 random bits. Same 128-bit `java.util.UUID` shape and TEXT storage as the
  previous v4 generator - the only behavioral change is that ids minted close
  in time now sort close together, so inserts into the id / foreign-key
  B-tree indexes stay local instead of scattering randomly. Still
  non-enumerable (62 CSPRNG bits).

  The counter matters because every read is id-ordered: a bulk create mints
  its ids inside one millisecond, and with random low bits those rows came
  back shuffled, so which of two annotations on a token the editor showed was
  a coin flip. Counting within the millisecond makes id order creation order.
  A millisecond that mints more than 4096 ids borrows the next one, which
  keeps the order rather than repeating it.

  Ordering across PROCESSES is still only as good as their clocks, so a caller
  that needs a total commit order keys on `operations.ts` (see the strict
  monotonic ts logic above), not on the id.

  The SQL layer stores these as TEXT via the JDBC driver's UUID#toString
  rendering; reads coerce TEXT back to UUID in the q/q1 result builder (see
  `coerce-id-cols` below)."
  ^UUID []
  (let [{ts :ts counter :seq} (swap! mono
                                     (fn [{:keys [ts] n :seq}]
                                       (let [now (System/currentTimeMillis)]
                                         (cond
                                           (> now ts) {:ts now :seq 0}
                                           (< n MAX-SEQ) {:ts ts :seq (inc n)}
                                           ;; This millisecond is full: take
                                           ;; the next one rather than repeat
                                           ;; an order.
                                           :else {:ts (inc ts) :seq 0}))))
        lo (.nextLong secure-random)         ; supplies rand_b (62 bits)
        ;; msb: ts(48) | version(4)=0x7 | counter(12)
        msb (bit-or (bit-shift-left ts 16)
                    0x7000
                    (bit-and counter 0x0FFF))
        ;; lsb: variant(2)=0b10 | rand_b(62)
        lsb (bit-or (bit-shift-left 1 63)
                    (bit-and lo 0x3FFFFFFFFFFFFFFF))]
    (UUID. msb lsb)))

(def ^:private uuid-result-columns
  "SQL result keys whose schema meaning is always a UUID. Ambiguous string
  identifiers (`user_id`, `service_id`) are deliberately absent. Generated
  aliases must be declared through q's `:uuid-cols` option."
  #{:batch_id :document_id :entity_id :group_id :op_id :parent_token_layer_id
    :project_id :relation_layer_id :source_span_id :span_id :span_layer_id
    :target_span_id :text_id :text_layer_id :token_id :token_layer_id
    :vocab_item_id :vocab_layer_id :vocab_link_id})

(def ^:private string-id-columns
  "Schema columns that end in `_id` but intentionally contain application
  strings rather than UUIDs."
  #{:owner_user_id :service_id :user_id})

(defn- source-table [query]
  (letfn [(table-key [source]
            (cond
              (keyword? source) (keyword (name source))
              (sequential? source) (table-key (first source))
              :else nil))]
    (when (map? query)
      (or (table-key (:insert-into query))
          (table-key (:update query))
          (table-key (:delete-from query))
          (table-key (:from query))))))

(defn- uuid-result-column?
  [table row explicit-uuid-cols explicit-string-cols k]
  (and (not (contains? string-id-columns k))
       (not (contains? explicit-string-cols k))
       (or (contains? explicit-uuid-cols k)
           (contains? uuid-result-columns k)
           ;; Most entity tables use UUID primary keys; users.id is the one
           ;; intentionally string-valued primary key.
           (and (= k :id) (not= table :users))
           ;; audit_writes.target_id follows target_table's identity type.
           (and (= k :target_id)
                (not= "users" (:target_table row))))))

(defn- coerce-id-cols
  "Convert only explicitly UUID-bearing SQL result columns back to UUID.
  Free text is never converted based on its lexical shape."
  [query opts row]
  (when row
    (let [table (source-table query)
          explicit-uuid-cols (set (:uuid-cols opts))
          explicit-string-cols (set (:string-cols opts))]
      (persistent!
       (reduce-kv
        (fn [acc k v]
          (assoc! acc k
                  (if (and (string? v)
                           (uuid-result-column? table row explicit-uuid-cols explicit-string-cols k))
                    (try (UUID/fromString v) (catch IllegalArgumentException _ v))
                    v)))
        (transient {})
        row)))))

;; ============================================================
;; JSON helpers (config blobs, JSON-encoded scalar values, audit images)
;; ============================================================

(defn write-json
  "Serialize a Clojure value to a JSON string."
  ^String [v]
  (json/write-str v))

(defn read-json
  "Parse a JSON string back into Clojure data. Returns nil on nil input."
  [s]
  (when (some? s)
    (json/read-str s :key-fn keyword)))

(defn validate-atomic-value!
  "A span's or relation's primary value is an atomic JSON scalar. `noun` is
  the capitalized entity name for the error message."
  [noun value]
  (when-not (or (nil? value) (string? value) (number? value) (boolean? value))
    (throw (ex-info (str noun " value must be atomic (string, number, boolean, or null)")
                    {:value value :code 400}))))

(defn parse-config
  "Read a :config column (JSON string) back into a Clojure map.
  Accepts nil/empty as {}. Keys are kept as STRINGS — config holds
  arbitrary user-supplied editor names whose casing must round-trip."
  [s]
  (cond
    (nil? s) {}
    (= s "") {}
    (string? s) (or (json/read-str s) {})
    (map? s) s
    :else {}))

(defn- sort-maps-deep
  "Recursively replace every map in `v` with a sorted-map so subsequent
  JSON serialization renders keys in a stable byte-for-byte order.
  Vectors / seqs preserve their existing order; non-collection scalars
  pass through unchanged."
  [v]
  (cond
    (map? v) (into (sorted-map)
                   (map (fn [[k vv]] [k (sort-maps-deep vv)]))
                   v)
    (sequential? v) (mapv sort-maps-deep v)
    :else v))

(defn- canonical-json
  "Render `v` to JSON with map keys sorted at every level. A stable
  serialization is load-bearing for the no-op update skip in
  `update-by-id!` / `merge*`: those compare the raw pre-image string
  against the post-image string, so any reordering of keys (e.g.
  hash-map vs array-map ordering, or `assoc`-induced repr flips) would
  defeat the skip and emit spurious audit rows."
  ^String [v]
  (json/write-str (sort-maps-deep v)))

(defn serialize-config
  "Render a config map as JSON for storage. Accepts nil as `{}`. Keys
  are sorted at every level (see `canonical-json`) so the same logical
  map always renders to the same byte string — required for the update
  helper no-op skip to detect a no-change write."
  ^String [m]
  (canonical-json (or m {})))

;; ============================================================
;; Time
;; ============================================================

(def ^:private iso-instant-9
  "ISO-8601 instant formatter with a FIXED 9 fractional digits. We can't
  use `Instant.toString` (the obvious choice): it omits the fractional
  part on an exact-second instant and varies the digit count otherwise,
  so its output does NOT lexicographically sort in temporal order —
  `\"...:00Z\"` (no fraction) sorts AFTER `\"...:00.999Z\"` because 'Z'
  (90) > '.' (46). As-of reconstruction (plaid.history.read) and keyset
  pagination compare these strings as SQLite TEXT, so a non-monotonic
  lex order would mis-order or skip rows. Fixed-width fractional digits
  make lex order == temporal order."
  (-> (java.time.format.DateTimeFormatterBuilder.)
      (.appendInstant 9)
      (.toFormatter)))

(defn instant->iso
  "Render an Instant as a fixed-width 9-digit ISO-8601 string. The
  canonical timestamp format for OLTP columns + the history cursor — fixed
  width so SQLite TEXT lex order matches temporal order (see
  `iso-instant-9`)."
  ^String [^Instant inst]
  (.format iso-instant-9 inst))

(defn now-iso
  "Current UTC instant rendered as an ISO-8601 string with fixed 9-digit
  fractional seconds (column-friendly AND lexicographically sortable —
  see `iso-instant-9`)."
  ^String []
  (instant->iso (Instant/now)))

;; Process-global strictly-monotonic high-water mark for `operations.ts`.
;; `nil` until lazily seeded from the DB on the first `next-monotonic-ts!`
;; call. See that fn for the why. (defonce takes no docstring arg.)
(defonce ^:private last-op-instant (atom nil))

(defn- seed-op-instant
  "Read the current `max(ts)` from `operations` so a fresh process never
  re-issues a ts at or below an already-committed one. Epoch when the
  table is empty."
  ^Instant [db]
  (let [row (jdbc/execute-one! db ["SELECT max(ts) AS mx FROM operations"]
                               {:builder-fn rs/as-unqualified-maps})
        mx (:mx row)]
    (if (and (string? mx) (not= "" mx))
      (Instant/parse mx)
      Instant/EPOCH)))

(defn next-monotonic-ts!
  "Return an ISO-8601 string for `operations.ts` that is STRICTLY greater
  than any value this process has previously returned, and never below
  wall clock.

  MUST be called from inside a write transaction (after `BEGIN
  IMMEDIATE` acquires the RESERVED lock), so that the in-process
  high-water mark advances in the same order writes commit. This is the
  load-bearing fix for the history-desync bug: `ts` used to be stamped
  BEFORE the write lock, so two concurrent writers could stamp ts out of
  commit order — and (ts, seq) order would no longer be commit order,
  which as-of reconstruction (plaid.history.read) depends on for the
  audit log to be a faithful serialization of what happened. Stamping
  under the lock + strict monotonicity makes commit order == ts order.

  Strict monotonicity (`max(now, last+1ns)`) covers the case where two
  commits land within a single clock tick: the keyset's `op.id`
  tiebreaker is a random UUID and does NOT match commit order, so equal
  ts values could still misorder pagination. Bumping by 1ns guarantees a
  total order on ts alone.

  The atom only coordinates within ONE JVM — correct for this
  single-process, single-SQLite-file deployment. (A second process
  against the same file would still serialize on the DB write lock and
  read the same wall clock, so cross-process ties are vanishingly rare;
  not a supported topology regardless.)"
  ^String [db]
  (when (nil? @last-op-instant)
    (compare-and-set! last-op-instant nil (seed-op-instant db)))
  (instant->iso
   (swap! last-op-instant
          (fn [^Instant prev]
            (let [now (Instant/now)]
              (if (.isAfter now prev) now (.plusNanos prev 1)))))))

;; ============================================================
;; Validation
;; ============================================================

(defn assert-valid-name!
  "Throws ex-info with :code 400 unless `s` passes the project-wide name
  length limits. Returns true when it does, which no caller reads.

  Call it inside a `submit-operation!` body: validation outside one does
  not get projected to a structured response."
  [s]
  (let [name-config (try (:plaid.sql.common/config config) (catch Exception _ nil))
        max-l (or (:max-name-length name-config) 500)
        min-l (or (:min-name-length name-config) 1)]
    (cond
      (not (string? s))
      (throw (ex-info "Name must be a string" {:code 400 :name s}))

      (> (count s) max-l)
      (throw (ex-info (str "Name is too long: maximum is " max-l ", got " (count s))
                      {:code 400 :length (count s) :max-length max-l}))

      (< (count s) min-l)
      (throw (ex-info (str "Name is too short: minimum is " min-l ", got " (count s))
                      {:code 400 :length (count s) :min-length min-l}))

      :else true)))

(defn err-msg-not-found [kind id]
  (str kind " not found with id `" id "`"))

(defn err-msg-already-exists [kind id]
  (str kind " creation failed: record already exists with id `" id "`"))

;; ============================================================
;; Query execution (HoneySQL + next.jdbc)
;; ============================================================

(def ^:private jdbc-opts
  "next.jdbc opts: return rows as plain maps with the original column names
  as keywords. Per-table mappers in plaid.sql.<entity> namespaces then
  translate column-keys to the namespaced API keys."
  {:builder-fn rs/as-unqualified-maps})

(defn format-sql
  "Render a HoneySQL map to a [sql-string & params] vector."
  [honeysql-map]
  (sql/format honeysql-map))

;; ----------------------------------------------------------------
;; Slow-query detection
;;
;; Every q/q1/execute*/execute-returning* call is wrapped in
;; `with-slow-query-warn`. When the wall-clock for a call exceeds
;; `*slow-query-threshold-ms*` (default 500ms) we log a `:warn`
;; carrying the rendered SQL (first 200 chars), the first 10
;; param values, and the elapsed ms. Below the threshold the
;; wrapper is a single `(System/nanoTime)` pair — no log, no map
;; allocation — so the fast path stays cheap.
;;
;; The threshold is a `^:dynamic` var rather than a config lookup
;; so callers (tests, perf probes, …) can rebind it without
;; touching the mount-state config. `plaid.server.sql/datasource`
;; may `alter-var-root` from config if an operator wants a
;; different default.
;; ----------------------------------------------------------------

(def ^:dynamic *slow-query-threshold-ms*
  "Wall-clock threshold (ms) above which `q`/`q1`/`execute!`/
  `execute-returning-one!`/`execute-returning!` emit a `:warn` with
  the rendered SQL + first 10 params. Rebind to disable (set to a
  very large number) or to tune per-call."
  500)

(defn- truncate-sql ^String [^String s]
  (if (> (.length s) 200)
    (str (subs s 0 200) " ...[truncated]")
    s))

(defn emit-slow-query-warn!
  "Emit the slow-query `:warn` log line. Pulled out as a top-level
  function (rather than an inline `log/warn` call) so tests can
  `with-redefs` capture the call — `log/warn` itself is a macro and
  cannot be redefed."
  [elapsed-ms sql-vec]
  (let [sql-str (truncate-sql (str (first sql-vec)))
        params (vec (take 10 (rest sql-vec)))]
    (log/warn (format "Slow query: %.1fms — %s — params: %s"
                      elapsed-ms sql-str (pr-str params)))))

(defn- with-slow-query-warn
  "Time `body-fn` and emit a `:warn` if the elapsed wall-clock exceeds
  `*slow-query-threshold-ms*`. `sql-vec` is the [sql & params] form
  that was about to execute. Returns whatever `body-fn` returned.
  Uses try/finally so the timing log still fires when `body-fn`
  throws — without it, the slow-query signal would silently disappear
  exactly on the queries most likely to need diagnostics (constraint
  violations, lock timeouts, long-running statements aborted by busy
  timeout, etc.)."
  [sql-vec body-fn]
  (let [start (System/nanoTime)]
    (try
      (body-fn)
      (finally
        (let [elapsed-ms (/ (- (System/nanoTime) start) 1000000.0)]
          (when (> elapsed-ms (double *slow-query-threshold-ms*))
            (emit-slow-query-warn! elapsed-ms sql-vec)))))))

(defn q
  "Run a read query. `db` may be a DataSource or a Connection (inside a tx).
  `query` may be a HoneySQL map or a [sql & params] vector.
  Returned rows have explicitly UUID-bearing schema columns coerced back to
  UUID. Generated aliases can be declared with `opts :uuid-cols`; ambiguous
  identifiers can be protected with `:string-cols`. Remaining opts are merged
  into next.jdbc options — notably `:timeout` (seconds)."
  ([db query] (q db query nil))
  ([db query opts]
   (let [sql-vec (if (map? query) (format-sql query) query)
         jdbc-query-opts (dissoc opts :uuid-cols :string-cols)]
     (with-slow-query-warn
       sql-vec
       (fn [] (mapv #(coerce-id-cols query opts %)
                    (jdbc/execute! db sql-vec (merge jdbc-opts jdbc-query-opts))))))))

(defn q1
  "Run a read query and return the first row (coerced), or nil."
  ([db query] (first (q db query)))
  ([db query opts] (first (q db query opts))))

(defn execute!
  "Run a write query (INSERT/UPDATE/DELETE). Returns the update count.
  Accepts the same shapes as `q`."
  [db query]
  (let [sql-vec (if (map? query) (format-sql query) query)]
    (with-slow-query-warn
      sql-vec
      (fn []
        (let [result (jdbc/execute-one! db sql-vec)]
          ;; SQLite returns {:next.jdbc/update-count n}; we just hand it back.
          (or (:next.jdbc/update-count result) 0))))))

(defn execute-returning-one!
  "Run an INSERT/UPDATE/DELETE that uses `RETURNING *` (or another :returning
  shape) and return the single coerced row, or nil if no row was affected.
  Use for the single-row audited write helpers (insert!, update-by-id!,
  delete-by-id!, merge*)."
  [db query]
  (let [sql-vec (if (map? query) (format-sql query) query)]
    (with-slow-query-warn
      sql-vec
      (fn [] (coerce-id-cols query nil (jdbc/execute-one! db sql-vec jdbc-opts))))))

(defn execute-returning!
  "Run an INSERT/UPDATE/DELETE that uses `RETURNING *` and return a vector of
  coerced rows. Use for the bulk audited write helpers (insert-many!,
  delete-where!)."
  [db query]
  (let [sql-vec (if (map? query) (format-sql query) query)]
    (with-slow-query-warn
      sql-vec
      (fn [] (mapv #(coerce-id-cols query nil %)
                   (jdbc/execute! db sql-vec jdbc-opts))))))

;; ============================================================
;; Read primitives
;;
;; `table` is a keyword like :tokens. `id-col` defaults to :id.
;; Returned rows are raw column-keyed maps; per-entity namespaces wrap
;; these with their own row->entity mappers.
;; ============================================================

(defn fetch-by-id
  "SELECT * FROM <table> WHERE <id-col> = ?. Returns the row or nil."
  ([db table id]
   (fetch-by-id db table :id id))
  ([db table id-col id]
   (q1 db {:select [:*] :from [table] :where [:= id-col id]})))

(defn fetch-where
  "SELECT * FROM <table> WHERE <attrs>. attrs is a column-keyed map.
  Vector values produce IN clauses; scalar values use `=`."
  [db table attrs]
  (q db {:select [:*]
         :from [table]
         :where (into [:and]
                      (map (fn [[k v]]
                             (cond
                               (sequential? v) [:in k v]
                               (nil? v) [:= k nil]
                               :else [:= k v]))
                           attrs))}))

(def bulk-chunk-size
  "Rows per statement for any helper handed an arbitrarily-sized collection
  of ids or rows.

  SQLite-jdbc 3.50.x ships SQLite >= 3.46, which sets
  SQLITE_MAX_VARIABLE_NUMBER = 32766. Multi-row INSERTs and IN-list
  SELECTs build one `?` per parameter, so the collection has to be
  chunked to stay under that ceiling. 4000 rows per chunk: with the
  widest current row shape (~7 columns) that's <28000 parameters per
  statement, leaving headroom for any extra `?`s the HoneySQL formatter
  slips in (e.g. a WHERE clause appended to a bulk SELECT). A single
  `IN (?,?,...)` over the same chunk is well inside the limit.

  Read by `plaid.sql.crud` too, which chunks the bulk writers against the
  same ceiling."
  4000)

(defn fetch-ids
  "Batch-fetch rows by ID. Returns a vector of rows (column-keyed maps).
  Chunks the IN-list to stay under SQLite's variable-count ceiling."
  ([db table ids]
   (fetch-ids db table :id ids))
  ([db table id-col ids]
   (if (empty? ids)
     []
     (into []
           (mapcat (fn [chunk]
                     (q db {:select [:*]
                            :from [table]
                            :where [:in id-col (vec chunk)]})))
           (partition-all bulk-chunk-size ids)))))

(defn fetch-ids-as-map
  "Like fetch-ids but returns a map of id → row for lookups."
  ([db table ids]
   (fetch-ids-as-map db table :id ids))
  ([db table id-col ids]
   (into {} (map (juxt id-col identity)) (fetch-ids db table id-col ids))))

(defn document-version
  "`documents.version` for one id, nil when there is no such document. The
  OCC pre-flight in `wrap-document-version` asks this of every write that
  carries a `?document-version=`."
  [db doc-id]
  (:version (q1 db {:select [:version]
                    :from [:documents]
                    :where [:= :id doc-id]})))

(defn document-versions
  "Map of document id → `documents.version`, for the ids that exist. One
  SELECT per chunk of ids, whatever the caller's count.

  Every write response answers this question about the documents it touched
  (`X-Document-Versions`, so a strict client knows the version to send next).
  Asking `plaid.sql.document/get` instead paid for a walk of the whole media
  directory and a metadata query per document, on every one of them."
  [db doc-ids]
  (if (empty? doc-ids)
    {}
    (into {}
          (comp (mapcat (fn [chunk]
                          (q db {:select [:id :version]
                                 :from [:documents]
                                 :where [:in :id (vec chunk)]})))
                (map (juxt :id :version)))
          ;; `seq` first: `(distinct some-set)` throws in Clojure 1.12 (a
          ;; `distinct` fast-path bug — `nth` is not supported on a
          ;; PersistentHashSet), and callers pass whatever shape they have.
          ;; `submit-operation!` hands back a set of affected documents.
          (partition-all bulk-chunk-size (distinct (seq doc-ids))))))

(defn next-order-idx-expr
  "Returns a HoneySQL scalar-subquery fragment that resolves at INSERT
  time to `MAX(order_idx) + 1` over `table` filtered by `where-clause`,
  or 0 if no rows match. Use as the value of `:order_idx` inside the
  `:values` map of a HoneySQL INSERT — the subquery runs inside the
  same statement, eliminating the SELECT-then-INSERT race that
  separate `MAX` + INSERT had.

  Pair with a `UNIQUE (<parent_id>, order_idx)` constraint on `table`
  so that the (vanishingly rare) case where SQLite's BEGIN IMMEDIATE
  lock fails to serialize two writers still surfaces as a constraint
  violation rather than a duplicate ordinal."
  [table where-clause]
  {:select [[[:+ [:coalesce [:max :order_idx] -1] 1]]]
   :from [table]
   :where where-clause})
