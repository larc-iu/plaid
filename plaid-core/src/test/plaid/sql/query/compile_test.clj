(ns plaid.sql.query.compile-test
  "Unit tests for the AST -> HoneySQL compiler. Pure: resolved ASTs are
  hand-constructed (with ::qr/scope and ::qr/layer-ids attached) so no DB is
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

(defn- resolved
  "Build a resolved AST: validate, then attach scope + layer-ids onto each
  :span/:token/:relation clause that names a :layer."
  [raw scope layer-ids]
  (let [checked (ast/parse+validate raw)
        where' (mapv (fn [[head v cmap :as clause]]
                       (if (and (map? cmap) (:layer cmap))
                         [head v (assoc cmap ::qr/layer-ids layer-ids)]
                         clause))
                     (:where checked))]
    (-> checked (assoc :where where') (assoc ::qr/scope scope))))

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

(deftest acl-invariant-layerless-var-gets-scope-join
  (testing "a token introduced only by :covers (no :layer) is scoped via a layer-table join"
    (let [hq (qc/compile-query
              (resolved {"find" ["?t"]
                         "where" [["span" "?s" {"layer" "pos" "value" "NOUN"}]
                                  ["covers" "?s" "?t"]]}
                        #{"PA" "PB"} ["L1"]))]
      ;; the token's layer table (token_layers) is joined ...
      (is (some #(and (vector? %) (= :token_layers (first %))) (nodes hq)))
      ;; ... and filtered by project_id IN scope
      (is (some (fn [n] (and (vector? n) (= :in (first n))
                             (= :project_id (some-> (second n) name (clojure.string/split #"\.") second keyword))
                             (= (set (nth n 2)) #{"PA" "PB"})))
                (nodes hq))))))

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
      ;; spans scoped by span_layer_id IN; tokens scoped by token_layer_id = lt.id
      (is (re-find #"s_\d+\.span_layer_id IN" where-str))
      (is (re-find #"t_\d+\.token_layer_id = lt_\d+\.id" where-str)))))

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
