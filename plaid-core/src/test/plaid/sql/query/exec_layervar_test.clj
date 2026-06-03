(ns plaid.sql.query.exec-layervar-test
  "Integration tests for layer variables (Cut 1): a var in :layer position binds
  a layer node, lets two entities share a layer (same-layer join), and can be
  projected in :find."
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

(deftest layer-var-by-name-is-the-multi-match-escape
  (let [n1 (build-named! "MA1")
        n2 (build-named! "MA2")]
    (testing "[:span-layer ?sl {:name \"pos\"}] matches NOUN on the 'pos' layer of BOTH projects"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?s"]
                       "where" [["span" "?s" {"layer" "?sl" "value" "NOUN"}]
                                ["span-layer" "?sl" {"name" "pos"}]]})]
        (is (= #{(str n1) (str n2)} (set (map first (tuples r)))))))
    (testing "a bare scalar name 'pos' is ambiguous (400); the layer var is the sanctioned way to match both"
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
