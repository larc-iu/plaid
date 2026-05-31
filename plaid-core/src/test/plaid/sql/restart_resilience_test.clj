(ns plaid.sql.restart-resilience-test
  "Regression for #87 + task #106: after a clean SIGTERM-style shutdown +
  cold-start on the same file, written entities AND audit_writes survive.

  Task #106 fix: drive shutdown through `(mount/stop)` (NOT inline
  PRAGMA + .close), so the chain through the `plaid.server.sql/datasource`
  `:stop` body actually exercises the production code path — including
  the WAL checkpoint baked into the defstate. Starting the datasource
  defstate requires the `plaid.server.config/config` defstate to be
  available too; we boot both with a one-shot in-memory config map
  pointing at our test DB path."
  (:require [clojure.test :refer :all]
            [migratus.core :as migratus]
            [mount.core :as mount]
            [next.jdbc :as jdbc]
            [next.jdbc.result-set :as rs]
            [plaid.server.config :as scfg]
            [plaid.server.sql :as ssql]
            [plaid.sql.common :as psc]
            [plaid.sql.project :as project]
            [plaid.sql.user :as user])
  (:import (java.io File)))

(defn- temp-db-path []
  (let [dir (File. (System/getProperty "java.io.tmpdir")
                   (str "plaid-restart-" (System/currentTimeMillis) "-" (rand-int 1000000)))]
    (.mkdirs dir)
    (.getAbsolutePath (File. dir "plaid.db"))))

(defn- migrate! [ds]
  (migratus/migrate {:store :database
                     :migration-dir "migrations"
                     :db {:datasource ds}}))

(defn- cleanup! [db-path]
  (doseq [suffix ["" "-wal" "-shm"]]
    (let [f (File. (str db-path suffix))]
      (when (.exists f) (.delete f))))
  (let [parent (.getParentFile (File. ^String db-path))]
    (when (.exists parent) (.delete parent))))

(defn- start-mount!
  "Start the config + datasource defstates with the supplied in-memory
  config. Stubs out the make-admin-user TTY prompt so the boot doesn't
  block waiting for stdin when the test DB has no users yet."
  [db-path]
  (mount/stop)
  (mount/start-with-states
   {#'scfg/config {:start (fn []
                            {:plaid.server.sql/config {:main-db-path db-path}})
                   :stop  (fn [] nil)}})
  (mount/start #'ssql/datasource)
  ssql/datasource)

(deftest project-survives-mount-stop-restart
  ;; The OLD version of this test inlined `PRAGMA wal_checkpoint(TRUNCATE)`
  ;; + `.close` and never went through `(mount/stop)`. A regression in
  ;; the `:stop` body (e.g. an exception swallowing the close) would
  ;; have gone unnoticed. Now we drive shutdown through mount.
  ;;
  ;; `make-admin-user` is private + only invoked when the boot finds
  ;; an empty users table; we stub it via `with-redefs` because that's
  ;; the on-disk state of our fresh per-test DB. Without this the
  ;; mount/start would block on a `read-line` waiting for TTY input.
  (let [db-path (temp-db-path)]
    (with-redefs [ssql/make-admin-user (fn [_ds] nil)]
      (try
        ;; --- Boot #1: mount, migrate, write data --------------------
        (let [ds1 (start-mount! db-path)
              _ (migrate! ds1)
              {:keys [extra]} (user/create ds1 "restart-test-admin@example.com" true "password")
              user-id extra
              {:keys [success extra]} (project/create
                                       ds1
                                       {:project/name "RestartTestProject"}
                                       user-id)
              project-id extra]
          (is success "project/create should succeed on boot #1")
          (is (some? project-id))
          (is (some? (project/get ds1 project-id))
              "project should be readable on the same pool that wrote it")
          ;; --- SIGTERM-style shutdown via mount ---------------------
          (mount/stop)
          ;; --- Boot #2: same file, fresh mount-driven pool ----------
          (let [ds2 (start-mount! db-path)]
            (try
              (let [refetched (project/get ds2 project-id)]
                (is (some? refetched)
                    "project must persist across mount-driven restart on the same file")
                (is (= "RestartTestProject" (:project/name refetched))))
              (let [audit-count (-> (jdbc/execute-one!
                                     ds2
                                     ["SELECT COUNT(*) AS c FROM audit_writes
                                       WHERE target_table = 'projects'
                                         AND target_id = ?"
                                      (str project-id)]
                                     {:builder-fn rs/as-unqualified-maps})
                                    :c)]
                (is (pos? audit-count)
                    (str "Expected at least one audit_writes row for the project; got "
                         audit-count " — audit log was lost across restart")))
              (finally (mount/stop)))))
        (finally
          (mount/stop)
          (cleanup! db-path))))))
