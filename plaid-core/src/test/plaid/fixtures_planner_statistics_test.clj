(ns plaid.fixtures-planner-statistics-test
  "Planner statistics a test gathers do not outlive it. `with-clean-db`
  deleted rows and kept `sqlite_stat1`, so a test that ran ANALYZE on a
  three-span project left every later test in the JVM planned as if its
  tables held three rows: `related*` over 4,000 spans then ran past the
  30 s query limit in the nightly's shard, and passed alone."
  (:require [clojure.test :refer [deftest is use-fixtures]]
            [next.jdbc :as jdbc]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-clean-db db admin-request]]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :as h]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)

(defn- statistics-tables []
  (mapv :sqlite_master/name
        (jdbc/execute! db ["SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'sqlite_stat%'"])))

(deftest a-tests-analyze-does-not-outlive-the-test
  (with-clean-db
    (fn []
      (let [p (h/create-test-project admin-request "Tiny")
            tl (-> (h/create-text-layer admin-request p "T") :body :id)]
        (h/create-token-layer admin-request tl "W")
        (psc/execute! db ["ANALYZE"])
        (is (seq (statistics-tables)) "the test itself sees its statistics"))))
  (is (empty? (statistics-tables)) "no statistics table is left after the test"))
