(ns plaid.query.ast-test
  "Unit tests for the backend-agnostic query AST: parse (JSON-ish -> EDN),
  validation (shape + arity + var-kind inference + safety), and the error
  taxonomy. No DB."
  (:require [clojure.test :refer [deftest is testing]]
            [clojure.set]
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

(deftest m2-clauses-infer-kinds
  (testing ":within / :first-in bind tokens; :vocab + :vocab-link bind vocab/token"
    (let [k (::ast/var-kinds
             (ast/parse+validate
              {"find" ["?m"]
               "where" [["token" "?m" {"layer" "morphemes"}]
                        ["within" "?m" "?w"] ["token" "?w" {"layer" "words"}]
                        ["first-in" "?w" "?s"] ["token" "?s" {"layer" "sentences"}]]}))]
      (is (= :token (k (symbol "?m"))))
      (is (= :token (k (symbol "?w"))))
      (is (= :token (k (symbol "?s")))))
    (let [k (::ast/var-kinds
             (ast/parse+validate
              {"find" ["?t"]
               "where" [["vocab" "?v" {"form" "Kemal"}] ["vocab-link" "?t" "?v"]]}))]
      (is (= :vocab (k (symbol "?v"))))
      (is (= :token (k (symbol "?t"))))))
  (testing "a var used as both token and vocab is a kind conflict"
    (is (= 400 (code-of #(ast/parse+validate
                          {"find" ["?x"]
                           "where" [["vocab" "?x" {}] ["covers" "?x" "?y"]]}))))))

;; ---------------------------------------------------------------------------
;; M3: :seq sugar (desugar via `expand`)
;; ---------------------------------------------------------------------------

(defn- branches [raw] (ast/expand raw))

(deftest expand-non-seq-is-single-branch
  (testing "a query with no :seq expands to exactly one validated branch"
    (let [bs (branches {"find" ["?s"] "where" [["span" "?s" {"layer" "pos" "value" "NOUN"}]]})]
      (is (= 1 (count bs)))
      (is (= [(symbol "?s")] (:find (first bs)))))))

(deftest expand-seq-plain-is-one-branch
  (testing "DET then NOUN (no quantifiers) -> one branch, sugar to covers+precedes"
    (let [bs (branches {"find" ["?s1" "?s2"]
                        "where" [["seq" {"layer" "words"}
                                  ["span" {"layer" "pos" "value" "DET"} "as" "?s1"]
                                  ["span" {"layer" "pos" "value" "NOUN"} "as" "?s2"]]]})
          w (:where (first bs))]
      (is (= 1 (count bs)))
      ;; named span vars survive; precedes + covers + token binds were emitted
      (is (some #(= % [:span (symbol "?s1") {:layer "pos" :value "DET"}]) w))
      (is (some #(= % [:span (symbol "?s2") {:layer "pos" :value "NOUN"}]) w))
      (is (= 1 (count (filter #(= :precedes (first %)) w))))
      (is (= 2 (count (filter #(= :covers (first %)) w)))))))

(deftest expand-seq-optional-unrolls-to-union
  (testing "a :? element unrolls to two branches (absent / present)"
    (let [bs (branches {"find" ["?s1" "?s2"]
                        "where" [["seq" {"layer" "words"}
                                  ["span" {"layer" "pos" "value" "DET"} "as" "?s1"]
                                  ["?" ["span" {"layer" "pos" "value" "ADJ"}]]
                                  ["span" {"layer" "pos" "value" "NOUN"} "as" "?s2"]]]})]
      (is (= 2 (count bs)))
      ;; every branch binds both find vars
      (is (every? (fn [b] (= #{(symbol "?s1") (symbol "?s2")}
                             (clojure.set/intersection #{(symbol "?s1") (symbol "?s2")}
                                                       (set (keys (::ast/var-kinds b))))))
                  bs))
      ;; one branch has 2 precedes (DET-ADJ-NOUN), the other 1 (DET-NOUN)
      (is (= #{1 2} (set (map (fn [b] (count (filter #(= :precedes (first %)) (:where b)))) bs)))))))

(deftest expand-seq-rep-unrolls
  (testing ":rep 0 2 unrolls to three length branches"
    (is (= 3 (count (branches {"find" ["?s1" "?s2"]
                               "where" [["seq" {"layer" "words"}
                                         ["span" {"layer" "pos" "value" "DET"} "as" "?s1"]
                                         ["rep" 0 2 ["span" {"layer" "pos" "value" "ADJ"}]]
                                         ["span" {"layer" "pos" "value" "NOUN"} "as" "?s2"]]]}))))))

(deftest expand-seq-errors
  (testing "seq author errors are :code 400"
    (is (= 400 (code-of #(branches {"find" ["?s"]
                                    "where" [["seq" {"layer" "w"}
                                              ["*" ["span" {"layer" "pos"}]]]]})))
        "unbounded :* rejected")
    (is (= 400 (code-of #(branches {"find" ["?s"]
                                    "where" [["seq" {"layer" "w"}
                                              ["+" ["span" {"layer" "pos"}]]]]})))
        "unbounded :+ rejected")
    (is (= 400 (code-of #(branches {"find" ["?x"]
                                    "where" [["seq" {"layer" "w"}
                                              ["?" ["span" {"layer" "pos"} "as" "?x"]]]]})))
        "named quantified element rejected")
    (is (= 400 (code-of #(branches {"find" ["?s"]
                                    "where" [["seq" {"layer" "w"}
                                              ["rep" 0 999 ["span" {"layer" "pos"}]]]]})))
        ":rep over per-element cap rejected")
    (is (= 400 (code-of #(branches {"find" ["?s"] "where" [["seq" {} ["span" {"layer" "pos"} "as" "?s"]]]})))
        ":seq without :layer rejected")
    (is (= 400 (code-of #(branches {"find" ["?s"]
                                    "where" [["seq" {"layer" "w"}
                                              ["relation" {"layer" "dep"} "as" "?s"]]]})))
        "non span/token seq element rejected")))

(deftest var-predicate
  (is (ast/var? (symbol "?s")))
  (is (not (ast/var? 's)))
  (is (not (ast/var? "?s")))
  (is (= (symbol "?s") (ast/->var "?s"))))
