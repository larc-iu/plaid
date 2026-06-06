(ns plaid.sql.query.exec-orderby-test
  "Integration tests for :order-by — the sort column is projected through the
  UNION and the ORDER BY is applied once at assembly (NULLS LAST)."
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
(defn- col [r] (mapv first (:results r)))           ; first find-col, in result order

(defn- build!
  "words 'aa bb cc dd' at offsets 0/3/6/9; pos spans whose VALUES sort in a
  different order than the token offsets (VERB/ADJ/NOUN/DET on t0..t3)."
  []
  (let [pid  (h/create-test-project admin-request "OrdProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "pos"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa bb cc dd"))
        t0 (id (h/create-token admin-request tokl text 0 2))
        t1 (id (h/create-token admin-request tokl text 3 5))
        t2 (id (h/create-token admin-request tokl text 6 8))
        t3 (id (h/create-token admin-request tokl text 9 11))]
    (h/create-span admin-request sl [t0] "VERB")
    (h/create-span admin-request sl [t1] "ADJ")
    (h/create-span admin-request sl [t2] "NOUN")
    (h/create-span admin-request sl [t3] "DET")
    {:t0 t0 :t1 t1 :t2 t2 :t3 t3}))

(deftest order-tokens-by-begin
  (let [{:keys [t0 t1 t2 t3]} (build!)]
    (testing "ascending by begin"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?t"]
                       "where" [["token" "?t" {"layer" "OrdProj/words"}]]
                       "order-by" [["?t" "begin"]]})]
        (is (= [(str t0) (str t1) (str t2) (str t3)] (mapv str (col r))))))
    (testing "descending by begin"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?t"]
                       "where" [["token" "?t" {"layer" "OrdProj/words"}]]
                       "order-by" [["?t" "begin" "desc"]]})]
        (is (= [(str t3) (str t2) (str t1) (str t0)] (mapv str (col r))))))))

(deftest order-spans-by-value
  (let [{:keys [t0 t1 t2 t3]} (build!)]
    (testing "spans sorted by value, independent of token offset order"
      ;; ADJ(t1) < DET(t3) < NOUN(t2) < VERB(t0). ?s must be a :find var to be an
      ;; order key (so its column is projected through any UNION).
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?t" "?s"]
                       "where" [["span" "?s" {"layer" "OrdProj/pos"}]
                                ["covers" "?s" "?t"]
                                ["token" "?t" {"layer" "OrdProj/words"}]]
                       "order-by" [["?s" "value"]]})]
        (is (= [(str t1) (str t3) (str t2) (str t0)] (mapv str (col r))))))))

(deftest order-by-survives-union
  (let [{:keys [t0 t1 t3]} (build!)]
    (testing ":order-by sorts across an :or UNION"
      ;; tokens that are VERB(t0) OR DET(t3) OR begin=3(t1) — sorted by begin
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?t"]
                       "where" [["token" "?t" {"layer" "OrdProj/words"}]
                                ["or"
                                 [["span" "?s" {"layer" "OrdProj/pos" "value" ["VERB" "DET"]}]
                                  ["covers" "?s" "?t"]]
                                 [["token" "?t" {"begin" 3}]]]]
                       "order-by" [["?t" "begin"]]})]
        (is (= [(str t0) (str t1) (str t3)] (mapv str (col r))))))))

(deftest order-by-validation
  (build!)
  (testing "ordering by a non-:find var is a 400"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"order-by may only reference :find vars"
         (ast/expand {"find" ["?t"]
                      "where" [["span" "?s" {"layer" "OrdProj/pos"}]
                               ["covers" "?s" "?t"]
                               ["token" "?t" {"layer" "OrdProj/words"}]]
                      "order-by" [["?s" "value"]]}))))
  (testing "ordering a token by :value (not a token attribute) is a 400"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"unknown field"
         (ast/expand {"find" ["?t"]
                      "where" [["token" "?t" {"layer" "OrdProj/words"}]]
                      "order-by" [["?t" "value"]]}))))
  (testing "a ?__-prefixed find var is reserved (would collide with __ord_N) -> 400"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"reserved"
         (ast/expand {"find" ["?__ord_0"]
                      "where" [["token" "?__ord_0" {"layer" "OrdProj/words"}]]})))))
