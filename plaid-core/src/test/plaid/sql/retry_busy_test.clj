(ns plaid.sql.retry-busy-test
  "The one rule for a background step that loses the write lock: tried again
  while SQLite answers busy, any other failure at once, and never once the
  pool is closed (R1-DEBT-CORE-25: a project removal and its history purge
  each had their own loop, and the removal's tried again on any failure)."
  (:require [clojure.test :refer [deftest is testing]]
            [plaid.sql.datasource :as psd])
  (:import (com.zaxxer.hikari HikariDataSource)
           (org.sqlite SQLiteErrorCode SQLiteException)))

(defn- busy [] (SQLiteException. "[SQLITE_BUSY] The database file is locked" SQLiteErrorCode/SQLITE_BUSY))

(defn- failing [n e]
  (let [calls (atom 0)]
    [calls (fn [] (if (<= (swap! calls inc) n) (throw e) :done))]))

(deftest retry-busy
  (with-redefs [psd/pool-closed? (constantly false)]
    (testing "busy, then through"
      (let [[calls f] (failing 1 (busy))]
        (is (= :done (psd/retry-busy nil "step" 3 f)))
        (is (= 2 @calls))))
    (testing "busy every time: thrown after the attempts"
      (let [[calls f] (failing 5 (busy))]
        (is (thrown? SQLiteException (psd/retry-busy nil "step" 2 f)))
        (is (= 2 @calls))))
    (testing "any other failure at once"
      (let [[calls f] (failing 1 (ex-info "broken" {}))]
        (is (thrown? clojure.lang.ExceptionInfo (psd/retry-busy nil "step" 3 f)))
        (is (= 1 @calls)))))
  (testing "never once the pool is closed"
    (let [pool (doto (HikariDataSource.) (.close))
          [calls f] (failing 1 (busy))]
      (is (thrown? SQLiteException (psd/retry-busy pool "step" 3 f)))
      (is (= 1 @calls)))))
