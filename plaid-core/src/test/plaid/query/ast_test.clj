(ns plaid.query.ast-test
  "Unit tests for the backend-agnostic query AST: parse (JSON-ish -> EDN),
  validation (shape + arity + var-kind inference + safety), and the error
  taxonomy. No DB."
  (:require [clojure.test :refer [deftest is testing]]
            [plaid.query.ast :as ast]))

(defn- code-of [f]
  (try (f) ::no-throw
       (catch clojure.lang.ExceptionInfo e (:code (ex-data e)))))

(deftest parse-normalizes-json-dialect
  (testing "string keys/heads/vars become keyword keys/heads and var symbols"
    (let [parsed (ast/parse {"find" ["?s"]
                             "where" [["span" "?s" {"layer" "pos" "value" "NOUN"}]]})]
      (is (= [(symbol "?s")] (:find parsed)))
      (is (= [:span (symbol "?s") {:layer "pos" :value "NOUN"}] (first (:where parsed))))))
  (testing "already-EDN dialect passes through unchanged"
    (let [edn {:find '[?s] :where '[[:span ?s {:layer "pos"}]]}]
      (is (= edn (dissoc (ast/parse edn) :return))))))

(deftest validate-accepts-canonical-query
  (let [checked (ast/parse+validate
                 {"find" ["?s1" "?s2"]
                  "where" [["span" "?s1" {"layer" "pos" "value" "NOUN"}]
                           ["span" "?s2" {"layer" "pos" "value" "VERB"}]
                           ["covers" "?s1" "?t1"] ["covers" "?s2" "?t2"]
                           ["precedes" "?t1" "?t2"]]})]
    (is (= :ids (:return checked)))
    (is (= {(symbol "?s1") :span (symbol "?s2") :span
            (symbol "?t1") :token (symbol "?t2") :token}
           (::ast/var-kinds checked)))))

(deftest infer-kinds-relation-inline-spans
  (let [checked (ast/parse+validate
                 {"find" ["?r"]
                  "where" [["relation" "?r" {"layer" "dep" "value" "nsubj"
                                             "source" "?h" "target" "?d"}]
                           ["span" "?h" {}] ["span" "?d" {}]]})
        kinds (::ast/var-kinds checked)]
    (is (= :relation (kinds (symbol "?r"))))
    (is (= :span (kinds (symbol "?h"))))
    (is (= :span (kinds (symbol "?d"))))))

(deftest validation-errors
  (testing "all author errors are :code 400"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?t"] "where" [["token" "?t" {"layer" "w"}]] "as-of" "2020"})))
        "as-of rejected")
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?x"] "where" [["token" "?t" {"layer" "w"}]]})))
        "unbound find var")
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?x"] "where" [["span" "?x" {}] ["precedes" "?x" "?y"]]})))
        "kind conflict: span used as token")
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layr" "pos"}]]})))
        "unknown constraint key")
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?t"] "where" [["token" "?t" {"layer" "w"}] ["within" "?t" "?w"]]})))
        "deferred clause :within")
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?a"] "where" [["precedes" "?a"]]})))
        "bad rel arity")
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?a"] "where" []})))
        "empty where")
    (is (= 400 (code-of #(ast/parse+validate {"find" [] "where" [["span" "?s" {}]]})))
        "empty find")
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {}]] "limit" -1})))
        "non-positive limit")
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["frobnicate" "?s"]]})))
        "unknown clause head")))

(deftest var-predicate
  (is (ast/var? (symbol "?s")))
  (is (not (ast/var? 's)))
  (is (not (ast/var? "?s")))
  (is (= (symbol "?s") (ast/->var "?s"))))
