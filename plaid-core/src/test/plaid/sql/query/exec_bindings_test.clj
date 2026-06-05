(ns plaid.sql.query.exec-bindings-test
  "Integration tests for `bindings` (query parameters): a ?placeholder spliced to
  a literal must behave exactly like the inline literal — same rows, same ACL."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [r] (-> r :body :id))
(defn- ids [r] (set (map (comp str first) (:results r))))
(defn- code [f] (try (f) :ok (catch clojure.lang.ExceptionInfo e (:code (ex-data e)))))

(defn- build!
  "A project `pname` with a pos span layer: NOUN@t0, VERB@t1."
  [pname]
  (let [pid  (h/create-test-project admin-request pname)
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        pos  (id (h/create-span-layer admin-request tokl "pos"))
        doc  (h/create-test-document admin-request pid "d1")
        tx   (id (h/create-text admin-request txtl doc "aa bb"))
        t0 (id (h/create-token admin-request tokl tx 0 2))
        t1 (id (h/create-token admin-request tokl tx 3 5))
        n  (id (h/create-span admin-request pos [t0] "NOUN"))
        v  (id (h/create-span admin-request pos [t1] "VERB"))]
    {:pid pid :pos pos :noun n :verb v}))

(deftest bindings-match-inline
  (let [{:keys [pos noun]} (build! "BindProj")]
    (testing "a bindings-parameterized query returns the same rows as the inline literal"
      (let [inline (qe/run db "admin@example.com"
                           {"find" ["?s"] "where" [["span" "?s" {"layer" (str pos) "value" "NOUN"}]]})
            bound  (qe/run db "admin@example.com"
                           {"find" ["?s"] "where" [["span" "?s" {"layer" "?L" "value" "?v"}]]
                            "bindings" {"?L" (str pos) "?v" "NOUN"}})]
        (is (= #{(str noun)} (ids inline)))
        (is (= (ids inline) (ids bound)))))
    (testing "a list binding drives IN/alternation"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?s"] "where" [["span" "?s" {"layer" (str pos) "value" "?vs"}]]
                       "bindings" {"?vs" ["NOUN" "VERB"]}})]
        (is (= 2 (count (:results r))))))))

(deftest bindings-respect-acl
  (let [_a (build! "BindA")
        b  (build! "BindB")]
    (testing "a bound layer id outside the requested scope is rejected — identically to inlining it"
      (let [scope  {"projects" ["BindA"]}
            bound  #(qe/run db "admin@example.com"
                            {"find" ["?s"] "where" [["span" "?s" {"layer" "?L"}]]
                             "scope" scope "bindings" {"?L" (str (:pos b))}})
            inline #(qe/run db "admin@example.com"
                            {"find" ["?s"] "where" [["span" "?s" {"layer" (str (:pos b))}]]
                             "scope" scope})]
        (is (= 400 (code inline)))
        (is (= (code inline) (code bound)) "binding and inline are treated identically by scope")))))
