(ns plaid.server.sql
  "Mount state for the SQL datasource. Replaces plaid.server.xtdb.
  Starts a HikariCP pool around SQLite, runs Migratus migrations, and
  prompts to create an admin user if none exists."
  (:require [migratus.core :as migratus]
            [mount.core :refer [defstate]]
            [plaid.migrate.codepoint-offsets :as codepoint-offsets]
            [plaid.server.config :refer [config]]
            [plaid.sql.common :as psc]
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

(defn- coerce-slow-query-threshold-ms
  "Coerce the operator-supplied :slow-query-threshold-ms config value to
  long. Strings parse via Long/parseLong (env-var case where Aero's
  #long was not applied); anything else that isn't a number throws."
  [v]
  (cond
    (nil? v) nil
    (integer? v) (long v)
    (number? v) (long v)
    (string? v) (try (Long/parseLong (clojure.string/trim v))
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
  breaks), the SSE/service registries split, and — worst — two history
  tailers would open the same XTDB local storage/log dirs, which XTDB
  local storage does not support. Fail loudly at boot instead.

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
        (let [holder (try (clojure.string/trim (slurp lock-file))
                          (catch Exception _ ""))]
          (.close channel)
          (throw (ex-info (str "Another plaid instance appears to be running against " db-path
                               " — the instance lock " (.getPath lock-file) " is held"
                               (when-not (clojure.string/blank? holder)
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
               ;; Pool/PRAGMA tuning under :plaid.sql.common/pool — see
               ;; `psc/default-pool-config` for keys + defaults. Absent
               ;; config falls through to the defaults; passing nil is
               ;; explicitly supported by `build-datasource`.
               pool-cfg (:plaid.sql.common/pool config)
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
               ds (psc/build-datasource db-path pool-cfg)]
           (run-migrations! ds)
           (when (and (empty? (pxu/get-all ds))
                      (not (System/getenv "SKIP_ACCOUNT_CREATION_PROMPT")))
             (make-admin-user ds))
           ;; One-time DATA migration: reinterpret any pre-existing token
           ;; offsets from UTF-16 to Unicode code points. Idempotent + a
           ;; verified no-op when there is no astral text.
           (codepoint-offsets/ensure-converted! ds)
           ds)
  :stop (do
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
