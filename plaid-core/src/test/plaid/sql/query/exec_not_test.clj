(ns plaid.sql.query.exec-not-test
  "Integration tests for negation (:not) — correlated NOT EXISTS anti-joins,
  with existential inner vars scoped inside the subquery."
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
  "words 'aa bb cc'; t0 has a NOUN span, t1 has a VERB span, t2 has no span."
  []
  (let [pid  (h/create-test-project admin-request "NotProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "pos"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa bb cc"))
        t0 (id (h/create-token admin-request tokl text 0 2))
        t1 (id (h/create-token admin-request tokl text 3 5))
        t2 (id (h/create-token admin-request tokl text 6 8))]
    (h/create-span admin-request sl [t0] "NOUN")
    (h/create-span admin-request sl [t1] "VERB")
    {:t0 t0 :t1 t1 :t2 t2}))

(deftest not-anti-join-correlated
  (let [{:keys [t1 t2]} (build!)]
    (testing "tokens NOT covered by a NOUN span — ?s is existential inside the :not"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?t"]
                       "where" [["token" "?t" {"layer" "NotProj/words"}]
                                ["not" ["covers" "?s" "?t"]
                                 ["span" "?s" {"layer" "NotProj/pos" "value" "NOUN"}]]]})]
        ;; t0 (NOUN) excluded; t1 (VERB) and t2 (no span) remain
        (is (= 2 (:count r)))
        (is (= #{(str t1) (str t2)} (set (map first (tuples r)))))))))

(deftest not-no-span-at-all
  (let [{:keys [t2]} (build!)]
    (testing "tokens NOT covered by ANY pos span -> only the bare token"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?t"]
                       "where" [["token" "?t" {"layer" "NotProj/words"}]
                                ["not" ["covers" "?s" "?t"] ["span" "?s" {"layer" "NotProj/pos"}]]]})]
        (is (= [[(str t2)]] (tuples r)))))))

(deftest not-with-value-alternation-inside
  (let [{:keys [t2]} (build!)]
    (testing ":not composes with value alternation: tokens not covered by a NOUN-or-VERB span"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?t"]
                       "where" [["token" "?t" {"layer" "NotProj/words"}]
                                ["not" ["covers" "?s" "?t"]
                                 ["span" "?s" {"layer" "NotProj/pos" "value" ["NOUN" "VERB"]}]]]})]
        ;; t0 and t1 are covered (NOUN / VERB); only t2 survives
        (is (= [[(str t2)]] (tuples r)))))))

(deftest not-composes-with-or
  (let [{:keys [t0 t2]} (build!)]
    (testing ":not distributes into :or branches"
      ;; tokens that are EITHER covered by a NOUN span OR covered by no span
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?t"]
                       "where" [["token" "?t" {"layer" "NotProj/words"}]
                                ["or"
                                 [["covers" "?s" "?t"] ["span" "?s" {"layer" "NotProj/pos" "value" "NOUN"}]]
                                 [["not" ["covers" "?s2" "?t"] ["span" "?s2" {"layer" "NotProj/pos"}]]]]]})]
        (is (= #{(str t0) (str t2)} (set (map first (tuples r)))))))))

(deftest not-over-or-is-de-morgan
  (let [{:keys [t2]} (build!)]
    (testing "NOT(covered-by-NOUN OR covered-by-VERB) = covered by neither"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?t"]
                       "where" [["token" "?t" {"layer" "NotProj/words"}]
                                ["not" ["or"
                                        [["covers" "?s" "?t"] ["span" "?s" {"layer" "NotProj/pos" "value" "NOUN"}]]
                                        [["covers" "?s2" "?t"] ["span" "?s2" {"layer" "NotProj/pos" "value" "VERB"}]]]]]})]
        ;; t0 (NOUN) and t1 (VERB) are excluded by De Morgan; only t2 remains
        (is (= [[(str t2)]] (tuples r)))))))

(deftest not-reconstrains-outer-var-begin
  (let [{:keys [t1 t2]} (build!)]
    (testing "a :not that re-states an already-bound outer var negates only that attribute"
      ;; tokens that do NOT begin at offset 0 — t0@0 excluded, t1@3 and t2@6 kept.
      ;; (Regression: the inner `{begin 0}` must land inside the NOT EXISTS as a
      ;; correlated predicate, not be ANDed onto the outer alias.)
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?t"]
                       "where" [["token" "?t" {"layer" "NotProj/words"}]
                                ["not" ["token" "?t" {"begin" 0}]]]})]
        (is (= 2 (:count r)))
        (is (= #{(str t1) (str t2)} (set (map first (tuples r)))))))))

(deftest not-reconstrains-outer-var-value
  (let [_ (build!)]
    (testing "NOUN span that is not (also) VERB — same span correlated, value negated"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?s"]
                       "where" [["span" "?s" {"layer" "NotProj/pos" "value" "NOUN"}]
                                ["not" ["span" "?s" {"layer" "NotProj/pos" "value" "VERB"}]]]})]
        ;; the one NOUN span survives (it is not VERB); the leak would AND
        ;; value=NOUN AND value=VERB onto the outer alias and return nothing.
        (is (= 1 (:count r)))))))

(deftest double-negation-is-existence
  (let [{:keys [t0]} (build!)]
    (testing "NOT(NOT(covered by NOUN)) = covered by NOUN"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?t"]
                       "where" [["token" "?t" {"layer" "NotProj/words"}]
                                ["not" ["not" ["covers" "?s" "?t"]
                                        ["span" "?s" {"layer" "NotProj/pos" "value" "NOUN"}]]]]})]
        (is (= [[(str t0)]] (tuples r)))))))
