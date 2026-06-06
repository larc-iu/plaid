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
        "unknown clause head")
    ;; a non-map :scope must be a clean 400, not a 500 from reduce-kv on a non-map
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {}]] "scope" "notamap"})))
        "non-map :scope (string)")
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {}]] "scope" 5})))
        "non-map :scope (number)")))

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
        "non span/token seq element rejected")
    (is (= 400 (code-of #(branches {"find" ["?s"]
                                    "where" [["seq" {"layer" "w" "bogus" 1}
                                              ["span" {"layer" "pos"} "as" "?s"]]]})))
        "unknown :seq config key rejected")))

(deftest seq-config-doc-threads-into-token-binds
  (testing ":seq config :doc pins every desugared token bind to that document"
    (let [w (:where (first (branches {"find" ["?s"]
                                      "where" [["seq" {"layer" "w" "doc" "d1"}
                                                ["span" {"layer" "pos"} "as" "?s"]]]})))]
      (is (some (fn [c] (and (= :token (first c)) (= "d1" (:doc (nth c 2))))) w)
          "the desugared :token clause carries :doc \"d1\""))))

(deftest return-shapes
  (testing ":return defaults to :ids and accepts :entities / :count"
    (is (= :ids (:return (ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {}]]}))))
    (is (= :entities (:return (ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {}]] "return" "entities"}))))
    (is (= :count (:return (ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {}]] "return" "count"})))))
  (testing "an unknown :return is rejected"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {}]] "return" "kwic"})))))
  (testing ":strict-layers must be a boolean"
    (is (true? (:strict-layers (ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {}]] "strict-layers" true}))))
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {}]] "strict-layers" "yes"}))))))

;; ---------------------------------------------------------------------------
;; :or — clause-level disjunction (DNF -> branches)
;; ---------------------------------------------------------------------------

(deftest expand-or-disjunction
  (testing ":or desugars to a branch per group (NOUN or VERB on one token)"
    (let [bs (ast/expand {"find" ["?s"]
                          "where" [["or" [["span" "?s" {"layer" "pos" "value" "NOUN"}]]
                                    [["span" "?s" {"layer" "pos" "value" "VERB"}]]]]})]
      (is (= 2 (count bs)))
      (is (= #{"NOUN" "VERB"}
             (set (map (fn [b] (-> b :where first (nth 2) :value)) bs))))))
  (testing ":or distributes the surrounding conjunctive clauses into every branch"
    (let [bs (ast/expand {"find" ["?s" "?t"]
                          "where" [["covers" "?s" "?t"]
                                   ["or" [["span" "?s" {"value" "NOUN"}]]
                                    [["span" "?s" {"value" "VERB"}]]]]})]
      (is (= 2 (count bs)))
      (is (every? (fn [b] (some #(= :covers (first %)) (:where b))) bs))))
  (testing "nested/stacked :or expands the cross-product"
    (is (= 4 (count (ast/expand
                     {"find" ["?s" "?t"]
                      "where" [["or" [["span" "?s" {"value" "A"}]] [["span" "?s" {"value" "B"}]]]
                               ["or" [["token" "?t" {"begin" 0}]] [["token" "?t" {"begin" 5}]]]]}))))))

(deftest or-errors
  (testing ":or author errors are 400"
    (is (= 400 (code-of #(ast/expand {"find" ["?s"] "where" [["or" [["span" "?s" {}]]]]})))
        ":or needs at least 2 groups")
    (is (= 400 (code-of #(ast/expand {"find" ["?s"] "where" [["or" [["span" "?s" {}]] [["token" "?t" {}]]]]})))
        "find var not bound in every branch")
    (is (= 400 (code-of #(ast/expand {"find" ["?x"] "where" [["or" [["span" "?x" {}]] [["token" "?x" {}]]]]})))
        "find var has inconsistent kinds across branches")
    (is (= 400 (code-of #(ast/expand {"find" ["?s"] "where" [["or" [["span" "?s" {}]] "notagroup"]]})))
        "each :or group must be a list of clauses")))

(deftest not-negation
  (testing ":not is accepted; inner-only vars are existential, outer vars correlate"
    (is (= 1 (count (ast/expand
                     {"find" ["?t"]
                      "where" [["token" "?t" {"layer" "w"}]
                               ["not" ["covers" "?s" "?t"] ["span" "?s" {"value" "NOUN"}]]]})))))
  (testing ":not may contain :or/:seq (De-Morganed) and may nest"
    ;; NOT(A OR B) -> NOT(A) AND NOT(B): one outer clause, no outer branching
    (is (= 1 (count (ast/expand {"find" ["?t"]
                                 "where" [["token" "?t" {"layer" "w"}]
                                          ["not" ["or" [["span" "?s" {"value" "A"}] ["covers" "?s" "?t"]]
                                                  [["span" "?s" {"value" "B"}] ["covers" "?s" "?t"]]]]]}))))
    (is (= 1 (count (ast/expand {"find" ["?t"]
                                 "where" [["token" "?t" {"layer" "w"}]
                                          ["not" ["seq" {"layer" "w"} ["span" {"layer" "p"}]]]]}))))
    (is (= 1 (count (ast/expand {"find" ["?t"]
                                 "where" [["token" "?t" {"layer" "w"}]
                                          ["not" ["not" ["covers" "?s" "?t"] ["span" "?s" {}]]]]})))))
  (testing ":not author errors are 400"
    (is (= 400 (code-of #(ast/expand {"find" ["?s"]
                                      "where" [["token" "?t" {"layer" "w"}]
                                               ["not" ["span" "?s" {}] ["covers" "?s" "?t"]]]})))
        "a find var appearing only inside :not is not positively bound")
    (is (= 400 (code-of #(ast/expand {"find" ["?t"] "where" [["token" "?t" {"layer" "w"}] ["not"]]})))
        ":not needs at least one clause")))

(deftest value-alternation
  (testing "a vector constraint value (one-of) is accepted on literal-match keys"
    (is (some? (ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"value" ["NOUN" "VERB"]}]]})))
    (is (some? (ast/parse+validate {"find" ["?t"] "where" [["token" "?t" {"begin" [0 5]}]]}))))
  (testing "an empty list is rejected"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"value" []}]]})))))
  (testing "alternation is not allowed on :layer (multi-layer is a 400) or :source"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" ["a" "b"]}]]}))))
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?r"] "where" [["relation" "?r" {"source" ["?a" "?b"]}]]}))))))

(deftest find-rejects-duplicate-vars
  (testing "a duplicate var in :find is a 400 (would emit a duplicate result column)"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s" "?s"] "where" [["span" "?s" {}]]}))))))

(deftest constraint-value-vars
  (testing "a value STRING is always a literal — even ?-prefixed ones (real glosses)"
    (doseq [lit ["?x" "?" "NOUN" "?PST"]]
      (let [clause (first (:where (ast/parse {"find" ["?s"] "where" [["span" "?s" {"value" lit}]]})))
            v (:value (nth clause 2))]
        (is (= lit v))
        (is (string? v) (str (pr-str lit) " must stay a literal, not a scalar var")))))
  (testing "a value variable is written explicitly as {var \"?v\"} and binds a symbol"
    (let [clause (first (:where (ast/parse {"find" ["?s"] "where" [["span" "?s" {"value" {"var" "?v"}}]]})))
          v (:value (nth clause 2))]
      (is (= {:var (symbol "?v")} v) "{var ..} keyword-izes and var-izes its payload")))
  (testing "inline relation :source/:target ARE var-ized"
    (let [clause (first (:where (ast/parse {"find" ["?r"]
                                            "where" [["relation" "?r" {"source" "?h" "target" "?d"}]]})))
          cmap (nth clause 2)]
      (is (= (symbol "?h") (:source cmap)))
      (is (= (symbol "?d") (:target cmap))))))

(deftest var-predicate
  (is (ast/var? (symbol "?s")))
  (is (not (ast/var? 's)))
  (is (not (ast/var? "?s")))
  (is (= (symbol "?s") (ast/->var "?s"))))

(deftest review3-hardening
  (testing "non-seqable :find / :where are a clean 400, not a 500 (no ISeq IllegalArgumentException)"
    (is (= 400 (code-of #(ast/parse {"find" 5 "where" [["span" "?s" {"layer" "x"}]]}))))
    (is (= 400 (code-of #(ast/parse {"find" ["?s"] "where" 7}))))
    (is (= 400 (code-of #(ast/expand {"find" 5 "where" [["span" "?s" {"layer" "x"}]]})))))
  (testing "deeply nested clause bodies are capped at parse with a 400 (no StackOverflowError escaping)"
    (let [nest  (fn nest [n] (if (zero? n) ["span" "?s" {"layer" "x"}] ["not" (nest (dec n))]))
          onest (fn onest [n] (if (zero? n) ["span" "?s" {"layer" "x"}]
                                  ["or" [(onest (dec n))] [["span" "?s" {}]]]))]
      (is (= 400 (code-of #(ast/parse {"find" ["?s"] "where" [(nest 2000)]}))))
      (is (= 400 (code-of #(ast/parse {"find" ["?s"] "where" [(onest 2000)]}))))
      ;; shallow nesting still works
      (is (some? (ast/parse {"find" ["?s"] "where" [(nest 5)]})))))
  (testing ":related* :value accepts a literal or list, but rejects a regex/value-var map (would never match)"
    (let [ok (fn [v] (ast/parse+validate
                      {"find" ["?a" "?b"]
                       "where" [["span" "?a" {"layer" "s"}] ["span" "?b" {"layer" "s"}]
                                ["related*" "?a" "?b" (merge {"layer" "dep"} (when v {"value" v}))]]}))]
      (is (some? (ok nil)))
      (is (some? (ok "nsubj")))
      (is (some? (ok ["nsubj" "obj"])))
      (is (= 400 (code-of #(ok {"regex" "^d"}))) "regex on a :related* edge is rejected, not silently non-matching")
      (is (= 400 (code-of #(ok {"var" "?v"}))) "value-variable on a :related* edge is rejected")))
  (testing "ordering predicates on document/text vars are rejected (entity ids are unordered)"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?d"]
                                              "where" [["document" "?d" {}] ["document" "?d2" {}]
                                                       ["<" "?d" "?d2"]]}))))
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?x"]
                                              "where" [["text" "?x" {}] ["text" "?x2" {}]
                                                       [">" "?x" "?x2"]]}))))))

(deftest review6-hardening
  (testing "ordering predicates on LAYER variables are rejected (layer ids are unordered)"
    (is (= 400 (code-of #(ast/parse+validate
                          {"find" ["?a"]
                           "where" [["span" "?a" {"layer" "?sl"}] ["span" "?b" {"layer" "?sl2"}]
                                    ["span-layer" "?sl" {}] ["span-layer" "?sl2" {}]
                                    ["<" "?sl" "?sl2"]]}))))
    (testing "but = / != on layer vars stay allowed (same/different layer)"
      (is (some? (ast/parse+validate
                  {"find" ["?a"]
                   "where" [["span" "?a" {"layer" "?sl"}] ["span" "?b" {"layer" "?sl2"}]
                            ["span-layer" "?sl" {}] ["span-layer" "?sl2" {}]
                            ["!=" "?sl" "?sl2"]]})))))
  (testing "aggregating over :or where a var is positive in one branch but :not-only in another is a clean 400"
    ;; ?t is positively bound in branch 1, but appears only inside :not in branch 2 —
    ;; the branches would project different entity-var counts -> UNION arity 500.
    ;; Must be rejected at validate, not blow up in SQL.
    (is (= 400 (code-of #(ast/expand
                          {"where" [["span" "?s" {"layer" "p"}]
                                    ["or"
                                     [["token" "?t" {"layer" "w"}] ["covers" "?s" "?t"]]
                                     [["not" ["token" "?t" {"layer" "w"}] ["covers" "?s" "?t"]]]]]
                           "return" {"group" ["?s"] "aggregates" [["count"]]}}))))))

(defn- cmap-of [ast] (nth (first (:where ast)) 2))

(deftest bindings-substitution
  (testing "a placeholder in :layer is spliced to the literal (a pinned ref, not a free layer var)"
    (let [lyr (:layer (cmap-of (ast/parse {"find" ["?s"]
                                           "where" [["span" "?s" {"layer" "?txtl"}]]
                                           "bindings" {"?txtl" "L1"}})))]
      (is (= "L1" lyr))
      (is (string? lyr) "stays a literal, not a layer-var symbol")))
  (testing "a placeholder value can be a scalar or a list (-> alternation)"
    (is (= "NOUN" (:value (cmap-of (ast/parse {"find" ["?s"]
                                               "where" [["span" "?s" {"value" "?v"}]]
                                               "bindings" {"?v" "NOUN"}})))))
    (is (= ["NOUN" "VERB"] (:value (cmap-of (ast/parse {"find" ["?s"]
                                                        "where" [["span" "?s" {"value" "?v"}]]
                                                        "bindings" {"?v" ["NOUN" "VERB"]}}))))))
  (testing "a placeholder splices into :scope ids too"
    (is (= ["MyProj"] (:projects (:scope (ast/parse {"find" ["?s"]
                                                     "where" [["span" "?s" {"layer" "p"}]]
                                                     "scope" {"projects" ["?p"]}
                                                     "bindings" {"?p" "MyProj"}}))))))
  (testing "no chaining: a binding value that looks like a var stays a literal string"
    (let [v (:value (cmap-of (ast/parse {"find" ["?s"]
                                         "where" [["span" "?s" {"value" "?a"}]]
                                         "bindings" {"?a" "?b"}})))]
      (is (= "?b" v))
      (is (string? v))))
  (testing "without a binding, a ?-token keeps its normal meaning (here, a layer var)"
    (is (ast/var? (:layer (cmap-of (ast/parse {"find" ["?s"] "where" [["span" "?s" {"layer" "?sl"}]]}))))))
  (testing "REST shape: the body arrives keyword-keyed (Muuntaja), so a bindings key is :?lyr"
    ;; placeholders used as clause VALUES stay strings (only keys are keywordized)
    (is (= "L9" (:layer (cmap-of (ast/parse {:find ["?s"]
                                             :where [["span" "?s" {:layer "?lyr"}]]
                                             :bindings {:?lyr "L9"}}))))))
  (testing "strict + shape errors are all 400"
    ;; unused binding
    (is (= 400 (code-of #(ast/parse {"find" ["?s"] "where" [["span" "?s" {}]] "bindings" {"?x" "u"}}))))
    ;; placeholder used where a var is required (:find) -> caught downstream as a literal
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?x"] "where" [["span" "?x" {"layer" "L"}]]
                                              "bindings" {"?x" "u"}}))))
    ;; non-?-prefixed binding key
    (is (= 400 (code-of #(ast/parse {"find" ["?s"] "where" [["span" "?s" {"value" "x"}]]
                                     "bindings" {"txtl" "u"}}))))
    ;; map value rejected
    (is (= 400 (code-of #(ast/parse {"find" ["?s"] "where" [["span" "?s" {"value" "?v"}]]
                                     "bindings" {"?v" {"regex" "x"}}}))))
    ;; empty-list value rejected
    (is (= 400 (code-of #(ast/parse {"find" ["?s"] "where" [["span" "?s" {"value" "?v"}]]
                                     "bindings" {"?v" []}}))))
    ;; non-map :bindings
    (is (= 400 (code-of #(ast/parse {"find" ["?s"] "where" [["span" "?s" {}]] "bindings" "nope"}))))))

(deftest field-paths
  (testing "a dotted predicate term parses to a field-ref and validates"
    (is (some? (ast/parse+validate {"find" ["?t"] "where" [["token" "?t" {"layer" "w"}] [">=" "?t.begin" 5]]})))
    (is (some? (ast/parse+validate {"find" ["?a" "?b"]
                                    "where" [["span" "?a" {"layer" "p"}] ["span" "?b" {"layer" "p"}]
                                             ["=" "?a.value" "?b.value"] ["!=" "?a" "?b"]]})))
    (is (some? (ast/parse+validate {"find" ["?t"] "where" [["token" "?t" {"layer" "w"}] [">=" "?t.metadata.score" 5]]})))
    (is (some? (ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "?sl"}] ["span-layer" "?sl" {}]
                                                           ["=" "?sl.config.color" "red"]]}))))
  (testing "a dotted name in :find is rejected (use return entities)"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?t.begin"] "where" [["token" "?t" {"layer" "w"}]]})))))
  (testing "a dotted name in a clause's var slot is rejected (not a bindable variable)"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s.x" {"layer" "p"}]]})))))
  (testing "ordering preds on an opaque id field (.id/.doc) are rejected; = / != are fine"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?t"] "where" [["token" "?t" {"layer" "w"}] [">" "?t.id" "x"]]}))))
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?t"] "where" [["token" "?t" {"layer" "w"}] ["<" "?t.doc" "x"]]}))))
    (is (some? (ast/parse+validate {"find" ["?t"] "where" [["token" "?t" {"layer" "w"}] ["=" "?t.doc" "x"]]}))))
  (testing "unknown / wrong-kind fields are rejected"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?t"] "where" [["token" "?t" {"layer" "w"}] [">" "?t.bogus" 5]]})))
        "unknown attr")
    (is (some? (ast/parse+validate {"find" ["?t"] "where" [["token" "?t" {"layer" "w"}] ["=" "?t.value" "cat"]]}))
        "value IS now a token field (the surface substring)")
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "?sl"}] ["span-layer" "?sl" {}]
                                                                     ["=" "?sl.metadata.x" 1]]})))
        "metadata is entity-only, config is layer-only"))
  (testing "an idiom-mismatched core attr still resolves (canonicalized), metadata keys stay verbatim"
    ;; ?t.Begin canonicalizes to begin; only the QL-vocab segment is canonicalized
    (is (some? (ast/parse+validate {"find" ["?t"] "where" [["token" "?t" {"layer" "w"}] [">=" "?t.Begin" 5]]})))
    (let [fr (nth (last (:where (ast/parse {"find" ["?t"]
                                            "where" [["token" "?t" {"layer" "w"}] ["=" "?t.metadata.caseKey" "X"]]}))) 1)]
      (is (= ["metadata" "caseKey"] (ast/field-path fr)) "user key kept verbatim"))))

(deftest field-paths-review-fixes
  (testing "group by a field path is allowed (mirrors aggregate sources)"
    (is (some? (ast/expand {"where" [["token" "?t" {"layer" "w"}]]
                            "return" {"group" ["?t.begin"] "aggregates" [["count"]]}}))))
  (testing "config / metadata need a key (symmetric)"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "?sl"}] ["span-layer" "?sl" {}]
                                                                     ["=" "?sl.config" "x"]]}))))
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?t"] "where" [["token" "?t" {"layer" "w"}] ["=" "?t.metadata" "x"]]})))))
  (testing "metadata/config on the wrong kind of var is a clean 400 (not a 500 at compile)"
    ;; metadata on a scalar value-var head
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?t"] "where" [["token" "?t" {"layer" "w" "begin" {"var" "?b"}}]
                                                                     ["=" "?b.metadata.k" "x"]]}))))
    ;; config on an entity var
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["=" "?s.config.k" "x"]]}))))))

(deftest layer-structural-slots
  (testing "a structural-slot var binds the parent layer kind; the whole chain is inferred"
    (let [a (ast/parse+validate {"find" ["?txtl"]
                                 "where" [["span" "?s" {"layer" "?sl"}]
                                          ["span-layer" "?sl" {"token-layer" "?tl"}]
                                          ["token-layer" "?tl" {"text-layer" "?txtl"}]
                                          ["text-layer" "?txtl" {"name" "Transcription"}]]})]
      (is (= {(symbol "?s") :span (symbol "?sl") :span-layer
              (symbol "?tl") :token-layer (symbol "?txtl") :text-layer}
             (::ast/var-kinds a)))))
  (testing "parent-token-layer nests token layers; a slot var is positively bound (find-able)"
    (is (some? (ast/parse+validate {"find" ["?s"]
                                    "where" [["token-layer" "?w" {"parent-token-layer" "?s" "name" "words"}]]}))))
  (testing "a scalar slot reference stays a literal string (not var-ized)"
    (let [p (ast/parse {"find" ["?tl"] "where" [["token-layer" "?tl" {"text-layer" "Transcription"}]]})]
      (is (= "Transcription" (get-in (first (:where p)) [2 :text-layer])))))
  (testing "text-layer is a queryable kind with name + alias"
    (is (some? (ast/parse+validate {"find" ["?x"] "where" [["text-layer" "?x" {"name" "T" "alias" "t"}]]}))))
  (testing "kind conflict: a var used as two different layer kinds is a 400"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?x"]
                                              "where" [["span-layer" "?x" {"token-layer" "?x"}]]})))))
  (testing "unknown slot for a kind is a 400 (span-layer has no text-layer slot)"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?sl"] "where" [["span-layer" "?sl" {"text-layer" "?x"}]]})))))
  (testing "a list slot value (no alternation) is a 400"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?tl"] "where" [["token-layer" "?tl" {"text-layer" ["a" "b"]}]]})))))
  (testing "a map slot value (no regex / value-var) is a 400"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?tl"] "where" [["token-layer" "?tl" {"text-layer" {"regex" "x"}}]]})))))
  (testing "a dotted name in a slot var position is a 400 (slots bind, paths don't)"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?tl"] "where" [["token-layer" "?tl" {"text-layer" "?x.name"}]]}))))))

(deftest malformed-input-400-not-500
  ;; edge-hunt: each of these used to throw an uncaught error (-> opaque 500) or slip
  ;; through validation; all must be a clean 400.
  (testing "a map predicate term (not a var/field-path/literal) is rejected"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"]
                                              "where" [["span" "?s" {"layer" "p" "value" {"var" "?v"}}]
                                                       ["=" "?v" {"a" 1}]]})))))
  (testing "a value-var or regex map on a layer clause's :name/:alias is rejected"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "?sl"}]
                                                                     ["span-layer" "?sl" {"name" {"var" "?v"}}]]}))))
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "?sl"}]
                                                                     ["span-layer" "?sl" {"alias" {"regex" "^p"}}]]})))))
  (testing "a non-map :metadata value is rejected (not a parse-time crash)"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p" "metadata" "foo"}]]}))))
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p" "metadata" 7}]]})))))
  (testing "a non-list :return :group / :aggregates is rejected"
    (is (= 400 (code-of #(ast/parse+validate {"where" [["span" "?s" {"layer" "p"}]]
                                              "return" {"group" 5 "aggregates" [["count"]]}}))))
    (is (= 400 (code-of #(ast/parse+validate {"where" [["span" "?s" {"layer" "p"}]]
                                              "return" {"group" [] "aggregates" 5}})))))
  (testing "a non-list :scope :projects / :project-ids is rejected"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}]] "scope" {"projects" 5}}))))
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}]] "scope" {"project-ids" 5}}))))))

(deftest attr-predicate-ops
  ;; the Datalog-style `~` (regex) and `in` (membership) ops + reference dot-paths
  (testing "~ / in / reference paths on bound vars validate"
    (is (some? (ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["~" "?s.value" "^N"]]}))
        "bare-string regex")
    (is (some? (ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["~" "?s.value" {"regex" "^n" "flags" "i"}]]}))
        "regex spec + flags")
    (is (some? (ast/parse+validate {"find" ["?t"] "where" [["token" "?t" {"layer" "w"}] ["~" "?t.value" "^a"]]}))
        "~ on a token surface")
    (is (some? (ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["~" "?s.metadata.k" "x"]]}))
        "~ on metadata")
    (is (some? (ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["in" "?s.value" ["NOUN" "PROPN"]]]}))
        "in alternation")
    (is (some? (ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "?sl"}] ["span-layer" "?sl" {}]
                                                           ["=" "?s.layer" "?sl"]]}))
        "?s.layer join to a layer var")
    (is (some? (ast/parse+validate {"find" ["?sp"] "where" [["relation" "?r" {"layer" "dep"}] ["span" "?sp" {"layer" "p"}]
                                                            ["=" "?r.source" "?sp"]]}))
        "?r.source join to a span var"))
  (testing "the regex op parses to the keyword named \"~\", with the LHS a field-ref"
    (let [clause (last (:where (ast/parse {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["~" "?s.value" "^N"]]})))]
      (is (= (keyword "~") (first clause)))
      (is (ast/field-ref? (second clause)))
      (is (= {:regex "^N"} (nth clause 2)) "bare string normalized to a regex spec")))
  (testing "~ requires a TEXT field on the left (numeric/opaque/reference rejected)"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?t"] "where" [["token" "?t" {"layer" "w"}] ["~" "?t.begin" "1"]]}))))
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["~" "?s.id" "x"]]}))))
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["~" "?s.layer" "x"]]})))))
  (testing "~ requires a field-ref LHS and a regex RHS"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["~" "?s" "x"]]})))
        "a bare var LHS is rejected")
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["~" "?s.value" 5]]})))
        "a non-string/non-regex-map RHS is rejected")
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["~" "?s.value" {"regex" "("}]]})))
        "an invalid regex is a 400 at validation"))
  (testing "in requires a non-empty list of literals"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["in" "?s.value" []]]}))))
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["in" "?s.value" [{"a" 1}]]]}))))
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["in" "NOUN" ["x"]]]})))
        "a literal LHS is rejected"))
  (testing "~ / in reject extra arguments (not silently dropped)"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["~" "?s.value" "x" "y"]]}))))
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["in" "?s.value" ["x"] ["y"]]]})))))
  (testing "G4: a name literal against a reference field is a loud 400 (= and in)"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["=" "?s.layer" "pos"]]}))))
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?r"] "where" [["relation" "?r" {"layer" "dep"}] ["!=" "?r.source" "span"]]}))))
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["in" "?s.layer" ["pos"]]]}))))
    (is (some? (ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}]
                                                           ["=" "?s.layer" "11111111-1111-1111-1111-111111111111"]]}))
        "a UUID literal IS accepted (no resolution, scope confines results)"))
  (testing "G4: a wrong-KIND variable against a reference field is a loud 400 (parity with the map form)"
    ;; ?s.layer targets a span-layer; comparing to a span var would silently never match
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["span" "?sp" {"layer" "q"}]
                                                                     ["=" "?s.layer" "?sp"]]}))))
    ;; ?r.source targets a span; comparing to a token var is rejected
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?r"] "where" [["relation" "?r" {"layer" "dep"}] ["token" "?t" {"layer" "w"}]
                                                                     ["=" "?r.source" "?t"]]}))))
    ;; the right kinds are accepted: ?s.layer = a span-layer var, ?r.source = a span var
    (is (some? (ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "?sl"}] ["span-layer" "?sl" {}]
                                                           ["=" "?s.layer" "?sl"]]})))
    (is (some? (ast/parse+validate {"find" ["?r"] "where" [["relation" "?r" {"layer" "dep"}] ["span" "?sp" {"layer" "p"}]
                                                           ["=" "?r.source" "?sp"]]}))))
  (testing "ordering ops on a reference field are rejected"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "?sl"}] ["span-layer" "?sl" {}]
                                                                     ["<" "?s.layer" "?sl"]]})))))
  (testing "~ / in are not allowed inside :not (v0, like other predicates)"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}]
                                                                     [:not ["~" "?s.value" "x"]]]}))))
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}]
                                                                     [:not ["in" "?s.value" ["x"]]]]})))))
  (testing "a reference field on the wrong kind is an unknown-field 400 (document has no layer)"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?d"] "where" [["document" "?d" {}] ["=" "?d.layer" "?x"]]})))))
  (testing "the regex op does not alias a typed word (\"match\" is an unknown clause head)"
    (is (= 400 (code-of #(ast/parse+validate {"find" ["?s"] "where" [["span" "?s" {"layer" "p"}] ["match" "?s.value" "x"]]}))))))
