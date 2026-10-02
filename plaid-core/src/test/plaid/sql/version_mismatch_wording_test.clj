(ns plaid.sql.version-mismatch-wording-test
  "R1-DEBT-CORE-14: a stale `document-version` is refused before the write
  lock (the REST pre-flight) and again inside the transaction, with one
  message for both."
  (:require [clojure.test :refer :all]
            [plaid.sql.audit-write :as psaw]
            [plaid.fixtures :refer [db with-db with-mount-states with-clean-db]]))

(use-fixtures :once with-db with-mount-states)
(use-fixtures :each with-clean-db)

(deftest the-in-transaction-check-says-what-the-pre-flight-says
  (let [e (try
            (binding [psaw/*expected-document-version* 3]
              (psaw/check-expected-document-version! db (random-uuid) :conflict))
            nil
            (catch clojure.lang.ExceptionInfo e e))]
    (is (some? e))
    (is (= 409 (:code (ex-data e))))
    (is (= psaw/version-mismatch (ex-message e)))
    (is (re-find #"^Document version mismatch\." psaw/version-mismatch))))
