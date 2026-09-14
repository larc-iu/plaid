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

(defn new-uuid
  "Generate a fresh time-ordered UUIDv7 (RFC 9562): a 48-bit big-endian
  Unix-millisecond timestamp in the high bits, then 74 random bits. Same
  128-bit `java.util.UUID` shape and TEXT storage as the previous v4
  generator — the only behavioral change is that ids minted close in time
  now sort close together, so inserts into the id / foreign-key B-tree
  indexes stay local instead of scattering randomly. Still non-enumerable
  (74 CSPRNG bits). Sub-millisecond ties are unordered (random low bits, no
  monotonic counter) — callers that need a total commit order key on
  `operations.ts`, not on the id (see the strict-monotonic ts logic above).

  The SQL layer stores these as TEXT via the JDBC driver's UUID#toString
  rendering; reads coerce TEXT back to UUID in the q/q1 result builder (see
  `coerce-id-cols` below)."
  ^UUID []
  (let [ts  (System/currentTimeMillis)        ; 48-bit Unix ms timestamp
        hi  (.nextLong secure-random)         ; supplies rand_a (12 bits)
        lo  (.nextLong secure-random)         ; supplies rand_b (62 bits)
        ;; msb: ts(48) | version(4)=0x7 | rand_a(12)
        msb (bit-or (bit-shift-left ts 16)
                    0x7000
                    (bit-and hi 0x0FFF))
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
;; Audit-capture dynamic var
;;
;; submit-operation! binds *op* to a map holding the current operation id
;; (and other context). Per-row write helpers (insert!, update!, delete!)
;; check it and emit audit_writes rows automatically. When *op* is unbound
;; the helpers FAIL FAST (see ensure-op-bound!) — every production write
;; goes through submit-operation!, including bootstrap admin creation.
;; ============================================================

(def ^:dynamic *op*
  "Current operation context inside submit-operation!. nil when no op is active.
  Keys: :id, :ts, :tx (the JDBC Connection that's part of the tx),
  :seq-counter (atom holding the next audit-write ordinal within this op),
  :affected-documents (atom; docs whose version the body bumps — see
  plaid.sql.operation).

  The ::skip sentinel deliberately bypasses auditing. NOTHING uses it
  today — every write, including bootstrap admin creation, goes through
  submit-operation! and is audited. It exists only as a deliberate,
  greppable escape hatch for a future write that genuinely must not be
  audited; think hard before becoming its first caller (the audit log
  is the history replica's replay source)."
  nil)

(def ^:dynamic *expected-document-version*
  "Optimistic-concurrency expected document version, parsed from the
  HTTP `?document-version=<int>` query parameter by
  `plaid.rest-api.v1.middleware/wrap-document-version`.

  Bound around the handler invocation so that the in-tx OCC check
  inside `plaid.sql.operation/submit-operation*` runs atomically with
  the write — closing the TOCTOU window that existed when the
  middleware did the version comparison before the handler opened
  its write tx (task #108).

  nil when no expected version was supplied (or when running outside
  the REST middleware stack, e.g. from tests calling SQL helpers
  directly)."
  nil)

(def ^:dynamic *batch-validated-document-versions*
  "Per-atomic-batch map of document id to the client version already
  validated for that document. Batch sub-requests run sequentially in one
  transaction, so subsequent writes for the same document intentionally
  skip repeating the original OCC check after earlier sub-requests have
  advanced its version. nil outside the batch endpoint."
  nil)

(defn- ensure-op-bound!
  "Fail-fast guard for the audited write helpers. Throws ex-info with
  :code 500 BEFORE any SQL executes if *op* is nil — without this,
  calling a write helper outside submit-operation! with a DataSource
  would commit the write in autoCommit mode before the audit attempt
  even fires (and then `record-audit-write!` would throw, but the row
  is already on disk).

  Permitted *op* values:
    - a map (the normal op context, with :id, :ts, :seq-counter, …), or
    - the ::skip sentinel (an unused-but-deliberate audit bypass — see
      the *op* docstring).
  Any other value (nil, a stray scalar) trips the guard."
  []
  (when (or (nil? *op*)
            (and (not (map? *op*))
                 (not= ::skip *op*)))
    (throw (ex-info "write helper called outside submit-operation!"
                    {:code 500
                     :message "write helper called outside submit-operation!"}))))

(def audit-change-types
  "The full set of `change_type` values that may appear in audit_writes.
  Kept in sync with the CHECK constraint in the initial-schema migration.

  - :insert / :update / :delete — row-level writes captured by the
    audit helpers (insert!, update-by-id!, delete-by-id!, merge*).
  - :doc-version-bump — sentinel for the post-body `documents.version`
    increment emitted by `plaid.sql.operation/bump-document-version!`.
    Distinguished from a normal :update so ETL change-tracking on
    document bodies can ignore the per-op version bump without missing
    user-initiated `:document/update` rows. Still applied during replay
    (carries pre/post images with the version + modified_at transition)."
  #{:insert :update :delete :doc-version-bump})

(def doc-version-bump-change-type
  "Sentinel `change_type` for the per-op documents.version bump. See
  `audit-change-types`."
  :doc-version-bump)

;; ----------------------------------------------------------------
;; Post-image-only audit log + the synthetic-parent-row pattern
;; (tasks #28 / #34 / #58)
;;
;; POST-IMAGE ONLY: an audit row stores the full post-image of the
;; touched row and NOT a pre-image. The prior post-image of the same
;; entity IS its pre-image, so storing both was pure redundancy — it
;; only existed for the (since-removed) XTDB ETL replica. `pre_image`
;; is therefore left NULL on every row written after this change
;; (the column is retained for back-compat / forensic spelunking of
;; old rows; new rows don't populate it). The as-of reader uses only
;; post-images (`plaid.history.read`). A `:delete` row consequently
;; carries NO image at all (post is nil): the as-of fold treats a
;; delete as "entity absent at T", which needs no image. Callers
;; still compute the pre-image transiently — for no-op detection
;; (skip the audit when pre == post) and to stamp `document_id` on
;; delete rows.
;;
;; SYNTHETIC-PARENT-ROW: several mutations don't live as a single row
;; write on the parent table but conceptually belong to one parent
;; entity — e.g. the `span_tokens` junction (a span's ordered token
;; list) or `entity_metadata` (wide-narrow KV rows keyed on
;; entity_type+entity_id). To reconstruct the parent after a junction
;; mutation we emit ONE synthetic audit_writes row against the parent
;; table whose POST-image carries the parent row PLUS the junction
;; state folded under a well-known key (`:tokens`, `:metadata`,
;; `:readers`, `:maintainers`, ...). A `:delete` of the parent needs
;; no fold — the deletion implies the junction state is gone.
;; ----------------------------------------------------------------

;; The batched INSERT specifies 9 columns per row (every audit column
;; except the never-written `pre_image`), so each row contributes 9
;; placeholders. Chunk at 3000 rows (27000 params) to stay under SQLite's
;; SQLITE_MAX_VARIABLE_NUMBER (32766). (The general `bulk-chunk-size` of
;; 4000 is sized for ~7-column rows; it is also defined later in the file.)
(def ^:private audit-bulk-chunk-size 3000)

(defn- reserve-seqs!
  "Reserve `n` consecutive per-op `:seq` ordinals from the op's counter
  atom and return the first reserved ordinal. The op is single-threaded
  inside submit-operation*, so the atom is just an in-memory counter — no
  real contention.

  Fallback for any old op shape that lacks `:seq-counter` (shouldn't happen
  in normal flow): start at 0. Callers still receive a distinct ordinal per
  row in a batch, so the UNIQUE(op_id, seq) constraint in audit_writes holds
  even on that path."
  [op n]
  (if-let [c (:seq-counter op)]
    (let [start @c] (swap! c + n) start)
    0))

(defn- audit-row-values
  "Build the column-keyed value map for one audit_writes row. Shared by the
  single-row (`record-audit-write!`) and batched (`record-audit-writes!`)
  entry points so the two stay identical except for how the INSERT is issued.

  `pre-image` is NOT persisted — the audit log is post-image-only (see the
  comment block above). It is still passed in because callers compute it for
  no-op detection (skip when pre == post) and because it supplies the
  `document_id` stamp for `:delete` rows (whose post-image is nil). The
  `pre_image` table column is left to default NULL."
  [op seq-n target-table target-id change-type pre-image post-image]
  {:id (new-uuid)
   :op_id (:id op)
   :seq seq-n
   :target_table (name target-table)
   :target_id target-id
   :change_type (name change-type)
   :post_image (some-> post-image write-json)
   ;; Per-row document attribution, from the row's OWN image — not the
   ;; op's :document, which is nil for multi-document cascade ops
   ;; (project/delete, vocab/delete) and was even once plain wrong
   ;; (pre-guard cross-document bulk-delete). This column is what as-of
   ;; reconstruction scopes by, so a missing stamp = a row invisible to
   ;; time travel. For `:delete` rows post is nil, so the stamp comes from
   ;; the pre-image — the one remaining reason we still take it as an arg.
   :document_id (or (:document_id post-image)
                    (:document_id pre-image)
                    (when (= (name target-table) "documents")
                      target-id))
   :ts (:ts op)})

(defn record-audit-write!
  "Emit an audit_writes row for `target-table`/`target-id` with the given
  change-type and post-image. `pre-image` is taken but NOT persisted (used
  only for no-op detection upstream and the delete-row `document_id` stamp —
  see `audit-row-values`). Requires *op* to be bound (or ::skip).

  Most callers should go through the higher-level `insert!`/`update-by-id!`/
  `delete-by-id!`/`merge*` helpers — those capture the post-image automatically
  from the row state. This raw entry point exists for the handful of writes
  whose meaningful change isn't a single row (e.g. span/set-tokens, where
  the change lives in the `span_tokens` junction table but conceptually
  belongs on the parent span's audit row). See the comment block above for
  the post-image-only log + synthetic-parent-row pattern.

  The per-op `:seq` ordinal is pulled from the counter atom in *op* so that
  every audit_writes row in the same op has a unique (op_id, seq) tuple.
  This is load-bearing for as-of ordering: all rows in one op share the same
  `:ts` (taken once in submit-operation*), so `seq` is what disambiguates
  the order of multiple writes to the same target row inside one op
  (e.g. bump-document-version! plus a body update on the same document).

  For high-volume same-table deletes/inserts prefer `record-audit-writes!`,
  which batches into chunked multi-row INSERTs."
  [tx target-table target-id change-type pre-image post-image]
  (ensure-op-bound!)
  (let [op *op*]
    (cond
      (nil? op)
      (throw (ex-info (str "Audited write to " target-table " " target-id
                           " outside of submit-operation!. Wrap the call, or pass"
                           " {:audit ::skip} for bootstrap-only writes.")
                      {:code 500 :target target-table :id target-id}))

      (= op ::skip)
      nil

      :else
      (jdbc/execute-one!
       tx
       (format-sql
        {:insert-into :audit_writes
         :values [(audit-row-values op (reserve-seqs! op 1)
                                    target-table target-id change-type
                                    pre-image post-image)]})))))

(defn record-audit-writes!
  "Batched form of `record-audit-write!` for many rows that share one
  `target-table` and `change-type`. `entries` is a seq of
  `[target-id pre-image post-image]` triples.

  Emits the audit rows as chunked multi-row INSERTs rather than one
  `jdbc/execute-one!` round-trip per row. The per-row path dominates large
  cascade deletes: a ~200-document project delete emits ~188k audit rows,
  i.e. ~188k serial INSERTs. Per-op `:seq` ordinals are reserved in
  `entries` order, so the result is identical to calling
  `record-audit-write!` once per entry — just far fewer round-trips.

  No-op when `entries` is empty or *op* is ::skip."
  [tx target-table change-type entries]
  (ensure-op-bound!)
  (let [op *op*
        entries (vec entries)]
    (cond
      (empty? entries) nil

      (nil? op)
      (throw (ex-info (str "Audited write to " target-table
                           " outside of submit-operation!. Wrap the call, or pass"
                           " {:audit ::skip} for bootstrap-only writes.")
                      {:code 500 :target target-table}))

      (= op ::skip)
      nil

      :else
      (let [start (reserve-seqs! op (count entries))
            rows (map-indexed
                  (fn [i [target-id pre-image post-image]]
                    (audit-row-values op (+ start i)
                                      target-table target-id change-type
                                      pre-image post-image))
                  entries)]
        (doseq [chunk (partition-all audit-bulk-chunk-size rows)]
          (jdbc/execute-one! tx (format-sql {:insert-into :audit_writes
                                             :values (vec chunk)})))))))

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

;; SQLite-jdbc 3.50.x ships SQLite >= 3.46, which sets
;; SQLITE_MAX_VARIABLE_NUMBER = 32766. Multi-row INSERTs and IN-list
;; SELECTs build one `?` per parameter, so any helper that takes an
;; arbitrarily-sized `ids` collection or `rows` collection has to
;; chunk to stay under that ceiling. We target ~4000 rows per chunk:
;; with the widest current row shape (~7 columns) that's <28000
;; parameters per statement, leaving headroom for any extra `?`s the
;; HoneySQL formatter slips in (e.g. a WHERE clause appended to a
;; bulk SELECT). A single `IN (?,?,...)` over the same chunk is well
;; inside the limit.
(def ^:private bulk-chunk-size 4000)

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
          (partition-all bulk-chunk-size (distinct doc-ids)))))

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

;; ============================================================
;; Write primitives with audit capture
;;
;; All entity-table mutations should go through these helpers so audit_writes
;; rows are populated uniformly. They require *op* to be bound (i.e. you are
;; inside submit-operation!) — calls outside that context throw. The bootstrap
;; path (e.g. admin-user creation at startup) opts out by `(binding [*op* ::skip] ...)`.
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
   (ensure-op-bound!)
   (let [id (get row id-col)]
     (when (nil? id)
       (throw (ex-info "insert! requires the row to carry its primary key"
                       {:table table :id-col id-col :code 500})))
     (let [post (execute-returning-one! tx {:insert-into table
                                            :values [row]
                                            :returning [:*]})]
       (record-audit-write! tx table id :insert nil post)
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
   (ensure-op-bound!)
   (let [pre (fetch-by-id tx table id-col id)]
     (when (some? pre)
       (let [post (execute-returning-one! tx {:update table
                                              :set attrs
                                              :where [:= id-col id]
                                              :returning [:*]})]
         (when (not= pre post)
           (record-audit-write! tx table id :update pre post))
         post)))))

;; ============================================================
;; Comment sweep (unaudited side-table cleanup)
;; ============================================================

(defn delete-by-id!
  "Delete a row by id. Returns the pre-image row (handy for cascade callers),
  or nil if no row matched. No-ops (does not audit) if the row doesn't exist.
  Single round-trip: `DELETE ... RETURNING *` simultaneously deletes the row,
  reports existence, and yields the pre-image for the audit row."
  ([tx table id]
   (delete-by-id! tx table id {}))
  ([tx table id {:keys [id-col] :or {id-col :id}}]
   (ensure-op-bound!)
   (let [pre (execute-returning-one! tx {:delete-from table
                                         :where [:= id-col id]
                                         :returning [:*]})]
     (when (some? pre)
       (record-audit-write! tx table id :delete pre nil)
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
   (ensure-op-bound!)
   (let [pre (fetch-by-id tx table id-col id)]
     (when (nil? pre)
       (throw (ex-info (err-msg-not-found (or not-found-kind (name table)) id)
                       {:id id :code 404})))
     (let [post (execute-returning-one! tx {:update table
                                            :set attrs
                                            :where [:= id-col id]
                                            :returning [:*]})]
       (when (not= pre post)
         (record-audit-write! tx table id :update pre post))
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
  (ensure-op-bound!)
  (if (empty? rows)
    0
    (let [rows (vec rows)
          chunks (partition-all bulk-chunk-size rows)]
      (doseq [chunk chunks]
        (let [posts (execute-returning! tx {:insert-into table
                                            :values (vec chunk)
                                            :returning [:*]})]
          (record-audit-writes! tx table :insert
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
  does not call `serialize-config` on its own — pass the raw map and
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
   (ensure-op-bound!)
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
           chunks (partition-all (min bulk-chunk-size max-rows-per-chunk) ids)]
       (into []
             (mapcat
              (fn [chunk-ids]
                (let [chunk-ids (vec chunk-ids)
                      ;; Pre-image SELECT for the chunk.
                      pres (q tx {:select [:*]
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
                          posts (execute-returning! tx {:update table
                                                        :set set-clause-with-else
                                                        :where [:in id-col present-ids]
                                                        :returning [:*]})
                          post-by-id (into {} (map (juxt id-col identity)) posts)]
                      ;; One audit row per id (in input order), skipping
                      ;; no-ops where pre == post.
                      (record-audit-writes!
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
   (ensure-op-bound!)
   (let [pres (execute-returning! tx {:delete-from table
                                      :where where-clause
                                      :returning [:*]})]
     (record-audit-writes! tx table :delete
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
  (execute! tx {:insert-into table :values [row]}))

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
  (execute! tx {:insert-into table
                :values [row]
                :on-conflict []
                :do-nothing []}))

(defn remove-join!
  "DELETE from a join table by column-keyed where map. Idempotent.
  Does not audit (see add-join!)."
  [tx table where-map]
  (execute! tx {:delete-from table :where (where-map->vector where-map)}))
