(ns plaid.server.sql
  "Mount state for the SQL datasource. Replaces plaid.server.xtdb.
  Starts a HikariCP pool around SQLite, runs Migratus migrations, and
  prompts to create an admin user if none exists."
  (:require [clojure.string :as str]
            [migratus.core :as migratus]
            [mount.core :refer [defstate]]
            [plaid.migrate.codepoint-offsets :as codepoint-offsets]
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

(defn- run-migrations! [datasource]
  (log/info "Running Migratus migrations...")
  (migratus/migrate (migratus-config datasource))
  (log/info "Migrations complete."))

(defn- read-line-secret []
  (if-let [console (System/console)]
    (String. (.readPassword console))
    (read-line)))

(defn make-admin-user [datasource]
  ;; Non-interactive path first: under systemd/containers stdin is
  ;; /dev/null, so the prompt below would read nils and die. Operators
  ;; provision the first admin via env vars instead.
  (let [env-email (System/getenv "PLAID_ADMIN_EMAIL")
        env-password (System/getenv "PLAID_ADMIN_PASSWORD")]
    (cond
      (and (seq env-email) (seq env-password))
      ;; nil actor: this is the bootstrap admin — no user exists yet.
      (let [{:keys [success error]} (pxu/create datasource env-email true env-password nil)]
        (if success
          (log/info (str "Admin user created from PLAID_ADMIN_EMAIL (" env-email ")."))
          (do (log/error "Error creating first admin from env vars:" error)
              (System/exit 1))))

      ;; Headless with no env vars: fail with instructions instead of
      ;; prompting into /dev/null (nil email → confusing create failure).
      (nil? (System/console))
      (do (log/error (str "No users exist and no interactive console is attached. Either set "
                          "PLAID_ADMIN_EMAIL and PLAID_ADMIN_PASSWORD to create the first admin "
                          "non-interactively, or set SKIP_ACCOUNT_CREATION_PROMPT=1 to start "
                          "without one (you can create users over the API later only with an "
                          "existing admin, so prefer the env vars)."))
          (System/exit 1))

      :else
      (do
        (log/warn "No users detected! Prompting you for credentials...")
        (print "Enter email: ") (flush)
        (let [email (read-line)
              _ (do (print "Enter password: ") (flush))
              password (read-line-secret)
              ;; nil actor: this is the bootstrap admin — no user exists yet.
              {:keys [success]} (pxu/create datasource email true password nil)]
          (if success
            (log/info (str "Admin user created with email " email "."))
            (do (log/error "Error creating first user!")
                (System/exit 1))))))))

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

(defn- analyze-targets
  "Every user table in the database, in name order — one ANALYZE
   statement each. `sqlite_%` tables are SQLite's own (including
   `sqlite_stat1`, which ANALYZE writes)."
  [^java.sql.Connection conn]
  (with-open [stmt (.createStatement conn)
              rs (.executeQuery stmt (str "SELECT name FROM sqlite_master WHERE type = 'table' "
                                          "AND name NOT LIKE 'sqlite_%' ORDER BY name"))]
    (loop [names []]
      (if (.next rs)
        (recur (conj names (.getString rs 1)))
        names))))

(defn- analyze-statement
  "`ANALYZE <table>` for one table. Identifier-quoted: the names come
   from `sqlite_master`, but a quoted identifier is what makes that
   irrelevant."
  [table]
  (str "ANALYZE \"" (str/replace table "\"" "\"\"") "\";"))

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

(defn- analyze-tables!
  "ANALYZE the database ONE TABLE PER STATEMENT, pausing between them.
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
    (let [tables (analyze-targets conn)]
      (doseq [[i table] (map-indexed vector tables)]
        (when (pos? i)
          (Thread/sleep analyze-pause-ms))
        (with-open [stmt (.createStatement conn)]
          (.execute stmt (analyze-statement table))))
      ;; Last, and only once a table has been analysed, since that is what
      ;; creates `sqlite_stat1`. One DELETE over a table of a few dozen
      ;; rows, in the same autocommit as the statements above, so the write
      ;; lock it takes is about as short as one gets.
      (when (seq tables)
        (with-open [stmt (.createStatement conn)]
          (.execute stmt orphan-statistics-statement)))
      (count tables))))

(defn- refresh-planner-stats!
  "Run a sampled ANALYZE so SQLite plans against the database as it is
   now, then drop the pool's open connections so every later one loads
   the fresh statistics (a connection reads them when it opens). Stale
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
                     (let [t0 (System/nanoTime)
                           n (analyze-tables! datasource)]
                       (.softEvictConnections (.getHikariPoolMXBean datasource))
                       (log/info (format "Planner statistics refreshed in the background across %d tables in %dms"
                                         n (quot (- (System/nanoTime) t0) 1000000))))
                     (catch Exception e
                       (log/warn e "ANALYZE failed at startup; SQLite plans with the statistics it has"))))
                 "plaid-planner-stats")
            (.setDaemon true)
            (.start))))

(defn- await-planner-stats!
  "Join the background ANALYZE before the pool closes. Bounded: a shutdown
   waits on this, and a refusal to finish is not a reason to hang. Missing
   the join costs a logged warning from the thread, nothing more."
  []
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
               ;; Wire the slow-query threshold from config — promised by the
               ;; docstring on `psc/*slow-query-threshold-ms*` but previously
               ;; never read. Defaults to the var's existing 500ms default.
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
           (run-migrations! ds)
           (when (and (empty? (pxu/get-all ds))
                      (not (System/getenv "SKIP_ACCOUNT_CREATION_PROMPT")))
             (make-admin-user ds))
           ;; One-time DATA migration: reinterpret any pre-existing token
           ;; offsets from UTF-16 to Unicode code points. Idempotent + a
           ;; verified no-op when there is no astral text.
           (codepoint-offsets/ensure-converted! ds)
           ;; Last, so the one write-lock holder on the startup path (the
           ;; migration above) is done before ANALYZE wants it.
           (refresh-planner-stats! ds)
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
