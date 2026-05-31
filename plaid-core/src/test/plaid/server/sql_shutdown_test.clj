(ns plaid.server.sql-shutdown-test
  "Regression for #76: closing the datasource on shutdown must first
  checkpoint the WAL so the `.db-wal` / `.db-shm` sidecar files don't
  linger non-empty on disk. Without TRUNCATE-mode checkpoint the WAL
  stays at its high-water mark and operators see surprising file sizes
  after a clean shutdown."
  (:require [clojure.test :refer :all]
            [migratus.core :as migratus]
            [next.jdbc :as jdbc]
            [plaid.server.sql :as server-sql]
            [plaid.sql.common :as psc])
  (:import (java.io File)))

(defn- temp-db-path []
  (let [dir (File. (System/getProperty "java.io.tmpdir")
                   (str "plaid-shutdown-" (System/currentTimeMillis) "-" (rand-int 1000000)))]
    (.mkdirs dir)
    (.getAbsolutePath (File. dir "plaid.db"))))

(defn- without-checkpoint!
  "Mirror the mount :stop body but skip the checkpoint — to confirm the
  checkpoint actually does something."
  [ds]
  (.close ds))

(defn- with-checkpoint!
  "Mirror the actual mount :stop body."
  [ds]
  (#'server-sql/checkpoint-wal! ds)
  (.close ds))

(defn- run-scenario [stop-fn]
  (let [db-path (temp-db-path)
        ds (psc/build-datasource db-path)]
    (try
      (migratus/migrate {:store :database
                         :migration-dir "migrations"
                         :db {:datasource ds}})
      ;; Many writes so the WAL grows past trivial header-only bytes,
      ;; without crossing SQLite's auto-checkpoint threshold (1000 pages).
      (dotimes [_ 50]
        (jdbc/execute! ds ["INSERT INTO users (id, username, password_hash, is_admin) VALUES (?,?,?,?)"
                           (str (java.util.UUID/randomUUID))
                           (str "shutdown-test-" (System/nanoTime) "-" (rand-int 1000000))
                           "x"
                           0]))
      (stop-fn ds)
      {:db-path db-path
       :wal-size (let [f (File. (str db-path "-wal"))]
                   (if (.exists f) (.length f) :absent))
       :shm-size (let [f (File. (str db-path "-shm"))]
                   (if (.exists f) (.length f) :absent))}
      (finally
        (try (.close ds) (catch Exception _))
        (doseq [suffix ["" "-wal" "-shm"]]
          (let [f (File. (str db-path suffix))]
            (when (.exists f) (.delete f))))
        (.delete (.getParentFile (File. db-path)))))))

(deftest stop-checkpoints-wal-into-main-db
  (let [{:keys [wal-size shm-size]} (run-scenario with-checkpoint!)]
    (is (or (= :absent wal-size) (zero? wal-size))
        (str "After checkpoint+close, WAL sidecar must be empty or absent; got " wal-size))
    (is (or (= :absent shm-size) (zero? shm-size))
        (str "After checkpoint+close, SHM sidecar must be empty or absent; got " shm-size))))
