(ns plaid.sql.query.exec-fieldpath-test
  "Integration tests for dot-path field access: `?t.begin`, `?a.value`,
  `?s.metadata.key`, `?sl.config.key` — used in predicates, order-by, and
  aggregates. A dot-path must behave exactly like the value-var equivalent."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h]
            [plaid.sql.project :as prj]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [r] (-> r :body :id))
(defn- ids [r] (set (map (comp str first) (:results r))))
(defn- run [q] (qe/run db "admin@example.com" q))

(defn- build!
  "Project FP: words tokens t0@0 t1@3 t2@6 t3@9; pos spans A=NOUN@t0 {score 7},
  B=VERB@t1 {score 3}, C=NOUN@t2 (no metadata). pos layer config.plaid.color=red."
  []
  (let [pid  (h/create-test-project admin-request "FP")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        pos  (id (h/create-span-layer admin-request tokl "pos"))
        doc  (h/create-test-document admin-request pid "d1")
        tx   (id (h/create-text admin-request txtl doc "aa bb cc dd"))
        t0 (id (h/create-token admin-request tokl tx 0 2))
        t1 (id (h/create-token admin-request tokl tx 3 5))
        t2 (id (h/create-token admin-request tokl tx 6 8))
        t3 (id (h/create-token admin-request tokl tx 9 11))
        a  (id (h/create-span admin-request pos [t0] "NOUN" {"score" 7 "caseKey" "X"}))
        b  (id (h/create-span admin-request pos [t1] "VERB" {"score" 3}))
        c  (id (h/create-span admin-request pos [t2] "NOUN"))]
    (prj/assoc-editor-config-pair db pos "plaid" "color" "red")
    {:pos pos :t0 t0 :t1 t1 :t2 t2 :t3 t3 :a a :b b :c c}))

(deftest core-attr-predicate
  (let [{:keys [t2 t3]} (build!)]
    (testing "?t.begin >= 6 selects the later tokens"
      (is (= #{(str t2) (str t3)}
             (ids (run {"find" ["?t"] "where" [["token" "?t" {"layer" "FP/words"}] [">=" "?t.begin" 6]]})))))
    (testing "a dot-path is identical to the value-var equivalent"
      (is (= (ids (run {"find" ["?t"] "where" [["token" "?t" {"layer" "FP/words"}] [">=" "?t.begin" 6]]}))
             (ids (run {"find" ["?t"] "where" [["token" "?t" {"layer" "FP/words" "begin" {"var" "?b"}}] [">=" "?b" 6]]})))))))

(deftest value-join-via-dots
  (let [{:keys [a c]} (build!)]
    (testing "two distinct spans with the same value (?a.value = ?b.value)"
      (let [r (run {"find" ["?a" "?b"]
                    "where" [["span" "?a" {"layer" "FP/pos"}] ["span" "?b" {"layer" "FP/pos"}]
                             ["=" "?a.value" "?b.value"] ["!=" "?a" "?b"]]})
            pairs (set (map (fn [[x y]] #{(str x) (str y)}) (:results r)))]
        ;; only the two NOUN spans pair up
        (is (= #{#{(str a) (str c)}} pairs))))))

(deftest metadata-path-predicate
  (let [{:keys [a]} (build!)]
    (testing "?s.metadata.score >= 5 (B is 3, C absent -> excluded)"
      (is (= #{(str a)}
             (ids (run {"find" ["?s"] "where" [["span" "?s" {"layer" "FP/pos"}] [">=" "?s.metadata.score" 5]]})))))
    (testing "metadata keys are case-sensitive (canonicalization is only for QL vocab)"
      (is (= #{(str a)}
             (ids (run {"find" ["?s"] "where" [["span" "?s" {"layer" "FP/pos"}] ["=" "?s.metadata.caseKey" "X"]]}))))
      (is (empty? (ids (run {"find" ["?s"] "where" [["span" "?s" {"layer" "FP/pos"}] ["=" "?s.metadata.casekey" "X"]]})))))))

(deftest config-path-predicate
  (let [{:keys [a b c]} (build!)]
    (testing "a span layer var's config.plaid.color is readable as a field"
      (let [r (run {"find" ["?s"]
                    "where" [["span" "?s" {"layer" "?sl"}] ["span-layer" "?sl" {"name" "pos"}]
                             ["=" "?sl.config.plaid.color" "red"]]})]
        (is (= #{(str a) (str b) (str c)} (ids r))))
      (is (empty? (ids (run {"find" ["?s"]
                             "where" [["span" "?s" {"layer" "?sl"}] ["span-layer" "?sl" {"name" "pos"}]
                                      ["=" "?sl.config.plaid.color" "blue"]]})))))))

(deftest order-by-and-aggregate-via-dots
  (let [{:keys [t0 t1 t2 t3]} (build!)]
    (testing "order-by a dotted field, descending"
      (is (= [(str t3) (str t2) (str t1) (str t0)]
             (mapv (comp str first)
                   (:results (run {"find" ["?t"] "where" [["token" "?t" {"layer" "FP/words"}]]
                                   "order-by" [["?t.begin" "desc"]]}))))))
    (testing "aggregate over a dotted field (sum/max of token begin)"
      (let [r (run {"where" [["token" "?t" {"layer" "FP/words"}]]
                    "return" {"group" [] "aggregates" [["sum" "?t.begin"] ["max" "?t.begin"]]}})]
        (is (= [[18 9]] (:results r)))))))   ; 0+3+6+9=18, max 9
