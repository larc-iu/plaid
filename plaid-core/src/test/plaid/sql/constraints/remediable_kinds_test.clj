(ns plaid.sql.constraints.remediable-kinds-test
  "The layer rule types, and those with a remedy in the order the remedies
  run, as a case file both clients and plaid-ui read, so none of them keeps a
  list of its own that drifts from the registry (beta review R2-CORE-1)."
  (:require [clojure.data.json :as json]
            [clojure.java.io :as io]
            [clojure.test :refer [deftest is]]
            [plaid.sql.constraints.layer :as lc]))

(def ^:private case-file "src/test/plaid/sql/constraints/remediable_kinds.json")

(deftest the-case-file-holds-the-registry
  (let [{:strs [types remediable]} (json/read-str (slurp (io/file case-file)))
        stale (str case-file " is stale: write plaid.sql.constraints.layer/registry's types and "
                   "remedy-order into it, then the clients' and plaid-ui's lists follow")]
    (is (= (sort (keys lc/registry)) types) stale)
    (is (= lc/remedy-order remediable) stale)
    (is (= lc/remediable (set remediable)) stale)))
