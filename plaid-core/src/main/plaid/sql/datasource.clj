(ns plaid.sql.datasource
  "The pooled SQLite datasource and everything that is true of a connection
  taken from it.

  Builds the HikariCP pool (`build-datasource`), verifies that the PRAGMAs
  actually took, classifies a busy/locked failure (`sqlite-busy?`), repairs a
  connection left mid-transaction (`heal-autocommit!`), and runs a body inside
  a transaction on one (`with-tx`). Knows nothing about the schema: no table,
  no column, no audit row appears here.

  Split out of `plaid.sql.common` so the rest of the SQL layer can depend on
  values and queries without dragging pool construction with it."
  (:require [clojure.string :as str]
            [next.jdbc :as jdbc]
            [taoensso.timbre :as log])
  (:import (com.zaxxer.hikari HikariConfig HikariDataSource)))

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
;; Connection health + transactions
;; ============================================================

(defn sqlite-busy?
  "True when `e` or anything in its cause/suppressed chain is a SQLite
  busy/locked error. The common case is a top-level SQLITE_BUSY, but a busy
  raised while OPENING the transaction arrives wrapped: next.jdbc's
  `transact*` catches the failure, attempts a rollback that itself fails
  (\"cannot rollback - no transaction is active\"), and rethrows that wrapper
  instead. So walk the whole chain, checking the SQLite result code
  (BUSY=5, LOCKED=6) and the message text on each link."
  [^Throwable e]
  (loop [stack [e]]
    (if (empty? stack)
      false
      (let [^Throwable t (peek stack)
            stack' (pop stack)]
        (cond
          (nil? t) (recur stack')
          (let [rc (when (instance? org.sqlite.SQLiteException t)
                     (try (.code (.getResultCode ^org.sqlite.SQLiteException t))
                          (catch Throwable _ nil)))
                msg (or (.getMessage t) "")]
            (or (= 5 rc) (= 6 rc)
                (str/includes? msg "SQLITE_BUSY")
                (str/includes? msg "SQLITE_LOCKED")
                (str/includes? msg "database is locked")))
          true
          :else (recur (into stack' (remove nil? (cons (.getCause t) (seq (.getSuppressed t)))))))))))

(defn heal-autocommit!
  "Undo a half-applied `setAutoCommit(false)` before `con` returns to the pool.

  sqlite-jdbc's `SQLiteConnection.setAutoCommit(false)` flips its own
  `connectionConfig` autocommit flag BEFORE issuing `BEGIN IMMEDIATE`, and
  has no exception handler around that exec. Under write contention the
  BEGIN fails with SQLITE_BUSY once `busy_timeout` elapses — and the flag is
  left `false` with NO transaction open. next.jdbc's `transact*` calls
  `.setAutoCommit con false` OUTSIDE its own try, so it neither rolls back
  nor restores autocommit on that path either, and Hikari's proxy saw its
  own `setAutoCommit` throw so it records no dirty bit and resets nothing.
  The connection goes back to the pool permanently mismatched: the driver
  believes a transaction is open, SQLite is actually in autocommit mode.

  Every later borrow of that connection is then silently NON-transactional —
  `setAutoCommit(false)` early-returns (the flag already reads false) so no
  BEGIN is ever issued, each statement autocommits on its own, and the final
  `.commit` throws `cannot commit - no transaction is active`, which
  next.jdbc turns into `Rollback failed handling ...`. The caller sees a
  fast, load-independent 500 while the writes it was told failed are
  already durable. One busy timeout thus takes a pooled connection out of
  service for good (until Hikari's 30-minute maxLifetime retires it) AND
  costs the atomicity guarantee on it.

  Called on every exit from `with-tx*`. When autocommit is already true
  (the overwhelmingly common case, including a normal rollback) this is a
  no-op. Otherwise roll back first — that can only DISCARD work, never
  commit it — and then force the flag back with `setAutoCommit(true)`,
  which sets the flag before its own exec and so lands correctly even when
  that exec throws for want of a transaction."
  [^java.sql.Connection con]
  (try
    (when-not (.getAutoCommit con)
      (try (.rollback con) (catch java.sql.SQLException _ nil))
      (try (.setAutoCommit con true) (catch java.sql.SQLException _ nil))
      (log/warn "Reset a pooled connection left with autocommit disabled and no"
                "open transaction (a BEGIN that lost the write lock). See"
                "plaid.sql.datasource/heal-autocommit!"))
    (catch java.sql.SQLException _
      ;; A closed/broken connection can throw from getAutoCommit itself.
      ;; Nothing to heal in that case — Hikari will discard it.
      nil)))

(defn with-tx*
  "Run `f` inside a JDBC transaction. `f` is called with a Connection.
  If `db` is already a Connection in an outer transaction (the REST batch
  handler's case), we DO NOT wrap with another with-transaction — next.jdbc's
  default behavior there would commit the underlying tx prematurely. Instead
  we run the body inline; the outer batch handler owns commit/rollback.

  We check the connection out ourselves rather than handing the DataSource to
  `jdbc/with-transaction` so that `heal-autocommit!` gets a chance to run
  before the connection is recycled — see its docstring for what happens
  when it doesn't."
  [db f]
  (if (instance? java.sql.Connection db)
    (f db)
    (with-open [con (jdbc/get-connection db)]
      (try
        (jdbc/with-transaction [tx con] (f tx))
        (finally
          (heal-autocommit! con))))))

(defmacro with-tx
  "Execute body inside a JDBC transaction. Binds `tx-sym` to the Connection."
  [[tx-sym db] & body]
  `(with-tx* ~db (fn [~tx-sym] ~@body)))
