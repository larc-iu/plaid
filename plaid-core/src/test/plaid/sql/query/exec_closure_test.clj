(ns plaid.sql.query.exec-closure-test
  "Integration tests for :related* — transitive closure over relation edges
  (source_span_id -> target_span_id) via a correlated recursive CTE."
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
(defn- vals-of [r]
  (set (map (fn [[sid]] (:span/value (:body (h/get-span admin-request sid)))) (:results r))))

(defn- build!
  "node spans A,B,C,D; dep relations A->B (det), B->C (nsubj). D is isolated."
  []
  (let [pid  (h/create-test-project admin-request "ClsProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        nl   (id (h/create-span-layer admin-request tokl "node"))
        dl   (id (h/create-relation-layer admin-request nl "dep"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa bb cc dd"))
        mk   (fn [b e v] (let [t (id (h/create-token admin-request tokl text b e))]
                           (id (h/create-span admin-request nl [t] v))))
        a (mk 0 2 "A") b (mk 3 5 "B") c (mk 6 8 "C") d (mk 9 11 "D")]
    (h/create-relation admin-request dl a b "det")
    (h/create-relation admin-request dl b c "nsubj")
    {:dl dl :a a :b b :c c :d d}))

(deftest related-is-transitive
  (build!)
  (testing "A reaches B directly AND C transitively (A->B->C); never D"
    (let [r (qe/run db "admin@example.com"
                    {"find" ["?b"]
                     "where" [["span" "?a" {"layer" "ClsProj/node" "value" "A"}]
                              ["span" "?b" {"layer" "ClsProj/node"}]
                              ["related*" "?a" "?b" {"layer" "ClsProj/dep"}]]})]
      (is (= #{"B" "C"} (vals-of r))))))

(deftest related-all-pairs
  (build!)
  (testing "all reachable (source,target) pairs: A->B, A->C, B->C"
    (let [r (qe/run db "admin@example.com"
                    {"find" ["?a" "?b"]
                     "where" [["span" "?a" {"layer" "ClsProj/node"}]
                              ["span" "?b" {"layer" "ClsProj/node"}]
                              ["related*" "?a" "?b" {"layer" "ClsProj/dep"}]]})
          pairs (set (map (fn [[sa sb]]
                            [(:span/value (:body (h/get-span admin-request sa)))
                             (:span/value (:body (h/get-span admin-request sb)))])
                          (:results r)))]
      (is (= #{["A" "B"] ["A" "C"] ["B" "C"]} pairs)))))

(deftest related-value-filter
  (build!)
  (testing "constraining the edge value to det stops the path after one hop"
    ;; only the A->B (det) edge qualifies; B->C is nsubj, so C is unreachable
    (let [r (qe/run db "admin@example.com"
                    {"find" ["?b"]
                     "where" [["span" "?a" {"layer" "ClsProj/node" "value" "A"}]
                              ["span" "?b" {"layer" "ClsProj/node"}]
                              ["related*" "?a" "?b" {"layer" "ClsProj/dep" "value" "det"}]]})]
      (is (= #{"B"} (vals-of r))))))

(deftest related-validation
  (testing ":related* without a :layer is a 400"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"requires a constraint map with a :layer"
         (ast/expand {"find" ["?a" "?b"]
                      "where" [["span" "?a" {"layer" "ClsProj/node"}]
                               ["span" "?b" {"layer" "ClsProj/node"}]
                               ["related*" "?a" "?b"]]}))))
  (testing ":related* span vars unify with their span clauses (token var conflicts)"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"both"
         (ast/expand {"find" ["?t"]
                      "where" [["token" "?t" {"layer" "ClsProj/words"}]
                               ["span" "?b" {"layer" "ClsProj/node"}]
                               ["related*" "?t" "?b" {"layer" "ClsProj/dep"}]]})))))
