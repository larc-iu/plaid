(ns plaid.sql.operation-kinds-test
  "The operation kinds as a case file both clients read, so neither scrapes
  core's source for the set (beta review R2-TEST-12)."
  (:require [clojure.data.json :as json]
            [clojure.java.io :as io]
            [clojure.test :refer [deftest is]]
            [plaid.sql.operation-group :as og]))

(deftest the-case-file-holds-every-kind
  (let [listed (get (json/read-str (slurp (io/file "src/test/plaid/sql/operation_kinds.json"))) "kinds")]
    (is (= (count listed) (count (set listed))) "a kind is listed twice")
    (is (= og/kinds (set listed))
        (str "src/test/plaid/sql/operation_kinds.json is stale: write plaid.sql.operation-group/kinds "
             "into it, then the clients' lists and the manual's table follow"))))
