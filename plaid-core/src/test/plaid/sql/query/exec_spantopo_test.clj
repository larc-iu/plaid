(ns plaid.sql.query.exec-spantopo-test
  "Integration tests for span↔span topology: overlaps / contains / coextensive,
  with token-set semantics (a span IS the set of tokens it covers)."
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
(defn- found [r] (set (map (comp str first) (:results r))))

(defn- build!
  "tokens t0..t3; phrase P=Q=[t0,t1,t2] (P,Q coextensive); ner N=[t0,t1];
  pos A=[t0], C=[t3]."
  []
  (let [pid  (h/create-test-project admin-request "TopoProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        pl   (id (h/create-span-layer admin-request tokl "phrase"))
        nl   (id (h/create-span-layer admin-request tokl "ner"))
        sl   (id (h/create-span-layer admin-request tokl "pos"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa bb cc dd"))
        t0 (id (h/create-token admin-request tokl text 0 2))
        t1 (id (h/create-token admin-request tokl text 3 5))
        t2 (id (h/create-token admin-request tokl text 6 8))
        t3 (id (h/create-token admin-request tokl text 9 11))]
    {:P (id (h/create-span admin-request pl [t0 t1 t2] "P"))
     :Q (id (h/create-span admin-request pl [t0 t1 t2] "Q"))
     :N (id (h/create-span admin-request nl [t0 t1] "N"))
     :A (id (h/create-span admin-request sl [t0] "A"))
     :C (id (h/create-span admin-request sl [t3] "C"))
     :phrase pl :ner nl :pos sl}))

(deftest contains-token-superset
  (let [{:keys [N A phrase pos]} (build!)]
    (testing "phrase contains the ner span it covers, and the pos span at t0, not t3"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?b"]
                       "where" [["span" "?p" {"layer" phrase}]
                                ["contains" "?p" "?b"]]})]
        ;; P/Q (t0,t1,t2) contain: N(t0,t1), A(t0), and each other (P⊇Q, Q⊇P). Not C(t3).
        (is (contains? (found r) (str N)))
        (is (contains? (found r) (str A)))))
    (testing "C (t3) is contained by no phrase"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?b"]
                       "where" [["span" "?p" {"layer" phrase}]
                                ["span" "?b" {"layer" pos}]
                                ["contains" "?p" "?b"]]})]
        (is (= #{(str A)} (found r)))))))

(deftest overlaps-shared-token
  (let [{:keys [A ner pos]} (build!)]
    (testing "ner (t0,t1) overlaps the pos span at t0 but not the one at t3"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?b"]
                       "where" [["span" "?n" {"layer" ner}]
                                ["span" "?b" {"layer" pos}]
                                ["overlaps" "?n" "?b"]]})]
        (is (= #{(str A)} (found r)))))))

(deftest coextensive-same-tokens
  (let [{:keys [P Q phrase ner]} (build!)]
    (testing "P and Q cover the same tokens -> coextensive (both orderings), self excluded"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?a"]
                       "where" [["span" "?a" {"layer" phrase}]
                                ["span" "?b" {"layer" phrase}]
                                ["coextensive" "?a" "?b"]]})]
        (is (= #{(str P) (str Q)} (found r)))))
    (testing "N is not coextensive with any phrase (strict subset)"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?a"]
                       "where" [["span" "?a" {"layer" ner}]
                                ["span" "?b" {"layer" phrase}]
                                ["coextensive" "?a" "?b"]]})]
        (is (empty? (found r)))))))

(deftest spantopo-validation
  (build!)
  (testing "a token var in a span-topology clause is a kind conflict (400)"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"both"
         (ast/expand {"find" ["?t"]
                      "where" [["token" "?t" {"layer" "TopoProj/words"}]
                               ["span" "?s" {"layer" "TopoProj/pos"}]
                               ["overlaps" "?t" "?s"]]})))))
