(ns plaid.sql.common
  "Foundation helpers for the SQL port of plaid.xtdb2.

  Connection management, transaction helpers, JSON ser/de, name validation,
  read/write primitives, and the audit-capture machinery that hooks into
  the per-row write helpers via the *op* dynamic var.

  See /home/luke/.claude/plans/sigh-makes-me-sad-drifting-island.md for the
  port's design rationale."
  (:require [clojure.data.json :as json]
            [clojure.string :as str]
            [honey.sql :as sql]
            [next.jdbc :as jdbc]
            [next.jdbc.result-set :as rs]
            [taoensso.timbre :as log]
            [plaid.server.config :refer [config]])
  (:import (com.zaxxer.hikari HikariConfig HikariDataSource)
           (java.security SecureRandom)
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

(def ^:private uuid-shape-pattern
  "Canonical 8-4-4-4-12 hex with hyphens (lowercase or uppercase).
  Tight enough to avoid coercing arbitrary text that happens to be 36
  chars long."
  #"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

(defn- uuid-shaped-string?
  "True iff `s` is a String matching the canonical UUID lexical form
  (8-4-4-4-12 hex with hyphens)."
  [s]
  (and (string? s)
       (= 36 (.length ^String s))
       (boolean (re-matches uuid-shape-pattern s))))

(def ^:private known-string-columns
  "Columns that ALWAYS carry user-supplied free text and must NEVER be
  coerced to UUID by `coerce-id-cols`, even when a value happens to
  match the canonical UUID lexical form (36-char hex-with-hyphens).
  Rationale: the slow-path regex check in `coerce-id-cols` is keyed off
  value shape, not column name; without this allowlist a `:username`
  whose chars line up could come back as a UUID, breaking equality
  against the original string. The set covers the free-text columns
  currently present in the schema:
    - :username, :name, :form    — user-chosen identifiers / labels
    - :body                      — text body (could be any 36 chars)
    - :value                     — JSON-encoded span value
    - :password_hash             — bcrypt output (variable length but
                                   keep it on the allowlist as a guard)
  Add new free-text columns here if/when the schema grows them."
  #{:username :name :form :body :value :password_hash})

(defn- coerce-id-cols
  "Convert TEXT-encoded UUID columns back to java.util.UUID, since the
  SQL schema stores UUIDs as TEXT.

  Strategy: a string value is coerced when EITHER (a) its key is `:id`
  or ends with `_id` (fast path — covers the common case and column
  aliases that follow the naming convention), OR (b) the value itself
  matches the canonical UUID lexical form (slow path — needed because
  HoneySQL aliases like `[:pv.project_id :pid]` come back keyed as
  `:pid`, losing the `_id` suffix).

  Non-string values pass through unchanged; strings that don't match
  on either path pass through too.

  Safety review: the regex is tight (8-4-4-4-12 hex with hyphens, 36
  chars exactly), so it won't false-positive on the intentionally-
  string columns currently in the schema: users.password_hash (long),
  entity_metadata.value (JSON), span.value (JSON), documents.name,
  projects.name, text.body, vocab_items.form. If a future free-text
  column could plausibly contain a 36-char hex-with-hyphens string,
  callers should rename the column away from `_id` AND wrap reads so
  the coercion doesn't bite."
  [row]
  (when row
    (persistent!
     (reduce-kv
      (fn [acc k v]
        (assoc! acc k
                (if (string? v)
                  (cond
                    ;; Fast path: key shape says \"this is an id column\".
                    (or (= k :id)
                        (.endsWith ^String (name k) "_id"))
                    (try (UUID/fromString v) (catch IllegalArgumentException _ v))
                    ;; Opt-out: columns known to carry free-text values
                    ;; never get UUID-coerced even on a regex match,
                    ;; because a user-supplied 36-char hex-with-hyphens
                    ;; would otherwise come back as a UUID and break
                    ;; equality / serialization downstream.
                    (contains? known-string-columns k)
                    v
                    ;; Slow path: aliased column whose key dropped the
                    ;; `_id` suffix. Regex-gate before UUID/fromString.
                    (uuid-shaped-string? v)
                    (try (UUID/fromString v) (catch IllegalArgumentException _ v))
                    :else v)
                  v)))
      (transient {})
      row))))

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

(defn valid-name?
  "Returns true if `s` passes the project-wide name length limits.
  Throws ex-info with :code 400 otherwise (matches the v2 contract)."
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
;; Connection / datasource management
;; ============================================================

(def default-pool-config
  "Defaults baked into `build-datasource` when the caller passes no
  override. Mirror these under [database] in resources/config.toml so
  operators can see the available pool/PRAGMA knobs."
  {:max-pool-size 10
   :connection-timeout-ms 30000
   :busy-timeout-ms 5000
   :journal-mode "WAL"
   :synchronous "NORMAL"})

(def ^:private valid-journal-modes
  #{"delete" "truncate" "persist" "memory" "wal" "off"})

(def ^:private synchronous-levels
  "PRAGMA synchronous name → the integer SQLite reports back."
  {"off" 0 "normal" 1 "full" 2 "extra" 3
   "0" 0 "1" 1 "2" 2 "3" 3})

(defn- read-pragmas
  [^javax.sql.DataSource ds]
  (with-open [c (.getConnection ds)
              st (.createStatement c)]
    (let [pragma (fn [p]
                   (let [rs (.executeQuery st (str "PRAGMA " p))]
                     (.next rs)
                     (.getObject rs 1)))]
      {:foreign-keys (long (pragma "foreign_keys"))
       :journal-mode (str/lower-case (str (pragma "journal_mode")))
       :synchronous (long (pragma "synchronous"))
       :busy-timeout (long (pragma "busy_timeout"))})))

(defn- verify-pragmas!
  "Read the PRAGMAs back off a pooled connection and fail loudly if any
  didn't take. A bad PRAGMA value is a silent no-op at the SQLite level
  (`PRAGMA journal_mode = wal2` just returns the current mode), so
  trusting the write path is not enough — this read-back catches both
  bad values and any regression in how the pragmas are delivered to the
  driver."
  [ds {:keys [journal-mode synchronous busy-timeout-ms in-memory?]}]
  (let [expected {:foreign-keys 1
                  ;; In-memory DBs can't change journal mode — SQLite
                  ;; pins it to "memory" regardless of what we request.
                  :journal-mode (if in-memory? "memory" (str/lower-case journal-mode))
                  :synchronous (synchronous-levels (str/lower-case (str synchronous)))
                  :busy-timeout (long busy-timeout-ms)}
        actual (read-pragmas ds)]
    (when (not= expected actual)
      (throw (ex-info (str "SQLite PRAGMA verification failed — pooled connections do not "
                           "have the configured pragmas. Expected " expected
                           ", got " actual)
                      {:expected expected :actual actual :code 500})))))

(defn build-datasource
  "Build a HikariCP DataSource for a SQLite database at the given path.
  `db-path` may be nil/empty for an in-memory database (used in tests).
  Ensures the parent directory exists for file-backed databases.

  Optional second arg `pool-config` is a map that overrides the
  defaults in `default-pool-config`. Recognized keys:
    - :max-pool-size           — Hikari maximumPoolSize (default 10)
    - :connection-timeout-ms   — Hikari connectionTimeout (default 30000)
    - :busy-timeout-ms         — SQLite `busy_timeout` PRAGMA (default 5000)
    - :journal-mode            — SQLite `journal_mode` PRAGMA (default \"WAL\")
    - :synchronous             — SQLite `synchronous` PRAGMA (default \"NORMAL\")
  Unknown keys are ignored; nil/missing keys take the default.

  Note on `transaction_mode=IMMEDIATE`: under WAL the default
  `BEGIN DEFERRED` gives snapshot isolation for readers but does NOT
  serialize writers — two concurrent writers can pass independent
  pre-flight checks against stale snapshots and the second to commit
  gets `SQLITE_BUSY_SNAPSHOT` (a different error code from
  `SQLITE_BUSY`, NOT retried by the `busy_timeout` PRAGMA). Telling
  sqlite-jdbc to issue `BEGIN IMMEDIATE` for every tx makes the
  driver acquire the RESERVED lock on tx start, so a second writer
  parks until the first commits (covered by `busy_timeout`). Reads
  via the autoCommit `q`/`q1` path don't open a tx and are
  unaffected. NB: setting `setTransactionIsolation(SERIALIZABLE)`
  is NOT a substitute — in sqlite-jdbc 3.50.x that only flips
  `PRAGMA read_uncommitted`, not the BEGIN command."
  (^HikariDataSource [db-path]
   (build-datasource db-path nil))
  (^HikariDataSource [db-path pool-config]
   (when (and (string? db-path) (not= "" db-path))
     (let [parent (some-> ^String db-path (java.io.File.) (.getParentFile))]
       (when parent (.mkdirs parent))))
   (let [cfg (merge default-pool-config (or pool-config {}))
         ;; Defensive coercion: env-var-fed configs commonly arrive as
         ;; strings (Aero's #int/#long tags handle the typed case; this
         ;; covers the untyped/raw-string case with a clear error message
         ;; rather than letting `long` throw ClassCastException downstream).
         coerce-numeric (fn coerce-numeric [k v]
                          (cond
                            (nil? v) nil
                            (number? v) (long v)
                            (string? v)
                            (try (Long/parseLong (str/trim ^String v))
                                 (catch NumberFormatException _
                                   (throw (ex-info
                                           (str k " must be numeric, got: " (pr-str v))
                                           {:key k :value v :code 500}))))
                            :else (throw (ex-info
                                          (str k " must be numeric, got: " (pr-str v))
                                          {:key k :value v :code 500}))))
         max-pool-size (some->> (:max-pool-size cfg)
                                (coerce-numeric :max-pool-size))
         connection-timeout-ms (some->> (:connection-timeout-ms cfg)
                                        (coerce-numeric :connection-timeout-ms))
         busy-timeout-ms (some->> (:busy-timeout-ms cfg)
                                  (coerce-numeric :busy-timeout-ms))
         journal-mode (let [jm (str (:journal-mode cfg))]
                        (when-not (contains? valid-journal-modes (str/lower-case jm))
                          (throw (ex-info (str ":journal-mode must be one of "
                                               (sort valid-journal-modes)
                                               ", got: " (pr-str jm))
                                          {:key :journal-mode :value jm :code 500})))
                        jm)
         synchronous (let [sv (str (:synchronous cfg))]
                       (when-not (contains? synchronous-levels (str/lower-case sv))
                         (throw (ex-info (str ":synchronous must be one of "
                                              "(off normal full extra), got: " (pr-str sv))
                                         {:key :synchronous :value sv :code 500})))
                       sv)
         in-memory? (or (nil? db-path) (= "" db-path))
         ;; URI form `file::memory:?cache=shared&mode=memory` names the
         ;; in-memory DB so multiple connections share state robustly.
         ;; The bare `:memory:` form would give each connection its own DB.
         jdbc-url (if in-memory?
                    "jdbc:sqlite:file::memory:?cache=shared&mode=memory&transaction_mode=IMMEDIATE"
                    (str "jdbc:sqlite:" db-path "?transaction_mode=IMMEDIATE"))
         max-pool (long max-pool-size)
         hc (doto (HikariConfig.)
              (.setJdbcUrl jdbc-url)
              (.setDriverClassName "org.sqlite.JDBC")
              ;; WAL mode allows concurrent readers alongside the single writer,
              ;; so a small pool is fine. busy_timeout gives SQLite room to retry the
              ;; writer lock before we surface SQLITE_BUSY to the caller; set Hikari's
              ;; connection timeout higher than that.
              (.setMaximumPoolSize max-pool)
              (.setConnectionTimeout (long connection-timeout-ms))
              (.setPoolName "plaid-sqlite")
              ;; PRAGMAs ride on connection properties (sqlite-jdbc reads
              ;; them into SQLiteConfig and applies per connection — same
              ;; channel as the URL's transaction_mode). Do NOT move these
              ;; to setConnectionInitSql: Hikari hands init SQL to the
              ;; driver as one Statement.execute, and sqlite-jdbc silently
              ;; drops everything after the first ';' — a multi-statement
              ;; init string applied only foreign_keys and never enabled
              ;; WAL. verify-pragmas! below guards this channel.
              (.addDataSourceProperty "foreign_keys" "on")
              (.addDataSourceProperty "journal_mode" journal-mode)
              (.addDataSourceProperty "synchronous" synchronous)
              (.addDataSourceProperty "busy_timeout" (str (long busy-timeout-ms))))]
     ;; In-memory SQLite lives only as long as at least one connection is open
     ;; to the named database. One pinned idle connection is enough to keep
     ;; the named in-memory DB alive across the pool's lifetime; pinning
     ;; minimumIdle = maximumPoolSize would force the pool to hold a fan-out
     ;; of connections it doesn't otherwise need (and would conflate the
     ;; "keep the DB alive" knob with the user-tunable "concurrent writers"
     ;; knob). Keep it to 1.
     (when in-memory?
       (.setMinimumIdle hc 1))
     (let [ds (HikariDataSource. hc)]
       (try
         (verify-pragmas! ds {:journal-mode journal-mode
                              :synchronous synchronous
                              :busy-timeout-ms busy-timeout-ms
                              :in-memory? in-memory?})
         ds
         (catch Throwable t
           (.close ds)
           (throw t)))))))

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
  Returned rows have TEXT `:id` / `*_id` columns coerced back to UUID.
  `opts` is merged into the next.jdbc options — notably `:timeout` (seconds),
  which sets a JDBC statement timeout to bound a runaway query."
  ([db query] (q db query nil))
  ([db query opts]
   (let [sql-vec (if (map? query) (format-sql query) query)]
     (with-slow-query-warn
       sql-vec
       (fn [] (mapv coerce-id-cols (jdbc/execute! db sql-vec (merge jdbc-opts opts))))))))

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
      (fn [] (coerce-id-cols (jdbc/execute-one! db sql-vec jdbc-opts))))))

(defn execute-returning!
  "Run an INSERT/UPDATE/DELETE that uses `RETURNING *` and return a vector of
  coerced rows. Use for the bulk audited write helpers (insert-many!,
  delete-where!)."
  [db query]
  (let [sql-vec (if (map? query) (format-sql query) query)]
    (with-slow-query-warn
      sql-vec
      (fn [] (mapv coerce-id-cols (jdbc/execute! db sql-vec jdbc-opts))))))

(defn with-tx*
  "Run `f` inside a JDBC transaction. `f` is called with a Connection.
  If `db` is already a Connection in an outer transaction (the REST batch
  handler's case), we DO NOT wrap with another with-transaction — next.jdbc's
  default behavior there would commit the underlying tx prematurely. Instead
  we run the body inline; the outer batch handler owns commit/rollback."
  [db f]
  (if (instance? java.sql.Connection db)
    (f db)
    (jdbc/with-transaction [tx db] (f tx))))

(defmacro with-tx
  "Execute body inside a JDBC transaction. Binds `tx-sym` to the Connection."
  [[tx-sym db] & body]
  `(with-tx* ~db (fn [~tx-sym] ~@body)))

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
