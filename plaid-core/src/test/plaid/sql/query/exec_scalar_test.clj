(ns plaid.sql.query.exec-scalar-test
  "Integration tests for scalar value-variables ({value {var \"?v\"}} binds + joins)
  and predicate clauses ([= a b] / [!= a b] / ordering)."
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
(defn- ids [r] (set (map first (:results r))))
(defn- span-vals [r]
  (set (map (fn [[sid]] (:span/value (:body (h/get-span admin-request sid)))) (:results r))))

(defn- build!
  "pos spans NOUN(s0,t0) NOUN(s1,t1) VERB(s2,t2); tokens at offsets 0/3/6."
  []
  (let [pid  (h/create-test-project admin-request "ScProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "pos"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa bb cc"))
        t0 (id (h/create-token admin-request tokl text 0 2))
        t1 (id (h/create-token admin-request tokl text 3 5))
        t2 (id (h/create-token admin-request tokl text 6 8))
        s0 (id (h/create-span admin-request sl [t0] "NOUN"))
        s1 (id (h/create-span admin-request sl [t1] "NOUN"))
        s2 (id (h/create-span admin-request sl [t2] "VERB"))]
    {:t0 t0 :t1 t1 :t2 t2 :s0 s0 :s1 s1 :s2 s2}))

(deftest value-as-join-var
  (let [{:keys [s0 s1]} (build!)]
    (testing "two DISTINCT pos spans sharing a value -> only the values with a twin"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?a"]
                       "where" [["span" "?a" {"layer" "ScProj/pos" "value" {"var" "?v"}}]
                                ["span" "?b" {"layer" "ScProj/pos" "value" {"var" "?v"}}]
                                ["!=" "?a" "?b"]]})]
        ;; only the two NOUN spans have a same-value partner; the lone VERB drops
        (is (= #{(str s0) (str s1)} (set (map str (ids r)))))
        (is (= #{"NOUN"} (span-vals r)))))))

(deftest self-match-footgun-without-inequality
  (let [{:keys [s0 s1 s2]} (build!)]
    (testing "WITHOUT != the self-pair survives, so every span matches (the footgun)"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?a"]
                       "where" [["span" "?a" {"layer" "ScProj/pos" "value" {"var" "?v"}}]
                                ["span" "?b" {"layer" "ScProj/pos" "value" {"var" "?v"}}]]})]
        (is (= #{(str s0) (str s1) (str s2)} (set (map str (ids r)))))))))

(deftest inequality-on-entity-ids
  (let [{:keys [s0 s1]} (build!)]
    (testing "[!= ?a ?b] compares entity ids -> distinct NOUN spans only"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?a"]
                       "where" [["span" "?a" {"layer" "ScProj/pos" "value" "NOUN"}]
                                ["span" "?b" {"layer" "ScProj/pos" "value" "NOUN"}]
                                ["!=" "?a" "?b"]]})]
        (is (= #{(str s0) (str s1)} (set (map str (ids r)))))))))

(deftest scalar-predicate-with-literal
  (let [{:keys [t0 t1]} (build!)]
    (testing "bind a token's begin to ?n, then [< ?n 5] -> tokens before offset 5"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?t"]
                       "where" [["token" "?t" {"layer" "ScProj/words" "begin" {"var" "?n"}}]
                                ["<" "?n" 5]]})]
        (is (= #{(str t0) (str t1)} (set (map str (ids r)))))))))

(deftest value-scalar-numeric-comparison
  ;; Regression: a predicate on a :value scalar must compare the DECODED value
  ;; numerically, not lexically on the quoted JSON ("100" < "25" is lexically true).
  (let [pid  (h/create-test-project admin-request "NumProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "n"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa bb cc"))
        mk   (fn [b e v] (let [t (id (h/create-token admin-request tokl text b e))]
                           (id (h/create-span admin-request sl [t] v))))
        s5   (mk 0 2 5) s10 (mk 3 5 10) _s100 (mk 6 8 100)]
    (testing "[< ?v 25] on a numeric :value is a NUMERIC compare (5,10 — not 100)"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?s"]
                       "where" [["span" "?s" {"layer" "NumProj/n" "value" {"var" "?v"}}]
                                ["<" "?v" 25]]})]
        (is (= #{(str s5) (str s10)} (set (map (comp str first) (:results r)))))))))

(deftest scalar-validation
  (testing "a scalar var cannot be returned in :find"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"binds a value .* cannot be a :find var"
         (ast/expand {"find" ["?v"]
                      "where" [["span" "?s" {"layer" "ScProj/pos" "value" {"var" "?v"}}]]}))))
  (testing "ordering predicate on an entity var is a 400"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"cannot order entity"
         (ast/expand {"find" ["?a"]
                      "where" [["span" "?a" {"layer" "ScProj/pos"}]
                               ["span" "?b" {"layer" "ScProj/pos"}]
                               ["<" "?a" "?b"]]}))))
  (testing "predicate referencing an unbound var is a 400"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"references unbound var"
         (ast/expand {"find" ["?a"]
                      "where" [["span" "?a" {"layer" "ScProj/pos"}]
                               ["=" "?a" "?zzz"]]}))))
  (testing "?-prefixed value STRINGS stay literals (only {var ..} binds) — no data misread"
    ;; A real gloss like "?x" must filter for the literal, NOT become a scalar var.
    (doseq [gloss ["?" "?x" "?PST"]]
      (let [clause (first (:where (ast/parse {"find" ["?s"]
                                              "where" [["span" "?s" {"layer" "ScProj/pos" "value" gloss}]]})))]
        (is (= gloss (:value (nth clause 2))) (str gloss " must remain a literal"))
        (is (string? (:value (nth clause 2))))))))
