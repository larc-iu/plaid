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
  independent failure for writes that are already durable. `psd/heal-autocommit!`
  is what keeps that from happening; these tests pin both halves of it."
  (:require [clojure.string :as str]
            [clojure.test :refer :all]
            [next.jdbc :as jdbc]
            [plaid.sql.common :as psc]
            [plaid.sql.datasource :as psd]
            [taoensso.timbre :as timbre])
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
  (psd/with-tx [tx ds] (jdbc/execute! tx ["insert into t (v) values (?)" v])))

(defn- values [ds]
  (mapv :v (psc/q ds {:select :v :from :t :order-by [:id]})))

(deftest connection-survives-a-busy-begin
  (let [db-path (temp-db-path)
        ;; Pool of one, so the connection the blocked write poisons is
        ;; necessarily the one every later write draws. A short busy_timeout
        ;; keeps the test fast; the mechanism is timeout-independent.
        ds (psd/build-datasource db-path {:busy-timeout-ms 300 :max-pool-size 1})]
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
            (is (psd/sqlite-busy? e)
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
                     (psd/with-tx [tx ds]
                       (jdbc/execute! tx ["insert into t (v) values ('doomed')"])
                       (throw (ex-info "boom" {})))))
        (is (= ["after" "after2"] (values ds))
            "a poisoned connection issues no BEGIN, so its writes would survive the rollback"))
      (finally
        (.close ds)
        (cleanup! db-path)))))

(deftest heal-autocommit-leaves-a-healthy-connection-alone
  (let [db-path (temp-db-path)
        ds (psd/build-datasource db-path {:max-pool-size 1})]
    (try
      (with-open [c (.getConnection ds)]
        (jdbc/execute! c ["create table t (id integer primary key, v text)"])
        (testing "a no-op on a connection that is already in autocommit"
          (is (.getAutoCommit c))
          (psd/heal-autocommit! c)
          (is (.getAutoCommit c))))
      (testing "an open transaction is DISCARDED, never committed"
        (with-open [c (.getConnection ds)]
          (.setAutoCommit c false)
          (jdbc/execute! c ["insert into t (v) values ('uncommitted')"])
          (psd/heal-autocommit! c)
          (is (.getAutoCommit c) "flag restored for the next borrower")))
      (is (= [] (values ds)) "heal-autocommit! must not turn a rollback into a commit")
      (finally
        (.close ds)
        (cleanup! db-path)))))

;; ------------------------------------------------------------------
;; The end of a transaction must not open another one.
;;
;; sqlite-jdbc's `commit()` and `rollback()` each issue the next
;; `BEGIN IMMEDIATE` straight after their COMMIT or ROLLBACK, in the same
;; call, so a JDBC connection with autocommit off is never outside a
;; transaction. That second BEGIN has to take the write lock again, the
;; instant it was released, and under load another writer parked in its
;; busy_timeout wins it: the BEGIN waits out busy_timeout and fails. The
;; write itself was already committed, but `.commit` throws, next.jdbc's
;; rollback finds no transaction, `heal-autocommit!` resets the driver's
;; flag while Hikari's proxy still believes autocommit is off, and the
;; proxy's close rolls back a connection in autocommit mode: a 500
;; "database in auto-commit mode" for a write that landed.
;;
;; `PRAGMA query_only` stands in for the other writer here: it makes that
;; second BEGIN IMMEDIATE fail every time (SQLITE_READONLY rather than
;; SQLITE_BUSY), after the body's work has ended normally.

(defn- reset-query-only! [ds]
  (with-open [c (.getConnection ds)]
    (jdbc/execute! c ["PRAGMA query_only=0"])))

(deftest a-commit-answers-for-the-write-it-committed
  (let [db-path (temp-db-path)
        ds (psd/build-datasource db-path {:busy-timeout-ms 300 :max-pool-size 1})]
    (try
      (with-open [c (.getConnection ds)]
        (jdbc/execute! c ["create table t (id integer primary key, v text)"]))
      (testing "a body that ends normally commits and says so"
        (is (= :done (psd/with-tx [tx ds]
                       (jdbc/execute! tx ["insert into t (v) values ('landed')"])
                       (jdbc/execute! tx ["PRAGMA query_only=1"])
                       :done))
            "no error for a write that is durable")
        (reset-query-only! ds)
        (is (= ["landed"] (values ds))))
      (testing "the connection is still transactional afterwards"
        (is (thrown-with-msg? clojure.lang.ExceptionInfo #"boom"
                              (psd/with-tx [tx ds]
                                (jdbc/execute! tx ["insert into t (v) values ('doomed')"])
                                (throw (ex-info "boom" {})))))
        (is (= ["landed"] (values ds))))
      (finally
        (.close ds)
        (cleanup! db-path)))))

(deftest a-rollback-rethrows-the-bodys-own-error
  (let [db-path (temp-db-path)
        ds (psd/build-datasource db-path {:busy-timeout-ms 300 :max-pool-size 1})]
    (try
      (with-open [c (.getConnection ds)]
        (jdbc/execute! c ["create table t (id integer primary key, v text)"]))
      (testing "the caller sees the body's error, not the pool's"
        (is (thrown-with-msg? clojure.lang.ExceptionInfo #"boom"
                              (psd/with-tx [tx ds]
                                (jdbc/execute! tx ["insert into t (v) values ('doomed')"])
                                (jdbc/execute! tx ["PRAGMA query_only=1"])
                                (throw (ex-info "boom" {}))))))
      (reset-query-only! ds)
      (is (= [] (values ds)) "rolled back")
      (testing "and the connection goes on working, in transactions"
        (is (some? (write! ds "after")))
        (is (thrown? clojure.lang.ExceptionInfo
                     (psd/with-tx [tx ds]
                       (jdbc/execute! tx ["insert into t (v) values ('doomed2')"])
                       (throw (ex-info "boom" {})))))
        (is (= ["after"] (values ds))))
      (finally
        (.close ds)
        (cleanup! db-path)))))

(deftest parallel-writers-get-an-answer-that-is-true
  ;; The load the reviewers ran, in miniature: several writers on a pool,
  ;; a short busy_timeout. Every write either lands and says so, or fails
  ;; as contention (a 503) and leaves nothing. Nothing else.
  (let [db-path (temp-db-path)
        ds (psd/build-datasource db-path {:busy-timeout-ms 100 :max-pool-size 8})
        threads 8
        per-thread 150]
    (try
      (with-open [c (.getConnection ds)]
        (jdbc/execute! c ["create table t (id integer primary key, v text)"]))
      (let [outcomes (->> (range threads)
                          (mapv (fn [i]
                                  (future
                                    (vec (for [j (range per-thread)
                                               :let [v (str i "-" j)]]
                                           (try
                                             (psd/with-tx [tx ds]
                                               (jdbc/execute! tx ["insert into t (v) values (?)" v])
                                               (jdbc/execute! tx ["select count(*) from t"]))
                                             [v :ok]
                                             (catch Exception e
                                               (if (psd/sqlite-busy? e)
                                                 [v :busy]
                                                 [v :error (.getMessage e)]))))))))
                          (mapcat deref)
                          vec)
            landed (set (values ds))]
        (is (= [] (filterv #(= :error (second %)) outcomes))
            "no failure other than contention")
        (is (= [] (filterv (fn [[v k]] (and (= :busy k) (landed v))) outcomes))
            "a write refused as busy left nothing behind")
        (is (= [] (filterv (fn [[v k]] (and (= :ok k) (not (landed v)))) outcomes))
            "a write that said it landed did"))
      (finally
        (.close ds)
        (cleanup! db-path)))))

;; ------------------------------------------------------------------
;; A COMMIT that finds no transaction means SQLite ended the transaction
;; partway through the body (SQLITE_FULL, IOERR, NOMEM, INTERRUPT), and what
;; the body ran after that committed statement by statement. It must be
;; logged as an error, never mistaken for contention.

(deftest a-commit-with-no-transaction-is-logged-as-an-error
  (let [db-path (temp-db-path)
        ds (psd/build-datasource db-path {:max-pool-size 1})
        logged (atom [])]
    (try
      (with-open [c (.getConnection ds)]
        (jdbc/execute! c ["create table t (id integer primary key, v text)"]))
      (timbre/with-merged-config
        {:appenders {:capture {:enabled? true
                               :fn (fn [{:keys [level vargs]}]
                                     (swap! logged conj [level (str/join " " vargs)]))}}}
        (let [e (is (thrown? Exception
                             (psd/with-tx [tx ds]
                               (jdbc/execute! tx ["insert into t (v) values ('before')"])
                               (jdbc/execute! tx ["ROLLBACK"])
                               (jdbc/execute! tx ["insert into t (v) values ('after')"]))))]
          (is (not (psd/sqlite-busy? e)))))
      (is (some (fn [[level msg]] (and (= :error level) (str/includes? msg "partly"))) @logged)
          "an ERROR saying the write may have partly landed")
      (finally
        (.close ds)
        (cleanup! db-path)))))

;; A pool that is not Hikari cannot evict. Its connection must still never
;; go back holding the transaction that a failed COMMIT left open.

(defn- pooled-datasource
  "A DataSource that hands out one physical connection again and again, its
  `close` a no-op, as a pool's checkout does."
  [physical]
  (reify javax.sql.DataSource
    (getConnection [_]
      (java.lang.reflect.Proxy/newProxyInstance
       (.getClassLoader java.sql.Connection)
       (into-array Class [java.sql.Connection])
       (reify java.lang.reflect.InvocationHandler
         (invoke [_ _ method args]
           (case (.getName method)
             "close" nil
             "unwrap" physical
             "isWrapperFor" true
             (.invoke method physical args))))))))

(deftest a-failed-commit-on-another-pool-lets-the-write-lock-go
  (let [db-path (temp-db-path)
        physical (DriverManager/getConnection (str "jdbc:sqlite:" db-path))
        ds (pooled-datasource physical)]
    (try
      (doseq [sql ["PRAGMA foreign_keys=ON"
                   "create table p (id integer primary key)"
                   "create table c (pid integer references p(id) deferrable initially deferred)"]]
        (jdbc/execute! physical [sql]))
      (is (thrown? Exception
                   (psd/with-tx [tx ds]
                     (jdbc/execute! tx ["insert into c (pid) values (99)"])))
          "the deferred FK refuses the COMMIT, which leaves the transaction open")
      (with-open [other (DriverManager/getConnection (str "jdbc:sqlite:" db-path))]
        (is (some? (doto (.createStatement other)
                     (.execute "PRAGMA busy_timeout=0")
                     (.execute "BEGIN IMMEDIATE")
                     (.execute "ROLLBACK")))
            "another connection takes the write lock at once"))
      (finally
        (try (.close physical) (catch Exception _))
        (cleanup! db-path)))))
