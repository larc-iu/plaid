(ns plaid.sql.query.exec-aggregate-test
  "Integration tests for aggregate :return — {group [...] aggregates [[op src?]...]}
  → GROUP BY over the distinct-match set. count/min/max/avg/sum."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h]
            [plaid.sql.query.exec :as qe]
            [plaid.query.ast :as ast]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [r] (-> r :body :id))

(defn- build!
  "doc d1: 3 word tokens (begin 0/3/6); doc d2: 2 word tokens (begin 0/3).
  pos spans on d1 with numeric values 10, 20, 30."
  []
  (let [pid  (h/create-test-project admin-request "AggProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "pos"))
        d1   (h/create-test-document admin-request pid "d1")
        d2   (h/create-test-document admin-request pid "d2")
        tx1  (id (h/create-text admin-request txtl d1 "aa bb cc"))
        tx2  (id (h/create-text admin-request txtl d2 "aa bb"))
        t10 (id (h/create-token admin-request tokl tx1 0 2))
        t11 (id (h/create-token admin-request tokl tx1 3 5))
        t12 (id (h/create-token admin-request tokl tx1 6 8))
        _t20 (id (h/create-token admin-request tokl tx2 0 2))
        _t21 (id (h/create-token admin-request tokl tx2 3 5))]
    (h/create-span admin-request sl [t10] 10)
    (h/create-span admin-request sl [t11] 20)
    (h/create-span admin-request sl [t12] 30)
    {:d1 d1 :d2 d2}))

(defn- by-key [r]
  "Map the first result column -> the rest of the row."
  (into {} (map (fn [row] [(str (first row)) (vec (rest row))]) (:results r))))

(deftest grouped-count-per-document
  (let [{:keys [d1 d2]} (build!)]
    (testing "word count per document in ONE query"
      (let [r (qe/run db "admin@example.com"
                      {"where" [["token" "?t" {"layer" "AggProj/words" "doc" {"var" "?d"}}]]
                       "return" {"group" ["?d"] "aggregates" [["count"]]}})]
        (is (= :aggregate (:return r)))
        (is (= ["d" "count"] (:columns r)))
        (is (= {(str d1) [3] (str d2) [2]} (by-key r)))))))

(deftest overall-count-no-group
  (build!)
  (testing "no group keys -> a single overall row (generalizes return:count)"
    (let [r (qe/run db "admin@example.com"
                    {"where" [["token" "?t" {"layer" "AggProj/words"}]]
                     "return" {"group" [] "aggregates" [["count"]]}})]
      (is (= [[5]] (:results r))))))

(deftest min-max-avg-over-begin
  (let [{:keys [d1 d2]} (build!)]
    (testing "min/max/avg of a numeric scalar (token begin) per document"
      (let [r (qe/run db "admin@example.com"
                      {"where" [["token" "?t" {"layer" "AggProj/words" "doc" {"var" "?d"} "begin" {"var" "?b"}}]]
                       "return" {"group" ["?d"]
                                 "aggregates" [["min" "?b"] ["max" "?b"] ["avg" "?b"]]}})
            m (by-key r)]
        (is (= ["d" "min_b" "max_b" "avg_b"] (:columns r)))
        (is (= [0 6 3.0] (get m (str d1))))
        (is (= [0 3] (subvec (get m (str d2)) 0 2)))
        (is (= 1.5 (double (nth (get m (str d2)) 2))))))))

(deftest sum-avg-over-numeric-value
  (build!)
  (testing "sum/avg over a JSON-encoded numeric :value (json_extract-decoded)"
    (let [r (qe/run db "admin@example.com"
                    {"where" [["span" "?s" {"layer" "AggProj/pos" "value" {"var" "?v"}}]]
                     "return" {"group" [] "aggregates" [["sum" "?v"] ["avg" "?v"]]}})]
      (is (= [[60 20.0]] (:results r))))))

(deftest aggregate-validation
  (testing ":find is rejected alongside an aggregate :return"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #":find is not used with an aggregate"
         (ast/expand {"find" ["?t"]
                      "where" [["token" "?t" {"layer" "AggProj/words"}]]
                      "return" {"group" [] "aggregates" [["count"]]}}))))
  (testing "an aggregate source must be a value variable, not an entity"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"must be a value variable"
         (ast/expand {"where" [["token" "?t" {"layer" "AggProj/words"}]]
                      "return" {"group" [] "aggregates" [["avg" "?t"]]}}))))
  (testing "count takes no source"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"takes no source"
         (ast/expand {"where" [["token" "?t" {"layer" "AggProj/words" "begin" {"var" "?b"}}]]
                      "return" {"group" [] "aggregates" [["count" "?b"]]}}))))
  (testing "an unknown aggregate op is a 400"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"is not supported"
         (ast/expand {"where" [["token" "?t" {"layer" "AggProj/words" "begin" {"var" "?b"}}]]
                      "return" {"group" [] "aggregates" [["median" "?b"]]}})))))
