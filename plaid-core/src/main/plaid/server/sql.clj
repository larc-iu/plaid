(ns plaid.server.sql
  "Mount state for the SQL datasource. Starts a HikariCP pool around SQLite, runs Migratus migrations, and
  prompts to create an admin user if none exists."
  (:require [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [migratus.core :as migratus]
            [migratus.protocols]
            [mount.core :refer [defstate]]
            [plaid.server.config :refer [config]]
            [plaid.sql.common :as psc]
            [plaid.sql.datasource :as psd]
            [plaid.sql.user :as pxu]
            [taoensso.timbre :as log]))

(defn migratus-config
  "Build a Migratus config map for the given DataSource."
  [datasource]
  {:store :database
   :migration-dir "migrations"
   :migration-table-name "schema_migrations"
   :db {:datasource datasource}})

(declare checkpoint-wal!)

;; ============================================================
;; Migrations
;; ============================================================

(def ^:private reservation-id
  "The row migratus puts in `schema_migrations` while a migration runs, and
  takes out in a `finally`, which a killed process never reaches."
  -1)

(defn- reservation-held?
  "Is migratus' reservation row in `schema_migrations`? False when the table
  does not exist yet (a fresh database)."
  [datasource]
  (try
    (with-open [conn (.getConnection ^javax.sql.DataSource datasource)
                stmt (.prepareStatement conn "SELECT 1 FROM schema_migrations WHERE id = ?")]
      (.setLong stmt 1 reservation-id)
      (with-open [rs (.executeQuery stmt)]
        (.next rs)))
    (catch java.sql.SQLException _ false)))

(defn- remove-reservation! [datasource]
  (with-open [conn (.getConnection ^javax.sql.DataSource datasource)
              stmt (.prepareStatement conn "DELETE FROM schema_migrations WHERE id = ?")]
    (.setLong stmt 1 reservation-id)
    (.executeUpdate stmt)))

(defn- write-refusal
  "Why `datasource` cannot be written, from SQLite itself: a write that is
  rolled back at once. Nil when it can be."
  [datasource]
  (try
    (with-open [conn (.getConnection ^javax.sql.DataSource datasource)
                stmt (.createStatement conn)]
      (.execute stmt "BEGIN IMMEDIATE")
      (try
        (.execute stmt "CREATE TABLE plaid_write_probe (x INTEGER)")
        (finally
          (.execute stmt "ROLLBACK")))
      nil)
    (catch java.sql.SQLException e (ex-message e))))

(defn- pending-migrations
  "The migrations not yet recorded as run, oldest first, as `{:id :name}`."
  [cfg]
  (migratus/with-store [store (migratus.protocols/make-store cfg)]
    (->> (migratus/uncompleted-migrations cfg store)
         (sort-by migratus.protocols/id)
         (mapv (fn [m] {:id (migratus.protocols/id m) :name (migratus.protocols/name m)})))))

(defn- migration-label [{:keys [id name]}] (str id "-" name))

(defn- resumable?
  "Is migration `m` written to be run again after a stop at any point
  (`:plaid/resumable true` in its .edn file)? An SQL migration never is: a
  stop between its commit and migratus recording it would run it twice."
  [{:keys [id name]}]
  (boolean (some-> (io/resource (str "migrations/" id "-" name ".edn"))
                   slurp
                   edn/read-string
                   :plaid/resumable)))

(defn- refuse! [message]
  (throw (ex-info message {:type :plaid/migrations-not-run})))

(defn interrupted-refusal
  "The refusal for a start after one that was stopped during migration `m`
  of the database at `db-path`, when the server does not resume it itself."
  [db-path m]
  (str "The database was not migrated: the last start was stopped during migration " (migration-label m)
       ", which cannot be resumed by the server. Restore the backup taken before upgrading and start again. "
       "To run the migration again on this database instead, remove the mark the stopped start left, with "
       "sqlite3 " db-path " \"DELETE FROM schema_migrations WHERE id = -1\", and start again."))

(defn run-migrations!
  "Apply pending migrations, then empty the WAL, or refuse to start (throw)
  unless every migration has run.

  A start stopped during a migration (kill -9, a SIGTERM such as `systemctl
  restart`, a power cut) leaves migratus' reservation row behind, and while
  it is there migratus runs nothing and says so only at INFO. When the first
  pending migration is written to be resumed (`resumable?`) and this process
  holds the instance lock (`lock-held?`: no other server has the database),
  the row is removed with a WARN line and the migration runs again.
  Otherwise the start is refused with `interrupted-refusal`. A database that
  cannot be written, a migration that fails, and anything still pending
  after the run are refused too, each with what was found.

  A migration runs in one transaction, so a table rewrite puts every page it
  writes in the WAL first (3.6 GB for the 2026-09-27 `audit_writes` rebuild
  on a 4.2 GB copy). SQLite reuses the WAL after a checkpoint but never
  shrinks it, so without the TRUNCATE checkpoint that disk stays taken until
  shutdown. Nothing else holds a connection yet, so the checkpoint
  completes."
  [datasource {:keys [db-path lock-held?]}]
  (let [cfg (migratus-config datasource)]
    (log/info "Running Migratus migrations...")
    (when (reservation-held? datasource)
      (let [[first-pending] (pending-migrations cfg)]
        (cond
          (nil? first-pending)
          (do (log/warn "The last start was stopped after its migrations ran. Removing the mark it left.")
              (remove-reservation! datasource))

          (and lock-held? (resumable? first-pending))
          (do (log/warn (str "The last start was stopped during migration " (migration-label first-pending)
                             ". No other server holds this database and the migration is written to be "
                             "resumed: running it again."))
              (remove-reservation! datasource))

          :else
          (refuse! (interrupted-refusal db-path first-pending)))))
    (let [result (migratus/migrate cfg)
          pending (pending-migrations cfg)]
      (cond
        (= :ignore result)
        (if-let [why (write-refusal datasource)]
          (refuse! (str "The database was not migrated: " db-path " cannot be written (" why "). "
                        "Make the file and its folder writable by the server and start again."))
          (refuse! (str "The database was not migrated: another process is migrating it (the row with id -1 "
                        "in schema_migrations). Stop it and start again.")))

        (= :failure result)
        (refuse! (str "The database was not migrated: "
                      (if-let [m (first pending)] (str "migration " (migration-label m)) "a migration")
                      " did not finish. See the lines above."))

        (seq pending)
        (refuse! (str "The database was not migrated: " (count pending)
                      (if (= 1 (count pending)) " migration has" " migrations have")
                      " not run (" (str/join ", " (map migration-label pending)) ")."))))
    (checkpoint-wal! datasource)
    (log/info "Migrations complete.")))

(defn- read-line-secret
  "Read one line without echo, or nil at the end of input."
  []
  (if-let [console (System/console)]
    (some-> (.readPassword console) String.)
    (read-line)))

(defn- prompt-first-email
  "Ask for the first admin's email until it is one the account can be made
  with, so a typo is caught before the password is typed. Nil at the end of
  input."
  []
  (loop []
    (print "Enter email: ")
    (flush)
    (when-let [email (read-line)]
      (if-let [refusal (try (pxu/assert-valid-email! email) nil
                            (catch clojure.lang.ExceptionInfo e (ex-message e)))]
        (do (println (str refusal "."))
            (recur))
        email))))

(defn- prompt-first-password
  "Ask for the first admin's password until it is long enough and typed the
  same twice, so a typo cannot lock the only admin out. Nil at the end of
  input."
  []
  (loop []
    (print (str "Enter password (at least " pxu/min-password-length " characters): "))
    (flush)
    (when-let [password (read-line-secret)]
      (if (or (< (count password) pxu/min-password-length) (str/blank? password))
        (do (println (str "Password must be at least " pxu/min-password-length " characters."))
            (recur))
        (do (print "Confirm password: ")
            (flush)
            (when-let [again (read-line-secret)]
              (if (= password again)
                password
                (do (println "Passwords do not match.")
                    (recur)))))))))

(defn- console-attached? [] (some? (System/console)))

(defn- exit! [status] (System/exit status))

(defn make-admin-user [datasource]
  ;; Non-interactive path first: under systemd/containers stdin is
  ;; /dev/null, so the prompt below would read nils and die. Operators
  ;; provision the first admin via env vars instead.
  (let [env-email (System/getenv "PLAID_ADMIN_EMAIL")
        env-password (System/getenv "PLAID_ADMIN_PASSWORD")]
    (cond
      (and (seq env-email) (seq env-password))
      ;; nil actor: this is the bootstrap admin, no user exists yet.
      (let [{:keys [success extra error]} (pxu/create datasource env-email true env-password nil)]
        (if success
          (log/info (str "Admin user created from PLAID_ADMIN_EMAIL (" extra ")."))
          (do (log/error "Error creating first admin from env vars:" error)
              (exit! 1))))

      ;; Headless with no env vars: fail with instructions instead of
      ;; prompting into /dev/null (nil email → confusing create failure).
      (not (console-attached?))
      (do (log/error (str "No users exist and no interactive console is attached. Either set "
                          "PLAID_ADMIN_EMAIL and PLAID_ADMIN_PASSWORD to create the first admin "
                          "non-interactively, or set SKIP_ACCOUNT_CREATION_PROMPT=1 to start "
                          "without one (you can create users over the API later only with an "
                          "existing admin, so prefer the env vars)."))
          (exit! 1))

      :else
      (do
        (log/warn "No users detected! Prompting you for credentials...")
        (let [email (prompt-first-email)
              password (when email (prompt-first-password))]
          (if (nil? password)
            (do (log/error (str "Error creating first user: no " (if email "password" "email") " entered"))
                (exit! 1))
            ;; nil actor: this is the bootstrap admin, no user exists yet.
            (let [{:keys [success extra error]} (pxu/create datasource email true password nil)]
              (if success
                (log/info (str "Admin user created with email " extra "."))
                (do (log/error "Error creating first user:" error)
                    (exit! 1))))))))))

(defn- checkpoint-wal!
  "Run `PRAGMA wal_checkpoint(TRUNCATE)` so the WAL is flushed into the
   main DB file before the pool closes. Without this the `.db-wal` /
   `.db-shm` sidecars can linger non-empty after shutdown."
  [datasource]
  (try
    (with-open [conn (.getConnection datasource)
                stmt (.createStatement conn)]
      (.execute stmt "PRAGMA wal_checkpoint(TRUNCATE);"))
    (catch Exception e
      (log/warn e "WAL checkpoint failed during shutdown"))))

(defonce ^{:private true
           :doc "The in-flight background ANALYZE, so :stop can wait for it
                 instead of closing the pool out from under it."}
  planner-stats-thread
  (atom nil))

(def ^:private analyze-pause-ms
  "How long to stand off the database between two tables' ANALYZE. A
   writer that arrived while the previous statement held the write lock
   is parked in its `busy_timeout` retry loop; this is the window in
   which it is certain to find the lock free."
  50)

(defn- analyze-statements
  "The `ANALYZE` statements SQLite's own staleness test asks for, one per
   table, without running them: `PRAGMA optimize` with 0x10000 (look at
   every table, not only those this connection has queried), 0x02 (the
   ANALYZE step) and 0x01 (debug: return the statements instead of running
   them). In the bundled SQLite (3.50) that test picks a table with an
   index that has no statistics, or whose row count has grown or shrunk
   tenfold since it was analysed (`iRange = 33` in pragma.c, a LogEst of
   10x). A table with no index and no statistics is judged against a
   default estimate of about a million rows, so one of roughly 100k to 10M
   rows is not picked until it passes that range. Planner statistics
   only have to be the right order of magnitude, and the prod database's
   big tables grow by less than that between deploys, so after the first
   pass a restart analyses almost nothing. Analysing every table took 225
   seconds on the prod database, and one table's statement still held the
   write lock past `busy_timeout`, so saves failed after each deploy.

   The statements come back quoted (`ANALYZE \"main\".\"t\"`) and are run
   as given."
  [^java.sql.Connection conn]
  (with-open [stmt (.createStatement conn)
              rs (.executeQuery stmt "PRAGMA optimize=0x10003;")]
    (loop [out []]
      (if (.next rs)
        (recur (conj out (.getString rs 1)))
        out))))

(defn- statistics-table?
  "Does `sqlite_stat1` exist yet? The first ANALYZE creates it."
  [^java.sql.Connection conn]
  (with-open [stmt (.createStatement conn)
              rs (.executeQuery stmt (str "SELECT 1 FROM sqlite_master "
                                          "WHERE type = 'table' AND name = 'sqlite_stat1'"))]
    (.next rs)))

(def ^:private orphan-statistics-statement
  "Delete the statistics for every name the schema no longer holds.

   `ANALYZE <table>` replaces the rows of the table it names and no
   others, so nothing in the per-table pass clears what a table that has
   since left the schema wrote. SQLite clears a DROPped table's rows
   itself, but not a RENAMEd one's: those stay under the OLD name, and
   the migrations rebuild a table exactly that way (create the new shape,
   copy, drop, rename: see `20260905130000-comments-vocab-anchor.up.sql`,
   the shape every relaxed NOT NULL needs). A row stranded under a name a
   later migration hands to a DIFFERENT table is statistics the planner
   reads for a table they were never measured on."
  (str "DELETE FROM sqlite_stat1 WHERE tbl NOT IN "
       "(SELECT name FROM sqlite_master WHERE type IN ('table', 'index'));"))

(defn- empty-table?
  "Does the table an `ANALYZE \"main\".\"t\"` statement names hold no rows?
   ANALYZE writes no `sqlite_stat1` row for an empty table without an index,
   so SQLite's staleness test names it again on every pass (`audit_retention`)."
  [^java.sql.Connection conn ^String analyze-sql]
  (let [target (str/trim (subs analyze-sql (count "ANALYZE ")))]
    (with-open [stmt (.createStatement conn)
                rs (.executeQuery stmt (str "SELECT 1 FROM " (str/replace target #";$" "") " LIMIT 1"))]
      (not (.next rs)))))

(defn- analyze-tables!
  "ANALYZE the tables whose statistics are stale (`analyze-statements`),
   ONE TABLE PER STATEMENT, pausing between them.
   SQLite runs each ANALYZE in its own write transaction — a whole-database
   `ANALYZE;` is ONE statement, so it holds the write lock from its first
   write to `sqlite_stat1` until it ends. On the prod database that is
   108-133 seconds during which every write waits out `busy_timeout` and is
   refused with 503, and both clients stop retrying a 503 after about 24
   seconds: two minutes of failed saves after every deploy. Per table, each
   lock lasts one table's indexes, and `analyze-pause-ms` between them
   leaves a window a parked writer is certain to win.

   Then one more statement, `orphan-statistics-statement`, for the rows
   per-table ANALYZE cannot reach: those of a table the schema no longer
   holds."
  [datasource]
  (with-open [conn (.getConnection datasource)]
    ;; Autocommit, so each statement below is its own transaction and the
    ;; write lock is dropped the moment it ends.
    (when-not (.getAutoCommit conn)
      (.setAutoCommit conn true))
    (with-open [stmt (.createStatement conn)]
      (.execute stmt "PRAGMA analysis_limit=400;"))
    (let [statements (vec (remove (partial empty-table? conn) (analyze-statements conn)))]
      (doseq [[i sql] (map-indexed vector statements)]
        (when (pos? i)
          (Thread/sleep analyze-pause-ms))
        (with-open [stmt (.createStatement conn)]
          (.execute stmt sql)))
      ;; Last, and only once some table has been analysed, since that is
      ;; what creates `sqlite_stat1`. One DELETE over a table of a few
      ;; dozen rows, in the same autocommit as the statements above, so the
      ;; write lock it takes is about as short as one gets.
      (when (statistics-table? conn)
        (with-open [stmt (.createStatement conn)]
          (.execute stmt orphan-statistics-statement)))
      statements)))

(defonce ^:private refresh-lock (Object.))

(defn refresh-stale-statistics!
  "One pass of the refresh: ANALYZE what went stale (`analyze-tables!`), and
   when anything was, drop the pool's open connections so every later one
   loads the fresh statistics. `occasion` names the pass in the log line.
   Returns how many tables were analysed.

   One pass at a time (`refresh-lock`): the startup pass, the scheduled one
   and a project removal's each run on their own thread, and a pass that
   waited finds fresh what the one before it analysed."
  [datasource occasion]
  (locking refresh-lock
    (let [t0 (System/nanoTime)
          n (count (analyze-tables! datasource))]
      (when (pos? n)
        (.softEvictConnections (.getHikariPoolMXBean datasource))
        (log/info (format "Planner statistics refreshed %s across %d stale tables in %dms"
                          occasion n (quot (- (System/nanoTime) t0) 1000000))))
      n)))

(defn- refresh-planner-stats!
  "Run a sampled ANALYZE over the tables whose statistics went stale
   (`analyze-statements`) so SQLite plans against the database as it is
   now, then, if any were, drop the pool's open connections so every later
   one loads the fresh statistics (a connection reads them when it opens). Stale
   statistics mislead: a table analysed when it held a few rows keeps
   being planned as tiny, and the planner scans it rather than probe its
   primary key, which cost seconds per document read on a million-row
   entity_metadata.

   ON A BACKGROUND THREAD, because the sampling is not as cheap as it
   looks. `analysis_limit` caps the rows read per index, but ANALYZE still
   walks every index in the file, and on a large database those are
   scattered random reads: 108-133 seconds, measured on a 3GB database
   across three restarts. Blocking :start on that makes every restart an
   outage of that length. Stale statistics make reads slow, not wrong, so
   answering for a minute or two on last boot's statistics beats not
   answering at all.

   AND ONE TABLE PER STATEMENT (`analyze-tables!`), because the write lock
   an ANALYZE holds lasts as long as its statement does. Off the start path
   but holding the lock for two minutes, this traded an unreachable server
   for one that reads and refuses every save — the same outage wearing a
   500. Per table, a writer waits out one table, not the file."
  [datasource]
  (reset! planner-stats-thread
          (doto (Thread.
                 (fn []
                   (try
                     (refresh-stale-statistics! datasource "at startup")
                     (catch Exception e
                       (log/warn e "ANALYZE failed at startup; SQLite plans with the statistics it has"))))
                 "plaid-planner-stats")
            (.setDaemon true)
            (.start))))

(def ^:private planner-stats-interval-ms
  "How often the running server repeats the startup refresh. Every five
   minutes, because a database can grow tenfold while the server runs, and a
   young install does so within minutes: a fresh install that then imports a
   corpus planned as if its tables were empty (a document's history page took
   1.2 s instead of 10 ms), and an FK cascade into a table analysed nearly
   empty is planned as a scan per deleted row (a 5000-row purge chunk took
   34 to 138 s). The staleness test is the same one startup uses, so on a
   database whose size has not changed by an order of magnitude a pass
   analyses nothing and costs one PRAGMA."
  (* 5 60 1000))

(defonce ^{:private true
           :doc "The scheduler that repeats the refresh while the server runs."}
  planner-stats-schedule
  (atom nil))

(defn- schedule-planner-stats!
  "Repeat `refresh-stale-statistics!` every `interval-ms`, first after one
   interval (startup already ran its own pass). Each pass waits for the
   startup pass to finish, so two never overlap, and a pass that fails is
   logged and the next one runs as scheduled. A schedule already running (a
   re-entrant :start) is stopped first, since `:stop` knows only the latest."
  [datasource interval-ms]
  (when-let [^java.util.concurrent.ScheduledExecutorService old @planner-stats-schedule]
    (.shutdownNow old))
  (let [exec (java.util.concurrent.Executors/newSingleThreadScheduledExecutor
              (reify java.util.concurrent.ThreadFactory
                (newThread [_ r]
                  (doto (Thread. ^Runnable r "plaid-planner-stats-schedule")
                    (.setDaemon true)))))]
    (.scheduleWithFixedDelay
     exec
     ^Runnable (fn []
                 (try
                   (when-let [^Thread t @planner-stats-thread]
                     (.join t))
                   (refresh-stale-statistics! datasource "on schedule")
                   (catch InterruptedException _
                     (.interrupt (Thread/currentThread)))
                   (catch Exception e
                     (log/warn e "Scheduled ANALYZE failed; SQLite plans with the statistics it has"))))
     (long interval-ms) (long interval-ms) java.util.concurrent.TimeUnit/MILLISECONDS)
    (reset! planner-stats-schedule exec)))

(defn- await-planner-stats!
  "Stop the schedule and join the background ANALYZE before the pool
   closes. Bounded: a shutdown waits on this, and a refusal to finish is not
   a reason to hang. Missing the join costs a logged warning from the
   thread, nothing more."
  []
  (when-let [^java.util.concurrent.ScheduledExecutorService exec @planner-stats-schedule]
    (.shutdownNow exec)
    (try (.awaitTermination exec 5 java.util.concurrent.TimeUnit/SECONDS)
         (catch InterruptedException _ (.interrupt (Thread/currentThread))))
    (reset! planner-stats-schedule nil))
  (when-let [^Thread t @planner-stats-thread]
    (try (.join t 5000) (catch InterruptedException _ (.interrupt (Thread/currentThread))))
    (reset! planner-stats-thread nil)))

(defn- coerce-slow-query-threshold-ms
  "Coerce the operator-supplied :slow-query-threshold-ms config value to
  long. Strings parse via Long/parseLong (env-var case where Aero's
  #long was not applied); anything else that isn't a number throws."
  [v]
  (cond
    (nil? v) nil
    (integer? v) (long v)
    (number? v) (long v)
    (string? v) (try (Long/parseLong (str/trim v))
                     (catch NumberFormatException _
                       (throw (ex-info ":slow-query-threshold-ms must be numeric"
                                       {:value v :code 500}))))
    :else (throw (ex-info ":slow-query-threshold-ms must be numeric"
                          {:value v :code 500}))))

;; ============================================================
;; Single-instance lock
;; ============================================================

(defonce ^:private instance-lock (atom nil))

(defn- acquire-instance-lock!
  "Take an exclusive OS-level lock on `<db-path>.lock` so a second plaid
  instance can't run against the same SQLite database. SQLite's own
  cross-process locking keeps row data safe, but everything in-memory
  diverges between two instances: document locks (423 enforcement
  breaks) and the SSE/service registries split. Fail loudly at boot
  instead.

  Returns {:channel :lock :file} on success; nil (no-op) for in-memory
  databases (tests). Throws a readable operator error when the lock is
  held. The lock file is deliberately never deleted — deleting after
  release races a successor's acquire (the successor can lock the
  doomed inode) — it just holds the PID of the current/most-recent
  holder for diagnostics."
  [db-path]
  (when (and (string? db-path) (not= "" db-path))
    (let [lock-file (java.io.File. (str db-path ".lock"))
          _ (some-> (.getParentFile lock-file) (.mkdirs))
          channel (.getChannel (java.io.RandomAccessFile. lock-file "rw"))
          lock (try (.tryLock channel)
                    (catch java.nio.channels.OverlappingFileLockException _ nil))]
      (if (nil? lock)
        (let [holder (try (str/trim (slurp lock-file))
                          (catch Exception _ ""))]
          (.close channel)
          (throw (ex-info (str "Another plaid instance appears to be running against " db-path
                               " — the instance lock " (.getPath lock-file) " is held"
                               (when-not (str/blank? holder)
                                 (str " (last holder PID " holder ")"))
                               ". Stop the other instance first, or point this one at a"
                               " different [database] path.")
                          {:db-path db-path :lock-file (.getPath lock-file)})))
        (do
          ;; Best-effort PID stamp for the error message above.
          (try
            (.truncate channel 0)
            (.write channel (java.nio.ByteBuffer/wrap
                             (.getBytes (str (.pid (java.lang.ProcessHandle/current))) "UTF-8")))
            (.force channel false)
            (catch Exception _ nil))
          {:channel channel :lock lock :file lock-file})))))

(defn- release-instance-lock! []
  (when-let [{:keys [^java.nio.channels.FileChannel channel
                     ^java.nio.channels.FileLock lock]} @instance-lock]
    (try
      (.release lock)
      (.close channel)
      (catch Exception e
        (log/warn e "Failed to release instance lock cleanly")))
    (reset! instance-lock nil)))

;; Captures the slow-query-threshold root value at :start so :stop can
;; restore it. Without symmetric restoration, repeated mount/start +
;; mount/stop cycles (typical in tests + REPL workflows) would leave the
;; var permanently pinned to whatever the most recent :start chose, even
;; after :stop tore the datasource down. Atom (not a plain var) so the
;; capture survives across the let-scope boundary into :stop. nil while
;; the defstate is not started.
(defonce ^:private original-slow-query-threshold (atom nil))

(defstate datasource
  :start (let [cfg (::config config)
               db-path (:main-db-path cfg)
               ;; Refuse to double-run against the same SQLite file —
               ;; see acquire-instance-lock!. Guarded so a re-entrant
               ;; :start (mount/start twice, no :stop) keeps the
               ;; existing lock rather than tripping over itself.
               _ (when (nil? @instance-lock)
                   (reset! instance-lock (acquire-instance-lock! db-path)))
               ;; Pool/PRAGMA tuning under :plaid.server.sql/pool — see
               ;; `psd/default-pool-config` for keys + defaults. Absent
               ;; config falls through to the defaults; passing nil is
               ;; explicitly supported by `build-datasource`.
               pool-cfg (:plaid.server.sql/pool config)
               ;; The slow-query threshold from config (see
               ;; `psc/*slow-query-threshold-ms*`), 500 ms by default.
               threshold-ms (or (coerce-slow-query-threshold-ms
                                 (:slow-query-threshold-ms cfg))
                                500)
               ;; Capture the pre-:start root only on the FIRST entry of
               ;; this defstate (atom is nil at JVM boot + after each
               ;; :stop). Skip on re-entrant :start (e.g. mount/start
               ;; called twice without an intervening :stop) so we don't
               ;; overwrite the genuine pre-mount root with whatever the
               ;; previous :start installed.
               _ (compare-and-set! original-slow-query-threshold
                                   nil
                                   (var-get #'psc/*slow-query-threshold-ms*))
               _ (alter-var-root #'psc/*slow-query-threshold-ms*
                                 (constantly threshold-ms))
               ds (psd/build-datasource db-path pool-cfg)]
           (run-migrations! ds {:db-path db-path :lock-held? (some? @instance-lock)})
           (when (and (empty? (pxu/get-all ds))
                      (not (System/getenv "SKIP_ACCOUNT_CREATION_PROMPT")))
             (make-admin-user ds))
           ;; Last, so the schema migrations above, the one write-lock
           ;; holder on the startup path, are done before ANALYZE wants it.
           (refresh-planner-stats! ds)
           (schedule-planner-stats! ds planner-stats-interval-ms)
           ds)
  :stop (do
          (await-planner-stats!)
          (when datasource
            (checkpoint-wal! datasource)
            (.close datasource))
          (release-instance-lock!)
          ;; Symmetric restore of the slow-query threshold root captured
          ;; on :start. Clear the atom afterwards so a subsequent :start
          ;; re-captures whatever the live root is at that moment.
          (when-let [orig @original-slow-query-threshold]
            (alter-var-root #'psc/*slow-query-threshold-ms* (constantly orig))
            (reset! original-slow-query-threshold nil))))
