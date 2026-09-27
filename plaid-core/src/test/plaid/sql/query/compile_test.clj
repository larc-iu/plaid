(ns plaid.sql.query.compile-test
  "Unit tests for the AST -> HoneySQL compiler. Pure: resolved ASTs are
  hand-constructed (with ::qr/scope, ::qr/layer-universe and ::qr/layer-ids
  attached) so no DB is
  needed. Assertions are structural (aliases are generated, so we search the
  compiled tree rather than compare exact maps)."
  (:require [clojure.test :refer [deftest is testing]]
            [honey.sql :as hsql]
            [plaid.query.ast :as ast]
            [plaid.sql.query.compile :as qc]
            [plaid.sql.query.resolve :as qr]))

(defn- nodes
  "All sub-forms of a compiled HoneySQL map (for structural search)."
  [m]
  (tree-seq coll? seq m))

(defn- sql-of [hq] (first (hsql/format hq)))

(def ^:private universe
  "Every in-scope layer id per layer table, as resolve attaches it."
  {:text_layers ["UX"] :token_layers ["UT1" "UT2"] :span_layers ["US"]
   :relation_layers ["UR"] :vocab_layers ["UV"]})

(defn- resolved
  "Build a resolved AST: validate, then attach scope, the layer universe, and
  layer-ids onto each :span/:token/:relation clause that names a :layer."
  [raw scope layer-ids]
  (let [checked (ast/parse+validate raw)
        where' (mapv (fn [[head v cmap :as clause]]
                       (if (and (map? cmap) (:layer cmap))
                         [head v (assoc cmap ::qr/layer-ids layer-ids)]
                         clause))
                     (:where checked))]
    (-> checked (assoc :where where') (assoc ::qr/scope scope) (assoc ::qr/layer-universe universe))))

(deftest compiles-value-and-layer-filters
  (let [hq (qc/compile-query
            (resolved {"find" ["?s"] "where" [["span" "?s" {"layer" "pos" "value" "NOUN"}]]}
                      #{"P1"} ["L1" "L2"]))
        sql (sql-of hq)]
    (testing "spans table is the anchor"
      (is (some #(and (vector? %) (= :spans (first %))) (nodes hq))))
    (testing "value is JSON-encoded to its stored literal"
      (is (some #(= "\"NOUN\"" %) (nodes hq))))
    (testing "layer ids drive an IN filter (= the ACL filter for layer-named clauses)"
      (is (some #(= % [:in :s_1.span_layer_id ["L1" "L2"]]) (nodes hq))))
    (testing "select-distinct with the find var aliased without the ?"
      (is (= [[:s_1.id :s]] (:select-distinct hq))))
    (is (string? sql))))

(deftest acl-invariant-layerless-var-scoped-by-the-universe
  (testing "a token introduced only by :covers (no :layer) is scoped to the in-scope token layers"
    (let [hq (qc/compile-query
              (resolved {"find" ["?t"]
                         "where" [["span" "?s" {"layer" "pos" "value" "NOUN"}]
                                  ["covers" "?s" "?t"]]}
                        #{"PA" "PB"} ["L1"]))]
      (is (some #(= % [:in :t_2.token_layer_id ["UT1" "UT2"]]) (nodes hq)))
      (testing "as a list on its own layer column, never a join to the layer table"
        (is (not-any? #(and (vector? %) (= :token_layers (first %))) (:from hq))))))
  (testing "an entity whose layer is a variable is scoped to the universe AND joined to the variable"
    (let [hq (qc/compile-query
              (resolved {"find" ["?s"]
                         "where" [["span" "?s" {"layer" "?sl" "value" "NOUN"}]
                                  ["span-layer" "?sl" {"name" "pos"}]]}
                        #{"P1"} nil))
          sql (sql-of hq)]
      (is (some #(= % [:in :s_2.span_layer_id ["US"]]) (nodes hq)))
      (is (re-find #"s_2\.span_layer_id = slv_1\.id" sql))
      (testing "the layer variable itself is scoped by id"
        (is (some #(= % [:in :slv_1.id ["US"]]) (nodes hq))))))
  (testing "a text is scoped through the in-scope documents, without a join"
    (let [hq (qc/compile-query
              (resolved {"find" ["?x"] "where" [["text" "?x" {}]]} #{"P1"} nil))]
      (is (= [[:texts :tx_1]] (:from hq)))
      (is (re-find #"tx_1\.document_id IN \(SELECT id FROM documents WHERE project_id IN" (sql-of hq))))))

(deftest acl-invariant-every-entity-alias-scoped
  (testing "every span/token alias in the compiled query carries a scope predicate"
    (let [hq (qc/compile-query
              (resolved {"find" ["?s1" "?s2"]
                         "where" [["span" "?s1" {"layer" "pos" "value" "NOUN"}]
                                  ["span" "?s2" {"layer" "pos" "value" "VERB"}]
                                  ["covers" "?s1" "?t1"] ["covers" "?s2" "?t2"]
                                  ["precedes" "?t1" "?t2"]]}
                        #{"P1"} ["L1"]))
          ;; collect aliases that appear as a span/token table in :from
          from-aliases (->> (:from hq)
                            (filter (fn [[t _]] (#{:spans :tokens} t)))
                            (map second)
                            set)
          ;; an alias is "scoped" if it appears in a layer-id IN (its span_layer_id)
          ;; or in a token_layer_id = lt.id join
          where-str (sql-of hq)]
      (is (= 4 (count from-aliases)) "two spans + two tokens")
      ;; spans scoped by their named layer, tokens by every in-scope token layer
      (is (re-find #"s_\d+\.span_layer_id IN" where-str))
      (is (= 2 (count (re-seq #"t_\d+\.token_layer_id IN" where-str)))))))

(deftest precedes-emits-successor-subquery
  (let [hq (qc/compile-query
            (resolved {"find" ["?t1" "?t2"]
                       "where" [["token" "?t1" {"layer" "w"}]
                                ["token" "?t2" {"layer" "w"}]
                                ["precedes" "?t1" "?t2"]]}
                      #{"P1"} ["L1"]))
        ;; find the correlated subquery: a map with :order-by + :limit 1
        subq (some (fn [n] (and (map? n) (= 1 (:limit n)) (:order-by n) n)) (nodes hq))]
    (is (some? subq) "successor subquery present")
    (testing "row-value compare + ORDER BY on the canonical (begin, precedence NULLS LAST, end, id) key"
      (let [sql (sql-of hq)]
        (is (re-find #"\(.*begin.*precedence.*end_.*id\) > \(.*begin.*precedence.*end_.*id\)" sql))
        (is (re-find #"precedence ASC NULLS LAST" sql))
        (is (re-find #"end_ ASC" sql))))))

(deftest precedes-star-emits-row-value-compare
  (let [hq (qc/compile-query
            (resolved {"find" ["?t1" "?t2"]
                       "where" [["token" "?t1" {"layer" "w"}]
                                ["token" "?t2" {"layer" "w"}]
                                ["precedes*" "?t1" "?t2"]]}
                      #{"P1"} ["L1"]))
        sql (sql-of hq)]
    ;; transitive: same text+layer guard + a row-value < on the 4-key canonical
    ;; order (no LIMIT 1 subquery)
    (is (re-find #"text_id = .*text_id" sql))
    (is (re-find #"\(.*begin.*precedence.*end_.*id\) < \(.*begin.*precedence.*end_.*id\)" sql))))

(deftest relation-source-target
  (let [hq (qc/compile-query
            (resolved {"find" ["?r"]
                       "where" [["relation" "?r" {"layer" "dep" "value" "nsubj"
                                                  "source" "?h" "target" "?d"}]
                                ["span" "?h" {"layer" "pos"}]
                                ["span" "?d" {"layer" "pos"}]]}
                      #{"P1"} ["L1"]))
        sql (sql-of hq)]
    (is (some #(and (vector? %) (= :relations (first %))) (nodes hq)))
    (is (re-find #"source_span_id = " sql))
    (is (re-find #"target_span_id = " sql))))

;; ---------------------------------------------------------------------------
;; DISTINCT elision in aggregate mode
;; ---------------------------------------------------------------------------
;; Aggregate mode projects every var alias's `id`, so when the FROM holds nothing
;; but var aliases the rows are already distinct and the DISTINCT is pure cost —
;; a temp B-tree over every match. On the alpha server the project list's
;; per-layer token count spent 3.8s in it and 0.2s without. Any other alias can
;; repeat a match, and keeps it.

(defn- agg-select-key
  "Whether the compiled aggregate match query is DISTINCT or not."
  [hq]
  (cond (:select-distinct hq) :select-distinct
        (:select hq)          :select
        :else                 nil))

(deftest aggregate-drops-redundant-distinct
  (testing "tokens joined only to their layer var: every FROM alias is projected"
    (let [hq (qc/compile-query
              (resolved {"where" [["token" "?t" {"layer" "?l"}]]
                         "return" {"group" ["?l"] "aggregates" [["count"]]}}
                        #{"P1"} nil))]
      (is (= :select (agg-select-key hq)))
      (is (not (clojure.string/includes? (sql-of hq) "DISTINCT"))))))

(deftest aggregate-keeps-distinct-over-a-junction
  (testing "covers pulls in span_tokens, which can repeat a span — DISTINCT stays"
    (let [hq (qc/compile-query
              (resolved {"where" [["span" "?s" {"layer" "pos"}]
                                  ["token" "?t" {"layer" "?tl"}]
                                  ["covers" "?s" "?t"]]
                         "return" {"group" ["?tl"] "aggregates" [["count"]]}}
                        #{"P1"} ["L1"]))]
      (is (= :select-distinct (agg-select-key hq))))))

(deftest aggregate-drops-distinct-for-a-vocab-var
  (testing "a vocab entry is scoped by the granted layers as a list, not a join to
  the grants, so one granted to two in-scope projects is one row and the DISTINCT goes"
    (let [hq (qc/compile-query
              (resolved {"where" [["vocab" "?i" {}]]
                         "return" {"group" [] "aggregates" [["count"]]}}
                        #{"P1" "P2"} nil))]
      (is (some #(= % [:in :v_1.vocab_layer_id ["UV"]]) (nodes hq)))
      (is (not-any? #(and (vector? %) (= :project_vocabs (first %))) (:from hq)))
      (is (= :select (agg-select-key hq))))))
