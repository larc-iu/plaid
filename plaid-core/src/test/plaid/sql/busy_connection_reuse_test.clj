(ns plaid.sql.busy-connection-reuse-test
  "A pooled connection whose BEGIN lost the write lock must still be usable.

  sqlite-jdbc's `setAutoCommit(false)` flips its own autocommit flag BEFORE
  issuing `BEGIN IMMEDIATE` and has no handler around that exec, so a
  SQLITE_BUSY there leaves the flag `false` with no transaction open. next.jdbc
  calls `setAutoCommit` outside its own try, and Hikari's proxy saw its call
  throw, so neither restores anything: the connection returns to the pool
  believing it is mid-transaction while SQLite is in autocommit mode.

  Left alone, every later borrow of that connection issues no BEGIN at all —
  writes commit one statement at a time and the closing `.commit` throws
  `cannot commit - no transaction is active`. The caller gets a fast, load-
  independent failure for writes that are already durable. `psc/heal-autocommit!`
  is what keeps that from happening; these tests pin both halves of it."
  (:require [clojure.test :refer :all]
            [next.jdbc :as jdbc]
            [plaid.sql.common :as psc])
  (:import (java.io File)
           (java.sql DriverManager)))

(defn- temp-db-path []
  (let [dir (File. (System/getProperty "java.io.tmpdir")
                   (str "plaid-busyreuse-" (System/currentTimeMillis) "-" (rand-int 1000000)))]
    (.mkdirs dir)
    (.getAbsolutePath (File. dir "plaid.db"))))

(defn- cleanup! [db-path]
  (doseq [suffix ["" "-wal" "-shm"]]
    (let [f (File. (str db-path suffix))]
      (when (.exists f) (.delete f))))
  (let [parent (.getParentFile (File. ^String db-path))]
    (when (.exists parent) (.delete parent))))

(defn- write! [ds v]
  (psc/with-tx [tx ds] (jdbc/execute! tx ["insert into t (v) values (?)" v])))

(defn- values [ds]
  (mapv :v (psc/q ds {:select :v :from :t :order-by [:id]})))

(deftest connection-survives-a-busy-begin
  (let [db-path (temp-db-path)
        ;; Pool of one, so the connection the blocked write poisons is
        ;; necessarily the one every later write draws. A short busy_timeout
        ;; keeps the test fast; the mechanism is timeout-independent.
        ds (psc/build-datasource db-path {:busy-timeout-ms 300 :max-pool-size 1})]
    (try
      (with-open [c (.getConnection ds)]
        (jdbc/execute! c ["create table t (id integer primary key, v text)"]))
      ;; A separate raw connection holds the write lock, outside the pool.
      (let [raw (DriverManager/getConnection (str "jdbc:sqlite:" db-path))]
        (doto (.createStatement raw)
          (.execute "PRAGMA busy_timeout=300")
          (.execute "BEGIN IMMEDIATE")
          (.execute "INSERT INTO t (v) VALUES ('blocker')"))
        (testing "a write that can't get the lock fails, and fails AS a busy"
          (let [e (is (thrown? Exception (write! ds "blocked")))]
            (is (psc/sqlite-busy? e)
                "must stay recognizable as contention so the REST layer says 503, not 500")))
        (testing "the blocked write left nothing behind"
          ;; Read on the raw connection: it owns the uncommitted blocker row.
          (let [rs (.executeQuery (.createStatement raw) "SELECT count(*) FROM t WHERE v = 'blocked'")]
            (.next rs)
            (is (zero? (.getInt rs 1)))))
        (.execute (.createStatement raw) "ROLLBACK")
        (.close raw))

      (testing "the same pooled connection still works once the lock is free"
        (is (some? (write! ds "after")))
        (is (some? (write! ds "after2")))
        (is (= ["after" "after2"] (values ds))))

      (testing "and is still transactional — a body that throws writes nothing"
        (is (thrown? clojure.lang.ExceptionInfo
                     (psc/with-tx [tx ds]
                       (jdbc/execute! tx ["insert into t (v) values ('doomed')"])
                       (throw (ex-info "boom" {})))))
        (is (= ["after" "after2"] (values ds))
            "a poisoned connection issues no BEGIN, so its writes would survive the rollback"))
      (finally
        (.close ds)
        (cleanup! db-path)))))

(deftest heal-autocommit-leaves-a-healthy-connection-alone
  (let [db-path (temp-db-path)
        ds (psc/build-datasource db-path {:max-pool-size 1})]
    (try
      (with-open [c (.getConnection ds)]
        (jdbc/execute! c ["create table t (id integer primary key, v text)"])
        (testing "a no-op on a connection that is already in autocommit"
          (is (.getAutoCommit c))
          (psc/heal-autocommit! c)
          (is (.getAutoCommit c))))
      (testing "an open transaction is DISCARDED, never committed"
        (with-open [c (.getConnection ds)]
          (.setAutoCommit c false)
          (jdbc/execute! c ["insert into t (v) values ('uncommitted')"])
          (psc/heal-autocommit! c)
          (is (.getAutoCommit c) "flag restored for the next borrower")))
      (is (= [] (values ds)) "heal-autocommit! must not turn a rollback into a commit")
      (finally
        (.close ds)
        (cleanup! db-path)))))
