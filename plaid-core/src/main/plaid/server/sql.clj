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
          (System/exit 1)))))

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
          ;; Symmetric restore of the slow-query threshold root captured
          ;; on :start. Clear the atom afterwards so a subsequent :start
          ;; re-captures whatever the live root is at that moment.
          (when-let [orig @original-slow-query-threshold]
            (alter-var-root #'psc/*slow-query-threshold-ms* (constantly orig))
            (reset! original-slow-query-threshold nil))))
