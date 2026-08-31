(ns plaid.sql.dialect
  "The one place SQLite and Postgres differ.

  SQLite is the default backend and the one every deployment has run on;
  Postgres is opt-in via `[database] backend = \"postgres\"`. The schema was
  written portable from day one (TEXT ids, TEXT ISO-8601 timestamps, INTEGER
  0/1 booleans, no engine-specific column types), so the overwhelming
  majority of the ~11k lines under `plaid.sql.*` are dialect-free HoneySQL
  that runs unchanged on both. What is NOT dialect-free lives here.

  ## Why a process-global and not a per-connection lookup

  A running server talks to exactly one database. Sniffing the dialect off
  every connection would cost a round trip (or a cached DatabaseMetaData
  read) on the hot path to answer a question that cannot change while the
  process lives. `plaid.sql.common/build-datasource` sets it once at
  startup. It is `^:dynamic` so a test can rebind it to inspect the SQL a
  dialect WOULD produce without standing up that backend.

  ## What actually differs

  * JSON. SQLite's JSON1 (`json_extract`, `json_group_array`) vs Postgres's
    `jsonb` operators. Both are used to read the JSON-encoded `:value` /
    `config` / `metadata` columns and to aggregate ordered token-id arrays.
  * Regex. SQLite has no REGEXP operator, so `plaid.sql.query.exec` registers
    a Java-`Pattern` UDF per query connection. Postgres has native `~`/`~*`.
  * Text ordering. SQLite compares TEXT with BINARY (byte) collation.
    Postgres uses the database collation, so the Postgres schema declares
    `COLLATE \"C\"` on every TEXT column to match. See the baseline
    migration in `resources/migrations-postgres`.
  * Write serialization. SQLite gives us a single writer for free via
    `BEGIN IMMEDIATE`; a great deal of check-then-write logic in
    `plaid.sql.*` is correct only because of it. Postgres does not, so
    `plaid.sql.common/with-tx*` takes a transaction-scoped advisory lock
    instead. See `advisory-lock-sql`.
  * Statement timeouts, busy/conflict error codes, backups, the WAL, and
    the single-instance file lock are all handled at their own call sites,
    each of which asks this namespace which backend it is talking to.

  ## Known behavioral divergences (not bugs, but the dialect floor)

  These are corners of the query language where the two engines cannot be
  made to agree without reimplementing one inside the other:

  1. Regex FLAVOR. Patterns are Java `java.util.regex` syntax and are
     validated as such at query-validation time. SQLite runs them through
     Java verbatim. Postgres runs them as POSIX AREs, which agree with Java
     on the common constructs (character classes, quantifiers, anchors,
     alternation, `\\d`/`\\w`/`\\s`, lookahead) but differ on a few: `\\b` is
     a word boundary in Java and a BACKSPACE in Postgres (which spells the
     boundary `\\y`), and named groups / possessive quantifiers are Java-only.
  2. `min`/`max` over a JSON-encoded `:value` that holds a STRING. Postgres
     projects aggregate sources as `numeric` (see `json-numeric`) so that
     `sum`/`avg` are exact, which makes a non-numeric value NULL and thus
     invisible to all four aggregates. SQLite returns the string."
  (:require [clojure.string :as str]
            [honey.sql :as sql]))

;; HoneySQL knows neither Postgres's regex operators nor its JSON path
;; operator, and `:~` / `:#>>` are not readable as keyword literals, so both
;; the registration and the keywords go through `keyword`. Registering an op
;; is global and idempotent, and it affects only expressions that actually use
;; these keywords, so the SQLite path is untouched.
(def ^:private op-regex (keyword "~"))
(def ^:private op-iregex (keyword "~*"))
(def ^:private op-json-path-text (keyword "#>>"))

(run! sql/register-op! [op-regex op-iregex op-json-path-text])

(def ^:dynamic *dialect*
  "`:sqlite` (default) or `:postgres`. Set once at startup by
  `plaid.sql.common/build-datasource`."
  :sqlite)

;; The dialect `set-dialect!` has committed to, or nil before the first call.
;; Separate from `*dialect*`'s root so a test that BINDS `*dialect*` (to inspect
;; the SQL a backend would produce) doesn't look like a second pin.
;; (defonce takes no docstring arg.)
(defonce ^:private pinned (atom nil))

(defn set-dialect!
  "Pin the process-wide dialect. Called from `build-datasource`; not for
  general use. Bind `*dialect*` in tests instead.

  Re-pinning the SAME dialect is fine (a mount restart, or `build-datasource`
  running after `plaid.server.sql` has already set it). CHANGING it throws:
  one process talks to one database, and a silent flip would leave every
  subsequent query emitting the other backend's SQL, which surfaces far
  downstream as a pile of unrelated-looking errors rather than at its cause.
  The way this actually happens is a test that builds its own SQLite
  datasource while the suite is running against Postgres. Those namespaces
  carry the `plaid.fixtures/sqlite-only` fixture."
  [d]
  (when-not (#{:sqlite :postgres} d)
    (throw (ex-info (str "Unknown SQL dialect: " (pr-str d)) {:dialect d :code 500})))
  (let [prev @pinned]
    (when (and prev (not= prev d))
      (throw (ex-info (str "SQL dialect is already pinned to " prev " and cannot be changed to " d
                           ". One process talks to one database. If this is a test that builds its"
                           " own SQLite datasource, give its namespace the"
                           " plaid.fixtures/sqlite-only fixture.")
                      {:pinned prev :requested d :code 500})))
    (reset! pinned d))
  (alter-var-root #'*dialect* (constantly d)))

(defn postgres? [] (= :postgres *dialect*))
(defn sqlite? [] (= :sqlite *dialect*))

(defn backend-name
  "Operator-facing name of the active backend, for log lines and errors."
  []
  (if (postgres?) "PostgreSQL" "SQLite"))

;; ============================================================
;; JSON reads
;;
;; Three decodings, not one, because SQLite's `json_extract` returns a
;; DYNAMICALLY typed value (a JSON number comes back as an INTEGER, a JSON
;; string as TEXT) and no single Postgres expression can do that, because a
;; SQL expression has exactly one type. So each call site says which of the
;; three things it actually wanted:
;;
;;   json-text     the value as TEXT. Regex matching, equality against
;;                 another decoded value, group-by keys.
;;   json-comparable / encode-comparable
;;                 a comparison against a literal (`=`, `<`, `>=`, …).
;;   json-numeric  a numeric aggregate source (sum/avg/min/max).
;;
;; On SQLite all three are the same `json_extract(col, '$')`; the split
;; costs nothing there.
;; ============================================================

(defn- sqlite-path
  "SQLite JSON1 `$`-path string from verbatim (case-sensitive) key segments.
  Always a BOUND parameter, never inlined, so a user-supplied metadata/config
  key cannot inject SQL."
  [segs]
  (str "$" (apply str (map #(str "." %) segs))))

(defn json-text
  "Decode the JSON scalar in `col` to TEXT. `segs` (optional) is a vector of
  verbatim, case-sensitive object keys to walk first. They are always passed as
  BOUND parameters, never inlined, so a user-supplied metadata/config key cannot
  inject SQL."
  ([col] (json-text col nil))
  ([col segs]
   (if (postgres?)
     (if (seq segs)
       (into [:jsonb_extract_path_text [:cast col :jsonb]] segs)
       ;; jsonb_extract_path_text has no zero-path arity; `#>> '{}'` is it.
       [op-json-path-text [:cast col :jsonb] [:inline "{}"]])
     [:json_extract col (sqlite-path segs)])))

(def ^:private type-rank
  "SQLite compares values across storage classes in a fixed order, NULL then
  numbers then text, and that order (not just the within-type comparison) is
  what a query like `[\"<\" ?v 100]` on a span layer holding both numbers and
  strings depends on.

  Postgres's `jsonb` has its own total order, and it is a DIFFERENT one:
  Null < String < Number < Boolean < Array < Object. Comparing raw jsonb would
  silently return the string-valued rows for that query. So an ordered
  comparison compares the pair `(rank, value)`, a row comparison that Postgres
  evaluates lexicographically, with `rank` reproducing SQLite's class order. Within one class the jsonb comparison then decides, which is
  numeric for numbers and collation-based for strings, exactly as SQLite does.

  This map is the Clojure-side half, for ranking a LITERAL whose type is known
  at compile time; `json-type-rank-sql` is the SQL-side half, for a column."
  {:null 0 :number 1 :string 2 :other 3})

(defn- literal-rank
  [v]
  (cond
    (nil? v) (:null type-rank)
    (number? v) (:number type-rank)
    (string? v) (:string type-rank)
    :else (:other type-rank)))

(defn- json-type-rank-sql
  [j]
  [:case
   [:= [:jsonb_typeof j] [:inline "null"]] [:inline (:null type-rank)]
   [:= [:jsonb_typeof j] [:inline "number"]] [:inline (:number type-rank)]
   [:= [:jsonb_typeof j] [:inline "string"]] [:inline (:string type-rank)]
   :else [:inline (:other type-rank)]])

(defn json-comparable
  "Decode the JSON scalar in `col` for a COMPARISON against a literal encoded
  by `encode-comparable`. Pair the two: they must produce the same shape.
  `segs` (optional) walks object keys first, as bound parameters.

  On Postgres this is the `(rank, jsonb)` pair described under `type-rank`,
  which orders identically to SQLite's dynamically-typed `json_extract`
  result. It compares and IN-matches identically too, since two pairs are
  equal exactly when their values are."
  ([col] (json-comparable col nil))
  ([col segs]
   (if (postgres?)
     (let [j (if (seq segs)
               (into [:jsonb_extract_path [:cast col :jsonb]] segs)
               [:cast col :jsonb])]
       [:composite (json-type-rank-sql j) j])
     [:json_extract col (sqlite-path segs)])))

(defn encode-comparable
  "Encode a literal for comparison against a `json-comparable` expression.
  `json-str` is the caller's JSON writer (`plaid.sql.common/write-json`),
  passed in rather than required so this namespace stays a leaf. The literal's
  type rank is known here in Clojure, so it is inlined rather than computed."
  [json-str v]
  (if (postgres?)
    [:composite [:inline (literal-rank v)] [:cast (json-str v) :jsonb]]
    v))

(defn json-numeric
  "Decode the JSON scalar in `col` as a NUMBER, for use as an aggregate
  source. Postgres yields NULL for a non-numeric value (which every one of
  sum/avg/min/max then ignores) rather than failing the whole query. See
  divergence 2 in the namespace docstring."
  ([col] (json-numeric col nil))
  ([col segs]
   (if (postgres?)
     (let [j (if (seq segs)
               (into [:jsonb_extract_path [:cast col :jsonb]] segs)
               [:cast col :jsonb])]
       [:case [:= [:jsonb_typeof j] [:inline "number"]]
        [:cast [op-json-path-text j [:inline "{}"]] :numeric]])
     [:json_extract col (sqlite-path segs)])))

(defn ordered-id-array-sql
  "A raw SQL fragment aggregating `id-col` into a JSON array TEXT value,
  ordered by `order-col`, skipping the NULLs a LEFT JOIN produces for a parent
  with no children. Returned as a string (not HoneySQL) because its two call
  sites in `plaid.sql.document` build their SQL by hand.

  Postgres's `json_agg` returns `json`, which pgjdbc hands back as a PGobject,
  and returns NULL (not `[]`) when the filter excludes every row, hence the
  cast and the COALESCE, which together make it behave like SQLite's
  `json_group_array`."
  [id-col order-col]
  (if (postgres?)
    (str "COALESCE((json_agg(" id-col " ORDER BY " order-col ") "
         "FILTER (WHERE " id-col " IS NOT NULL))::text, '[]')")
    (str "json_group_array(" id-col " ORDER BY " order-col ") "
         "FILTER (WHERE " id-col " IS NOT NULL)")))

;; ============================================================
;; Regex
;; ============================================================

;; `expr COLLATE "name"`, which HoneySQL has no construct for. The collation
;; name is a literal from this namespace (never user input), so splicing it
;; into the identifier position is safe, and the operand keeps its parameters.
(sql/register-fn!
 :collate
 (fn [_ [expr collation]]
   (let [[sql & params] (sql/format-expr expr)]
     (into [(str sql " COLLATE \"" collation "\"")] params))))

(defn regex-match
  "Match `col` against Java-regex `pattern`, optionally case-insensitively.

  SQLite has no REGEXP operator, so `plaid.sql.query.exec` registers a
  `REGEXP(pattern, value)` UDF backed by `java.util.regex` on each query
  connection; HoneySQL's `:regexp` renders the infix `col REGEXP pattern`,
  which SQLite dispatches to `regexp(pattern, col)`, our UDF's argument
  order. Case-insensitivity rides an inline `(?iu)` on the pattern (`u` adds
  UNICODE_CASE so folding works for non-ASCII letters, e.g. Cyrillic Ц/ц).

  Postgres matches natively with `~` / `~*`, so case-insensitivity is the
  operator rather than a pattern prefix, since Postgres AREs have no `u` option.
  The case-insensitive operand is re-collated to `\"default\"` (the database's
  own collation) first: every TEXT column in the Postgres schema is declared
  `COLLATE \"C\"` to match SQLite's byte ordering, and `~*` folds case
  according to its operand's collation, so under `\"C\"` it would fold ASCII
  only, so `Ц` would stop matching `ц`. Re-collating affects nothing but the
  case folding inside this one predicate."
  [col pattern case-insensitive?]
  (if (postgres?)
    (if case-insensitive?
      [op-iregex [:collate col "default"] pattern]
      [op-regex col pattern])
    [:regexp col (if case-insensitive? (str "(?iu)" pattern) pattern)]))

;; ============================================================
;; Result normalization
;; ============================================================

(defn normalize-number
  "Postgres returns `numeric` aggregates as BigDecimal; SQLite returns Long or
  Double. Fold a BigDecimal down to whichever of those two its VALUE calls
  for (integral to Long, fractional to Double) so `sum` reads the same on
  both backends. Anything that is not a BigDecimal passes through.

  Note `<= (.scale …) 0` rather than `zero?`: `stripTrailingZeros` renders 60
  as 6E+1, whose scale is -1, not 0."
  [v]
  (if (instance? java.math.BigDecimal v)
    (let [^java.math.BigDecimal stripped (.stripTrailingZeros ^java.math.BigDecimal v)]
      (if (<= (.scale stripped) 0)
        (.longValueExact (.setScale stripped 0))
        (.doubleValue stripped)))
    v))

;; ============================================================
;; Write serialization
;; ============================================================

(def ^:const write-lock-key
  "Arbitrary but STABLE 64-bit key for the Postgres advisory lock that stands
  in for SQLite's single-writer lock. Any two plaid processes on the same
  database must choose the same number or the lock serializes nothing;
  changing it is a breaking change for a rolling restart."
  7590213045118471123)

(defn advisory-lock-sql
  "SQL that serializes writers, or nil when the engine does it for us.

  SQLite acquires a RESERVED lock at `BEGIN IMMEDIATE` (see the
  `transaction_mode=IMMEDIATE` note in `plaid.sql.common/build-datasource`),
  which is what makes the check-then-write logic all over `plaid.sql.*`
  correct: a writer's pre-flight reads see a snapshot nothing else can
  change before it commits. Postgres's READ COMMITTED gives no such
  guarantee, and its per-row locking cannot substitute, because the checks read
  rows the write does not touch (overlap scans, `MAX(order_idx) + 1`,
  \"is this the last maintainer\").

  `pg_advisory_xact_lock` reproduces SQLite's model exactly: one writer at a
  time, released automatically at COMMIT or ROLLBACK (no leak on a failed
  transaction, unlike the session-scoped variant). This costs no throughput
  relative to the SQLite deployment, which has always had exactly one
  writer. Readers are unaffected because they never open a transaction."
  []
  (when (postgres?)
    [(str "SELECT pg_advisory_xact_lock(" write-lock-key ")")]))

;; ============================================================
;; Misc per-engine SQL
;; ============================================================

(defn non-ascii-text-predicate
  "A WHERE fragment true for rows whose `col` holds at least one multibyte
  UTF-8 character. Used by `plaid.migrate.codepoint-offsets` to pre-filter
  the corpus scan to a cheap superset of the texts that could contain astral
  characters."
  [col]
  (if (postgres?)
    (str "octet_length(" col ") <> length(" col ")")
    (str "length(" col ") <> length(CAST(" col " AS BLOB))")))

(defn db-size-bytes-sql
  "A query returning one row with a `bytes` column: the on-disk size of the
  database, for the `/health` endpoint. SQLite multiplies its own page
  counters; Postgres asks the server for the size of the current database
  (which, unlike the SQLite figure, includes indexes and bloat)."
  []
  (if (postgres?)
    ["SELECT pg_database_size(current_database()) AS bytes"]
    ["SELECT page_count*page_size AS bytes FROM pragma_page_count(), pragma_page_size()"]))

(defn migration-dir
  "Migratus migration directory for the active backend.

  Two directories, not one: `migrations` is the SQLite history (36
  migrations, several written in SQLite-only dialect), and
  `migrations-postgres` is a single squashed baseline, because no Postgres
  database has ever existed to replay that history for. Every migration
  added from here on needs a file in BOTH."
  []
  (if (postgres?) "migrations-postgres" "migrations"))

(defn retryable-conflict?
  "True when `e`, or anything in its cause/suppressed chain, is a write
  conflict the CLIENT can usefully retry, surfaced as a 503 rather than a
  500 by `plaid.sql.operation/submit-operation*`.

  SQLite: `SQLITE_BUSY` (5) / `SQLITE_LOCKED` (6). The common case is a
  top-level busy, but a busy raised while OPENING the transaction arrives
  wrapped: next.jdbc's `transact*` catches the failure, attempts a rollback
  that itself fails (\"cannot rollback - no transaction is active\"), and
  rethrows THAT instead. Hence walking the whole chain and checking the
  message text as well as the result code.

  Postgres: SQLStates 40001 (serialization_failure), 40P01
  (deadlock_detected) and 55P03 (lock_not_available). With the advisory
  write lock in `plaid.sql.common/with-tx*` these should not arise, but a
  lock timeout configured on the server side would land here."
  [^Throwable e]
  (letfn [(hit? [^Throwable t]
            (let [msg (or (.getMessage t) "")
                  sqlite-code (when (instance? org.sqlite.SQLiteException t)
                                (try (.code (.getResultCode ^org.sqlite.SQLiteException t))
                                     (catch Throwable _ nil)))
                  sql-state (when (instance? java.sql.SQLException t)
                              (.getSQLState ^java.sql.SQLException t))]
              (or (= 5 sqlite-code) (= 6 sqlite-code)
                  (contains? #{"40001" "40P01" "55P03"} sql-state)
                  (str/includes? msg "SQLITE_BUSY")
                  (str/includes? msg "SQLITE_LOCKED")
                  (str/includes? msg "database is locked"))))]
    (loop [stack [e]]
      (if (empty? stack)
        false
        (let [^Throwable t (peek stack)
              stack' (pop stack)]
          (cond
            (nil? t) (recur stack')
            (hit? t) true
            :else (recur (into stack' (remove nil? (cons (.getCause t) (seq (.getSuppressed t))))))))))))
