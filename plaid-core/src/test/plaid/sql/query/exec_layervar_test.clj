(ns plaid.sql.query.exec-layervar-test
  "Integration tests for layer variables (Cut 1): a var in :layer position binds
  a layer node, lets two entities share a layer (same-layer join), and can be
  projected in :find."
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
(defn- tuples [r] (mapv (fn [t] (mapv str t)) (:results r)))

(defn- build!
  "One token layer with TWO span layers, pos and feat, over text 'aa bb':
    pos:  NOUN@t0, VERB@t1
    feat: NOUN@t0
  So a NOUN exists on both layers, but a VERB only on pos."
  []
  (let [pid  (h/create-test-project admin-request "LVProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        pos  (id (h/create-span-layer admin-request tokl "pos"))
        feat (id (h/create-span-layer admin-request tokl "feat"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa bb"))
        t0 (id (h/create-token admin-request tokl text 0 2))
        t1 (id (h/create-token admin-request tokl text 3 5))]
    {:pos pos :feat feat
     :pos-noun (id (h/create-span admin-request pos [t0] "NOUN"))
     :pos-verb (id (h/create-span admin-request pos [t1] "VERB"))
     :feat-noun (id (h/create-span admin-request feat [t0] "NOUN"))}))

(deftest same-layer-join-vs-layer-less
  (let [{:keys [pos-noun pos-verb]} (build!)]
    (testing "NOUN and VERB on the SAME layer var -> only the pos pair (feat has no VERB)"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?a" "?b"]
                       "where" [["span" "?a" {"layer" "?sl" "value" "NOUN"}]
                                ["span" "?b" {"layer" "?sl" "value" "VERB"}]]})]
        (is (= [[(str pos-noun) (str pos-verb)]] (tuples r)))))
    (testing "WITHOUT the shared layer (layer-less) the feat NOUN also pairs with the pos VERB -> 2"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?a" "?b"]
                       "where" [["span" "?a" {"value" "NOUN"}]
                                ["span" "?b" {"value" "VERB"}]]})]
        (is (= 2 (:count r)))))))

(deftest layer-var-projection
  (let [{:keys [pos]} (build!)]
    (testing "a layer var can be returned in :find — here, the layer carrying a VERB"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?sl"]
                       "where" [["span" "?v" {"layer" "?sl" "value" "VERB"}]]})]
        (is (= ["sl"] (:columns r)))
        (is (= [[(str pos)]] (tuples r)))))))

(defn- build-named!
  "Project `pname` with a 'pos' span layer carrying one NOUN span. Returns the
  NOUN span id."
  [pname]
  (let [pid  (h/create-test-project admin-request pname)
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        pos  (id (h/create-span-layer admin-request tokl "pos"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa"))
        t0 (id (h/create-token admin-request tokl text 0 2))]
    (id (h/create-span admin-request pos [t0] "NOUN"))))

(deftest layer-var-by-name-matches-across-projects
  (let [n1 (build-named! "MA1")
        n2 (build-named! "MA2")]
    (testing "[:span-layer ?sl {:name \"pos\"}] matches NOUN on the 'pos' layer of BOTH projects"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?s"]
                       "where" [["span" "?s" {"layer" "?sl" "value" "NOUN"}]
                                ["span-layer" "?sl" {"name" "pos"}]]})]
        (is (= #{(str n1) (str n2)} (set (map first (tuples r)))))))
    (testing "a bare scalar name 'pos' is not a layer id (400); the layer var is how you match by name"
      (is (= 400 (try (qe/run db "admin@example.com"
                              {"find" ["?s"] "where" [["span" "?s" {"layer" "pos" "value" "NOUN"}]]})
                      (catch clojure.lang.ExceptionInfo e (:code (ex-data e)))))))))

(deftest layer-var-kind-conflict
  (build!)
  (testing "a layer var used as both a span-layer and a token-layer is a 400 kind conflict"
    (is (= 400 (try (qe/run db "admin@example.com"
                            {"find" ["?a"]
                             "where" [["span" "?a" {"layer" "?sl"}] ["token" "?t" {"layer" "?sl"}]]})
                    (catch clojure.lang.ExceptionInfo e (:code (ex-data e))))))))

(deftest layer-selected-by-config-role
  ;; The cross-project "pick the layer that plays role X" job once done by the
  ;; removed :alias clause filter is now done with an ordinary config-key predicate
  ;; on a layer variable — roles live under the reserved "plaid"/"role" config pair.
  (let [pid  (h/create-test-project admin-request "RoleProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        pos  (id (h/create-span-layer admin-request tokl "pos"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa"))
        t0 (id (h/create-token admin-request tokl text 0 2))
        s  (id (h/create-span admin-request pos [t0] "NOUN"))]
    (prj/assoc-editor-config-pair db pos "plaid" "role" "lex" nil)
    (testing "a layer var filtered by its config role matches the right layer"
      (is (= [[(str s)]]
             (tuples (qe/run db "admin@example.com"
                             {"find" ["?s"]
                              "where" [["span" "?s" {"layer" "?sl" "value" "NOUN"}]
                                       ["span-layer" "?sl" {}]
                                       ["=" "?sl.config.plaid.role" "lex"]]})))))))

(deftest scalar-layer-ref-must-be-an-id
  (let [{:keys [pos pos-noun]} (build!)]
    (testing "a name/path scalar layer reference is a 400 (layers are identified by id only)"
      (is (= 400 (try (qe/run db "admin@example.com"
                              {"find" ["?s"] "where" [["span" "?s" {"layer" "LVProj/pos"}]]})
                      (catch clojure.lang.ExceptionInfo e (:code (ex-data e)))))))
    (testing "a layer id resolves to that layer"
      (is (= [[(str pos-noun)]]
             (tuples (qe/run db "admin@example.com"
                             {"find" ["?s"] "where" [["span" "?s" {"layer" (str pos) "value" "NOUN"}]]})))))
    (testing "a layer variable (bound by a layer clause) matches by name"
      (is (= 1 (:count (qe/run db "admin@example.com"
                               {"find" ["?s"]
                                "where" [["span" "?s" {"layer" "?sl" "value" "NOUN"}]
                                         ["span-layer" "?sl" {"name" "pos"}]]
                                "return" "count"})))))))

(deftest layer-var-plus-literal-both-apply
  ;; Regression (round-6): a var carrying BOTH a layer variable and a literal layer
  ;; must satisfy both. The literal `IN` filter used to be dropped under the
  ;; layer-var arm of the scope cond (over-broad results).
  (let [{:keys [pos pos-noun pos-verb feat-noun]} (build!)]
    (testing "?s on ?sl AND on the literal pos layer -> only pos spans (feat NOUN excluded)"
      (let [r   (qe/run db "admin@example.com"
                        {"find" ["?s"]
                         "where" [["span" "?s" {"layer" "?sl"}]
                                  ["span" "?s" {"layer" (str pos)}]]})
            got (set (map first (tuples r)))]
        (is (= #{(str pos-noun) (str pos-verb)} got))
        (is (not (contains? got (str feat-noun))) "the feat-layer NOUN must be filtered out")))))

(deftest vocab-layer-variable
  ;; Coverage: a vocab-layer layer-variable uses the distinct project_vocabs scope
  ;; path (vocab layers are global; reachable only via a grant to an in-scope
  ;; project) — exercised here end-to-end, unlike the span-layer paths above.
  (let [pid (h/create-test-project admin-request "VLVProj")
        vl  (id (h/create-vocab-layer admin-request "lexicon"))
        _   (h/link-vocab-to-project admin-request pid vl)
        dog (id (h/create-vocab-item admin-request vl "dog"))
        _   (id (h/create-vocab-item admin-request vl "cat"))]
    (testing "a vocab var bound through a [:vocab-layer ?vl {:name ...}] clause resolves in-scope items"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?v"]
                       "where" [["vocab" "?v" {"layer" "?vl" "form" "dog"}]
                                ["vocab-layer" "?vl" {"name" "lexicon"}]]})]
        (is (= [[(str dog)]] (tuples r)))))
    (testing "the layer var can be projected in :find"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?vl"]
                       "where" [["vocab" "?v" {"layer" "?vl" "form" "dog"}]
                                ["vocab-layer" "?vl" {"name" "lexicon"}]]})]
        (is (= [[(str vl)]] (tuples r)))))))

(deftest not-with-layer-constraint-clause
  ;; Regression: a [:span-layer ?SL {...}] clause inside a :not used to fall to
  ;; compile-rel!'s default branch and throw a 500. It must compile + run.
  (let [pid  (h/create-test-project admin-request "NLProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        feat (id (h/create-span-layer admin-request tokl "feat"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa bb"))
        t0   (id (h/create-token admin-request tokl text 0 2))
        t1   (id (h/create-token admin-request tokl text 3 5))]
    (h/create-span admin-request feat [t0] "X")   ; only t0 has a feat span
    (testing "tokens not covered by any span on a layer NAMED feat"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?t"]
                       "where" [["token" "?t" {"layer" tokl}]
                                ["not" ["covers" "?s" "?t"]
                                 ["span" "?s" {"layer" "?SL"}]
                                 ["span-layer" "?SL" {"name" "feat"}]]]})]
        ;; t0 has a feat span -> excluded; t1 has none -> included
        (is (= #{(str t1)} (set (map (comp str first) (:results r)))))))))
