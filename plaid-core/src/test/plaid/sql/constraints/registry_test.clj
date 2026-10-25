(ns plaid.sql.constraints.registry-test
  "Every layer rule type is one entry of `plaid.sql.constraints.layer/registry`,
  and an entry that leaves out a key is caught here rather than by a rule
  that is never checked on its own writes or never remedied."
  (:require [clojure.test :refer [deftest is testing]]
            [plaid.sql.constraints.layer :as lc]))

(def ^:private entry-keys
  #{:kinds :params :validate :check :direct :phrase :wire-extra :remedy :rank})

(deftest every-entry-has-every-key
  (doseq [[t entry] lc/registry]
    (testing t
      (is (= entry-keys (set (keys entry))))
      (is (seq (:kinds entry)))
      (is (every? #{:token :span :relation} (:kinds entry)))
      (is (set? (:params entry)))
      (doseq [k [:validate :check :direct :phrase]]
        (is (ifn? (k entry)) (str k " is a function")))
      (is (= (some? (:remedy entry)) (some? (:rank entry)))
          "a type with a remedy has a rank, and only one with a remedy"))))

(deftest the-derived-tables
  (is (= {:token #{"coextensive" "single-link"}
          :span #{"single-span" "value-set"}
          :relation #{"max-in-degree" "acyclic" "same-ancestor" "value-set"}}
         lc/types-by-kind))
  (is (= #{"coextensive" "single-span" "single-link" "same-ancestor"} lc/remediable))
  (is (= ["coextensive" "single-span" "single-link" "same-ancestor"] lc/remedy-order)))
