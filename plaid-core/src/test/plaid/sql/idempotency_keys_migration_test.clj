(ns plaid.sql.idempotency-keys-migration-test
  "The idempotency-keys migration goes down and up again cleanly."
  (:require [clojure.test :refer [deftest is]]
            [migratus.core :as migratus]
            [next.jdbc :as jdbc]
            [plaid.sql.datasource :as psd])
  (:import (java.io File)))

(def ^:private migration-id 20260930120000)

(defn- objects [ds]
  (set (map :name (jdbc/execute! ds ["SELECT name FROM sqlite_master WHERE name LIKE '%idempotency%' OR name = 'idx_audit_writes_deleted'"]
                                 {:builder-fn next.jdbc.result-set/as-unqualified-lower-maps}))))

(deftest down-and-up
  (let [dir (doto (File. (System/getProperty "java.io.tmpdir")
                         (str "plaid-idem-migr-" (System/nanoTime)))
              (.mkdirs))
        path (.getAbsolutePath (File. dir "plaid.db"))
        ds (psd/build-datasource path)
        cfg {:store :database :migration-dir "migrations" :db {:datasource ds}}
        all #{"idempotency_keys" "idx_idempotency_keys_created" "idx_audit_writes_deleted"}]
    (try
      (migratus/migrate cfg)
      (is (every? (objects ds) all))
      (migratus/down cfg migration-id)
      (is (empty? (filter all (objects ds))))
      (migratus/up cfg migration-id)
      (is (every? (objects ds) all))
      (finally
        (try (.close ^java.io.Closeable ds) (catch Exception _))
        (doseq [suffix ["" "-wal" "-shm"]]
          (.delete (File. (str path suffix))))
        (.delete dir)))))
