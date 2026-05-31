(ns plaid.sql.sqlite-busy-test
  "Task #73: SQLITE_BUSY (the lock-contention result code; primary value
  5) used to fall through to the generic `(catch Exception ...)` branch
  in `submit-operation*`, projecting to a generic 500 with the raw JDBC
  error string — to a client this looks like a server bug rather than
  the retry-friendly transient-failure it actually is.

  Fix: the `(catch SQLException ...)` branch checks the result code (5
  / 6) and the message string, and projects to `{:success false :code
  503 :error \"Database busy, please retry\"}`.

  We verify the catch by directly throwing a `SQLiteException` from
  inside a body — exercising real lock contention would need a
  multi-thread harness coordinating two writers against the same DB,
  which is more machinery than this regression warrants."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.sql.operation :as op]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin with-clean-db]])
  (:import [org.sqlite SQLiteException SQLiteErrorCode]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(deftest sqlite-busy-translated-to-503
  (testing "a SQLITE_BUSY thrown from inside a body is projected to a
            503 with a retry-friendly message (not a raw 500)"
    (let [result (op/submit-operation*
                  db
                  {:type :test/busy
                   :project nil
                   :document nil
                   :description "Provoke SQLITE_BUSY"
                   :user nil}
                  (fn [_tx]
                    (throw (SQLiteException. "database is locked"
                                             SQLiteErrorCode/SQLITE_BUSY))))]
      (is (false? (:success result)))
      (is (= 503 (:code result)))
      (is (= "Database busy, please retry" (:error result)))))

  (testing "SQLITE_LOCKED is also treated as retry-friendly"
    (let [result (op/submit-operation*
                  db
                  {:type :test/busy
                   :project nil
                   :document nil
                   :description "Provoke SQLITE_LOCKED"
                   :user nil}
                  (fn [_tx]
                    (throw (SQLiteException. "database table is locked"
                                             SQLiteErrorCode/SQLITE_LOCKED))))]
      (is (= 503 (:code result)))))

  (testing "a non-busy SQLException (e.g. constraint violation) still
            falls through to a 500"
    (let [result (op/submit-operation*
                  db
                  {:type :test/sql-err
                   :project nil
                   :document nil
                   :description "Provoke a non-busy SQL error"
                   :user nil}
                  (fn [_tx]
                    (throw (java.sql.SQLException.
                            "syntax error somewhere"))))]
      (is (= 500 (:code result)))
      (is (false? (:success result))))))
