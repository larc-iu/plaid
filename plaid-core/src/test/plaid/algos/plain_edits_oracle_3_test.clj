(ns plaid.algos.plain-edits-oracle-3-test
  "The plain-edits oracle's main property test on part 3 of three of the
  configs (see `plaid.algos.plain-edits-oracle-test`). Its own namespace so
  the suite's runner can give it a JVM of its own."
  (:require [clojure.test :refer [deftest]]
            [plaid.algos.plain-edits-oracle :refer [check-configs! configs-of-part]]))

(deftest a-plain-layer-takes-every-edit-the-plain-way
  (check-configs! (configs-of-part 2 3)))
