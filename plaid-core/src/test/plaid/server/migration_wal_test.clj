(ns plaid.server.migration-wal-test
  "A migration that rewrites a big table (20260927130000 rebuilds
  `audit_writes`) runs in one transaction, so every page it writes lands in
  the WAL first: 3.6 GB on a 4.2 GB copy. SQLite reuses a WAL after a
  checkpoint but never shrinks it, so without a TRUNCATE checkpoint the file
  stays that size for as long as the server runs. Startup truncates it once
  the migrations are done."
  (:require [clojure.test :refer [deftest is]]
            [plaid.server.sql :as server-sql]
            [plaid.sql.datasource :as psd])
  (:import (java.io File)))

(defn- temp-db-path []
  (let [dir (File. (System/getProperty "java.io.tmpdir")
                   (str "plaid-migration-wal-" (System/nanoTime)))]
    (.mkdirs dir)
    (.getAbsolutePath (File. dir "plaid.db"))))

(deftest the-wal-is-empty-after-the-migrations-while-the-pool-stays-open
  (let [path (temp-db-path)
        ds (psd/build-datasource path)]
    (try
      (#'server-sql/run-migrations! ds)
      (let [wal (File. (str path "-wal"))]
        (is (or (not (.exists wal)) (zero? (.length wal)))
            (str "WAL is " (.length wal) " bytes after the migrations")))
      (finally
        (.close ds)
        (doseq [suffix ["" "-wal" "-shm"]]
          (.delete (File. (str path suffix))))
        (.delete (.getParentFile (File. path)))))))
