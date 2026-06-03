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
