(ns plaid.sql.common-precondition-test
  "Regression for #63: write helpers must fail fast when called outside
  submit-operation!. If they didn't, calling `insert!` with a DataSource
  in autoCommit mode would commit the row before `record-audit-write!`
  even fires, leaving the audit log inconsistent with the data."
  (:require [clojure.test :refer :all]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    with-admin with-clean-db]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(deftest insert!-outside-submit-operation-throws
  ;; Call insert! directly against the DataSource with *op* unbound. The
  ;; precondition guard should reject the call before any SQL executes
  ;; (no row is inserted, no audit row is emitted). Use a fake table /
  ;; row — we never reach SQL formatting, so the shape can be minimal.
  (let [thrown (try
                 (psc/insert! db :projects {:id (psc/new-uuid) :name "x"})
                 nil
                 (catch clojure.lang.ExceptionInfo e e))]
    (is (some? thrown) "insert! must throw when *op* is nil")
    (is (= 500 (:code (ex-data thrown))))
    (is (= "write helper called outside submit-operation!"
           (:message (ex-data thrown)))
        "ex-info data carries the canonical :message")))
