(ns plaid.sql.query.exec-or-test
  "Integration tests for clause-level disjunction (:or): union semantics,
  distribution of surrounding conjunctive clauses, and dedup across branches."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [r] (-> r :body :id))
(defn- tuples [r] (mapv (fn [t] (mapv str t)) (:results r)))

(defn- build!
  "words 'aa bb cc' with POS spans NOUN VERB NOUN over its three tokens."
  []
  (let [pid  (h/create-test-project admin-request "OrProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "pos"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa bb cc"))
        t0 (id (h/create-token admin-request tokl text 0 2))
        t1 (id (h/create-token admin-request tokl text 3 5))
        t2 (id (h/create-token admin-request tokl text 6 8))]
    {:noun0 (id (h/create-span admin-request sl [t0] "NOUN"))
     :verb1 (id (h/create-span admin-request sl [t1] "VERB"))
     :noun2 (id (h/create-span admin-request sl [t2] "NOUN"))
     :t0 t0 :t1 t1 :t2 t2}))

(deftest or-is-union
  (let [{:keys [noun0 verb1 noun2]} (build!)]
    (testing "a span tagged NOUN OR VERB returns all three (the marquee disjunction case)"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?s"]
                       "where" [["or" [["span" "?s" {"layer" "OrProj/pos" "value" "NOUN"}]]
                                 [["span" "?s" {"layer" "OrProj/pos" "value" "VERB"}]]]]})]
        (is (= 3 (:count r)))
        (is (= #{(str noun0) (str verb1) (str noun2)} (set (map first (tuples r)))))))))

(deftest or-distributes-conjunctive-clauses
  (let [{:keys [t0 t1 t2]} (build!)]
    (testing "tokens covered by a span that is NOUN or VERB — the outer :covers applies in both branches"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?t"]
                       "where" [["covers" "?s" "?t"]
                                ["or" [["span" "?s" {"layer" "OrProj/pos" "value" "NOUN"}]]
                                 [["span" "?s" {"layer" "OrProj/pos" "value" "VERB"}]]]]})]
        (is (= #{(str t0) (str t1) (str t2)} (set (map first (tuples r)))))))))

(deftest or-dedups-rows-matching-both-branches
  (let [{:keys [noun0 verb1 noun2]} (build!)]
    (testing "a row satisfying BOTH branches is returned once (UNION set semantics)"
      ;; branch 1 = NOUN spans (2); branch 2 = all pos spans (3). The 2 NOUNs
      ;; satisfy both, so the union is 3 distinct, not 5.
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?s"]
                       "where" [["or" [["span" "?s" {"layer" "OrProj/pos" "value" "NOUN"}]]
                                 [["span" "?s" {"layer" "OrProj/pos"}]]]]})]
        (is (= 3 (:count r)))
        (is (= #{(str noun0) (str verb1) (str noun2)} (set (map first (tuples r)))))))))

(deftest or-count-is-distinct-union
  (build!)
  (testing ":return :count over an :or counts the distinct union"
    (is (= {:return :count :count 3 :truncated false}
           (qe/run db "admin@example.com"
                   {"find" ["?s"]
                    "where" [["or" [["span" "?s" {"layer" "OrProj/pos" "value" "NOUN"}]]
                              [["span" "?s" {"layer" "OrProj/pos" "value" "VERB"}]]]]
                    "return" "count"})))))
