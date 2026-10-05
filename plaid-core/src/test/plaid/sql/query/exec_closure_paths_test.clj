(ns plaid.sql.query.exec-closure-paths-test
  "`related*` compiles several ways, by which of its ends are already bound
  and what else the query narrows: the closure of the layer as a table (first
  in a fixed order, or where SQLite puts it), the closure from or to an end
  pinned to an id or bound outside a `not`, a membership from the end a `not`
  body ties to its outer row, and a membership test on a pair. Each is
  checked here against a closure computed in Clojure, over random graphs with
  cycles, edge values and a span value to filter on."
  (:require [clojure.set :as set]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin
                                    db admin-request assert-created]]
            [plaid.test-helpers :as h]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(def ^:private n-spans 24)

(defn- id [r] (-> r :body :id))

(defn- ids-of [r]
  (assert-created r)
  (-> r :body :ids))

(defn- build!
  "One document of `n-spans` words, a span on each (value \"x\" or \"y\"), and
  random relations between them (value \"det\" or \"obj\"), cycles
  included."
  [seed]
  (let [rnd (java.util.Random. seed)
        pid (h/create-test-project admin-request (str "Paths" seed))
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl (id (h/create-span-layer admin-request tokl "node"))
        rl (id (h/create-relation-layer admin-request sl "dep"))
        doc (h/create-test-document admin-request pid "d")
        words (mapv #(str "w" %) (range n-spans))
        extents (second (reduce (fn [[p acc] w] [(+ p (count w) 1) (conj acc [p (+ p (count w))])])
                                [0 []] words))
        text (id (h/create-text admin-request txtl doc (str/join " " words)))
        toks (ids-of (h/bulk-create-tokens admin-request
                                           (mapv (fn [[b e]] {:token-layer-id tokl :text text :begin b :end e}) extents)))
        svals (vec (repeatedly n-spans #(if (< (.nextInt rnd 4) 1) "x" "y")))
        spans (mapv str (ids-of (h/bulk-create-spans admin-request
                                                     (mapv (fn [t v] {:span-layer-id sl :tokens [t] :value v}) toks svals))))
        edges (->> (repeatedly 30 (fn [] [(.nextInt rnd n-spans) (.nextInt rnd n-spans)
                                          (if (.nextBoolean rnd) "det" "obj")]))
                   (remove (fn [[s t]] (= s t)))
                   distinct
                   vec)]
    (ids-of (h/bulk-create-relations admin-request
                                     (mapv (fn [[s t v]] {:relation-layer-id rl :source (spans s) :target (spans t) :value v})
                                           edges)))
    {:pid pid :tokl tokl :sl sl :rl rl :toks (mapv str toks) :spans spans :svals svals :edges edges}))

(defn- closure
  "i -> the set of j reached from i in one or more hops over `edges`."
  [edges]
  (let [succ (reduce (fn [m [s t]] (update m s (fnil conj #{}) t)) {} edges)]
    (into {}
          (for [i (range n-spans)]
            [i (loop [seen #{} frontier (get succ i #{})]
                 (if (empty? frontier)
                   seen
                   (let [seen' (into seen frontier)]
                     (recur seen' (set/difference (set (mapcat #(get succ % #{}) frontier)) seen')))))]))))

(defn- check-graph! [seed]
  (let [{:keys [pid tokl sl rl toks spans svals edges]} (build! seed)
        reach (closure edges)
        reach-det (closure (filter #(= "det" (nth % 2)) edges))
        all (range n-spans)
        x? #(= "x" (svals %))
        q (fn [find where & [extra]]
            (:results (qe/run db "admin@example.com"
                              (merge (cond-> {"where" where "scope" {"project-ids" [pid]} "limit" 100000}
                                       find (assoc "find" find))
                                     extra))))
        rows (fn [r] (set (map #(mapv str %) r)))
        one (fn [r] (set (map (comp str first) r)))
        sp (fn [v & [m]] ["span" v (merge {"layer" sl} m)])
        rel (fn [a b & [m]] ["related*" a b (merge {"layer" rl} m)])]
    (testing (str "graph " seed)
      (testing "every pair, the closure of the layer leading the FROM"
        (is (= (set (for [i all j (reach i)] [(spans i) (spans j)]))
               (rows (q ["?a" "?b"] [(sp "?a") (sp "?b") (rel "?a" "?b")])))))
      (testing "an edge value"
        (is (= (set (for [i all j (reach-det i)] [(spans i) (spans j)]))
               (rows (q ["?a" "?b"] [(sp "?a") (sp "?b") (rel "?a" "?b" {"value" "det"})])))))
      (testing "a not with its source bound outside, the closure forward from it"
        (is (= (set (for [i all :when (not-any? x? (reach i))] (spans i)))
               (one (q ["?a"] [(sp "?a") ["not" (sp "?b" {"value" "x"}) (rel "?a" "?b")]])))))
      (testing "a not with its target bound outside, the closure backward to it"
        (is (= (set (for [j all :when (not-any? #(and (x? %) (contains? (reach %) j)) all)] (spans j)))
               (one (q ["?b"] [(sp "?b") ["not" (sp "?a" {"value" "x"}) (rel "?a" "?b")]])))))
      (testing "a not with both ends bound outside, a membership test"
        (is (= (set (for [i all j all :when (not (contains? (reach i) j))] [(spans i) (spans j)]))
               (rows (q ["?a" "?b"] [(sp "?a") (sp "?b") ["not" (rel "?a" "?b")]])))))
      (testing "a not with neither end bound outside, from the end its body ties to the outer row"
        (is (= (set (for [i all :when (not-any? x? (reach i))] (toks i)))
               (one (q ["?t"] [["token" "?t" {"layer" tokl}]
                               ["not" (sp "?x") ["covers" "?x" "?t"] (sp "?y" {"value" "x"}) (rel "?x" "?y")]]))))
        (is (= (set (for [j all :when (not-any? #(and (x? %) (contains? (reach %) j)) all)] (toks j)))
               (one (q ["?t"] [["token" "?t" {"layer" tokl}]
                               ["not" (sp "?x") ["covers" "?x" "?t"] (sp "?y" {"value" "x"}) (rel "?y" "?x")]])))))
      (testing "an end pinned to an id"
        (let [i (first (filter #(seq (reach %)) all))
              j (first (filter #(some (fn [k] (contains? (reach k) %)) all) all))]
          (is (= (set (map spans (reach i)))
                 (one (q ["?b"] [(sp "?a") ["=" "?a.id" (spans i)] (sp "?b") (rel "?a" "?b")]))))
          (is (= (set (for [k all :when (contains? (reach k) j)] (spans k)))
                 (one (q ["?a"] [(sp "?b") ["=" "?b.id" (spans j)] (sp "?a") (rel "?a" "?b")]))))))
      (testing "a closure beside a narrowing clause"
        (is (= (set (for [i all :when (x? i) j (reach i)] [(spans i) (spans j)]))
               (rows (q ["?a" "?b"] [(sp "?a" {"value" "x"}) (sp "?b") (rel "?a" "?b")])))))
      (testing "two in one query"
        (is (= (set (for [i all k all
                          :when (some #(and (x? %) (contains? (reach %) k)) (reach i))]
                      [(spans i) (spans k)]))
               (rows (q ["?a" "?c"] [(sp "?a") (sp "?b" {"value" "x"}) (sp "?c")
                                     (rel "?a" "?b") (rel "?b" "?c")])))))
      (testing "a not whose body holds two"
        (is (= (set (for [i all :when (not (some #(and (x? %) (seq (reach %))) (reach i)))] (spans i)))
               (one (q ["?a"] [(sp "?a") ["not" (sp "?b" {"value" "x"}) (sp "?c")
                                          (rel "?a" "?b") (rel "?b" "?c")]])))))
      (testing "a span that reaches itself, through a cycle"
        (is (= (set (for [i all :when (contains? (reach i) i)] (spans i)))
               (one (q ["?a"] [(sp "?a") (rel "?a" "?a")])))))
      (testing "a count of the pairs"
        (is (= [[(reduce + (map count (vals reach)))]]
               (q nil [(sp "?a") (sp "?b") (rel "?a" "?b")]
                  {"return" {"group" [] "aggregates" [["count"]]}})))))))

(deftest related-star-agrees-with-the-closure-on-every-path
  (doseq [seed [1 2 3 4 5]]
    (check-graph! seed)))
