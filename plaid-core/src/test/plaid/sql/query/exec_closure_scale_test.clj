(ns plaid.sql.query.exec-closure-scale-test
  "`related*` over every pair of a 4,000-word treebank answers in time and
  exactly (H6-CORE-API-2). A recursive CTE correlated on both ends ran once per
  candidate pair: 16.5 s on 2,000 words and a 408 on 4,000. Now 0.1 s.

  And it does so whatever the planner's statistics say (FX6-RELATED): on none,
  on statistics of the data itself, and on statistics taken while the database
  held three spans, where every query below ran past the 30 s limit."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin
                                    db admin-request assert-created]]
            [plaid.test-helpers :as h]
            [plaid.sql.common :as psc]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(def ^:private n-sentences 400)
(def ^:private per-sentence 10)

(defn- id [r] (-> r :body :id))

(defn- ids-of [r]
  (assert-created r)
  (-> r :body :ids))

(defn- build!
  "Sentences of ten words, a POS span on each word and a dependency tree per
  sentence, every head earlier in the sentence than its dependent. Also a
  sentence token over each sentence and a UPOS span on each word (VERB on
  every third word, else NOUN), for the shapes ud's Grew search compiles to.
  Returns the layers and the expected (ancestor, descendant) pairs."
  []
  (let [rnd (java.util.Random. 7)
        pid (h/create-test-project admin-request "Treebank")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sentl (id (h/create-token-layer admin-request txtl "sentences"))
        upos (id (h/create-span-layer admin-request tokl "upos"))
        pos (id (h/create-span-layer admin-request tokl "pos"))
        dep (id (h/create-relation-layer admin-request pos "dep"))
        doc (h/create-test-document admin-request pid "d1")
        n (* n-sentences per-sentence)
        words (mapv #(str "w" (mod % 89)) (range n))
        body (str/join " " words)
        extents (second (reduce (fn [[p acc] w] [(+ p (count w) 1) (conj acc [p (+ p (count w))])])
                                [0 []] words))
        text (id (h/create-text admin-request txtl doc body))
        toks (vec (mapcat (fn [ch] (ids-of (h/bulk-create-tokens
                                            admin-request
                                            (mapv (fn [[b e]] {:token-layer-id tokl :text text :begin b :end e}) ch))))
                          (partition-all 1000 extents)))
        _ (ids-of (h/bulk-create-tokens
                   admin-request
                   (for [s (range n-sentences)]
                     {:token-layer-id sentl :text text
                      :begin (first (extents (* s per-sentence)))
                      :end (second (extents (dec (* (inc s) per-sentence))))})))
        verb? (fn [i] (zero? (mod i 3)))
        _ (doseq [ch (partition-all 1000 (map-indexed vector toks))]
            (ids-of (h/bulk-create-spans
                     admin-request
                     (mapv (fn [[i t]] {:span-layer-id upos :tokens [t] :value (if (verb? i) "VERB" "NOUN")}) ch))))
        spans (vec (mapcat (fn [ch] (ids-of (h/bulk-create-spans
                                             admin-request
                                             (mapv (fn [t] {:span-layer-id pos :tokens [t] :value "X"}) ch))))
                           (partition-all 1000 toks)))
        heads (into {} (for [s (range n-sentences)
                             j (range 1 per-sentence)
                             :let [i (+ (* s per-sentence) j)]]
                         [i (+ (* s per-sentence) (.nextInt rnd j))]))
        _ (doseq [ch (partition-all 1000 heads)]
            (ids-of (h/bulk-create-relations
                     admin-request
                     (mapv (fn [[d hd]] {:relation-layer-id dep :source (spans hd) :target (spans d) :value "r"}) ch))))
        ancestors (fn [i] (take-while some? (rest (iterate heads i))))
        expected (set (for [i (range n) a (ancestors i)] [(str (spans a)) (str (spans i))]))]
    {:pid pid :words tokl :sentences sentl :upos upos :pos pos :dep dep :expected expected
     :toks (mapv str toks) :verb? verb?
     :ancestors (fn [i] (set (ancestors i)))
     :leaves (set (map (comp str spans) (remove (set (vals heads)) (range n))))
     :roots (set (map (comp str spans) (remove (set (keys heads)) (range n))))}))

(defn- timed [f]
  (let [t (System/nanoTime)
        r (f)]
    [r (/ (- (System/nanoTime) t) 1e6)]))

(defn- evict-pool!
  "Close the pool's idle connections, so every later one loads the
  statistics as they are now, as after a restart."
  []
  (.softEvictConnections (.getHikariPoolMXBean db)))

(defn- tiny-statistics!
  "Statistics gathered while the database held three spans and one relation,
  as on a new install analysed before its first import."
  []
  (let [p (h/create-test-project admin-request "Tiny")
        d (h/create-test-document admin-request p "d")
        tl (id (h/create-text-layer admin-request p "T"))
        wl (id (h/create-token-layer admin-request tl "W"))
        sl (id (h/create-span-layer admin-request wl "L"))
        rl (id (h/create-relation-layer admin-request sl "R"))
        tx (id (h/create-text admin-request tl d "a b c"))
        toks (ids-of (h/bulk-create-tokens admin-request
                                           (for [i [0 2 4]] {:token-layer-id wl :text tx :begin i :end (inc i)})))
        sps (ids-of (h/bulk-create-spans admin-request
                                         (for [t toks] {:span-layer-id sl :tokens [t] :value "x"})))]
    (ids-of (h/bulk-create-relations admin-request
                                     [{:relation-layer-id rl :source (first sps) :target (second sps) :value "x"}]))
    (psc/execute! db ["ANALYZE"])
    (evict-pool!)))

(defn- check-treebank!
  "Every `related*` shape over the treebank, exact and in time. The closure
  is planned the same on any statistics, and so is every query whose only
  starting point is the closure or an id it is pinned to. A Grew query that
  also narrows a node by its UPOS, or whose `without` holds the closure,
  starts from the narrowing clauses as SQLite plans them, like any query
  without `related*`: `narrowed?` adds those, timed on statistics of the data."
  [narrowed? {:keys [pid words sentences upos pos dep expected leaves roots toks verb? ancestors]}]
  (let [q (fn [body] (timed #(qe/run db "admin@example.com" (merge {"scope" {"project-ids" [pid]}} body))))
        pairs (fn [r] (set (map (fn [row] (mapv str row)) (:results r))))
        firsts (fn [r] (set (map (comp str first) (:results r))))]
    (testing "every ancestor and descendant, once"
      (let [[r ms] (q {"find" ["?a" "?b"]
                       "where" [["span" "?a" {"layer" pos}]
                                ["span" "?b" {"layer" pos}]
                                ["related*" "?a" "?b" {"layer" dep}]]
                       "limit" 100000})]
        (is (= (count expected) (count (:results r))))
        (is (= expected (pairs r)))
        (is (< ms 5000) (str ms " ms"))))
    (testing "under a not, the spans that reach nothing"
      (let [[r ms] (q {"find" ["?a"]
                       "where" [["span" "?a" {"layer" pos}]
                                ["not" ["span" "?b" {"layer" pos}]
                                 ["related*" "?a" "?b" {"layer" dep}]]]
                       "limit" 100000})]
        (is (= leaves (firsts r)))
        (is (< ms 5000) (str ms " ms"))))
    (testing "under a not, the spans that nothing reaches"
      (let [[r ms] (q {"find" ["?b"]
                       "where" [["span" "?b" {"layer" pos}]
                                ["not" ["span" "?a" {"layer" pos}]
                                 ["related*" "?a" "?b" {"layer" dep}]]]
                       "limit" 100000})]
        (is (= roots (firsts r)))
        (is (< ms 5000) (str ms " ms"))))
    (testing "from one span, its subtree"
      (let [root (ffirst (sort expected))
            below (set (keep (fn [[a b]] (when (= a root) b)) expected))
            [r ms] (q {"find" ["?b"]
                       "where" [["span" "?a" {"layer" pos}]
                                ["=" "?a.id" root]
                                ["span" "?b" {"layer" pos}]
                                ["related*" "?a" "?b" {"layer" dep}]]})]
        (is (seq below))
        (is (= below (firsts r)))
        (is (< ms 2000) (str ms " ms"))))
    (testing "the words of every pair, through the spans that cover them"
      (let [[r ms] (q {"find" ["?a" "?b"]
                       "where" [["span" "?a" {"layer" pos}]
                                ["span" "?b" {"layer" pos}]
                                ["token" "?ta" {"layer" words}]
                                ["token" "?tb" {"layer" words}]
                                ["covers" "?a" "?ta"]
                                ["covers" "?b" "?tb"]
                                ["related*" "?a" "?b" {"layer" dep}]]
                       "limit" 100000})]
        (is (= expected (pairs r)))
        (is (< ms 5000) (str ms " ms"))))
    ;; the clauses ud's Grew search compiles a node to: its word in the
    ;; sentence ?S, and its POS span (here the layer the tree is on)
    (let [n (count toks)
          node (fn [x] [["token" (str "?n_" x) {"layer" words}] ["within" (str "?n_" x) "?S"]
                        ["span" (str "?lem_" x) {"layer" pos}] ["covers" (str "?lem_" x) (str "?n_" x)]])
          upos= (fn [x v] [["span" (str "?u_" x) {"layer" upos "value" v}] ["covers" (str "?u_" x) (str "?n_" x)]])
          dom (fn [x y] ["related*" (str "?lem_" x) (str "?lem_" y) {"layer" dep}])
          sent ["token" "?S" {"layer" sentences}]
          below (fn [i] (set (filter #(contains? (ancestors %) i) (range n))))]
      (testing "Grew X ->> Y"
        (let [[r ms] (q {"find" ["?n_X" "?n_Y"]
                         "where" (concat [sent] (node "X") (node "Y") [(dom "X" "Y") ["!=" "?n_X" "?n_Y"]])
                         "limit" 100000})]
          (is (= (set (for [d (range n) a (ancestors d)] [(toks a) (toks d)])) (pairs r)))
          (is (< ms 5000) (str ms " ms"))))
      (when narrowed?
        (testing "Grew Y [upos=NOUN] without { X ->> Y }"
          (let [[r ms] (q {"find" ["?n_Y"]
                           "where" (concat [sent ["token" "?n_Y" {"layer" words}] ["within" "?n_Y" "?S"]]
                                           (upos= "Y" "NOUN")
                                           [(into ["not"] (concat (node "X") [["span" "?lem_Y" {"layer" pos}]
                                                                              ["covers" "?lem_Y" "?n_Y"]
                                                                              (dom "X" "Y")]))])
                           "limit" 100000})]
            (is (= (set (for [i (range n) :when (and (not (verb? i)) (empty? (ancestors i)))] (toks i)))
                   (firsts r)))
            (is (< ms 5000) (str ms " ms"))))
        (testing "Grew X [upos=VERB] without { X ->> Y; Y [upos=NOUN] }"
          (let [[r ms] (q {"find" ["?n_X"]
                           "where" (concat [sent ["token" "?n_X" {"layer" words}] ["within" "?n_X" "?S"]]
                                           (upos= "X" "VERB")
                                           [(into ["not"] (concat [["span" "?lem_X" {"layer" pos}]
                                                                   ["covers" "?lem_X" "?n_X"]]
                                                                  (node "Y") (upos= "Y" "NOUN") [(dom "X" "Y")]))])
                           "limit" 100000})]
            (is (= (set (for [i (range n) :when (and (verb? i) (not-any? (complement verb?) (below i)))] (toks i)))
                   (firsts r)))
            (is (< ms 5000) (str ms " ms"))))
        (testing "Grew X [upos=VERB]; X ->> Y; Y ->> Z"
          (let [[r ms] (q {"find" ["?n_X" "?n_Z"]
                           "where" (concat [sent] (node "X") (upos= "X" "VERB") (node "Y") (node "Z")
                                           [(dom "X" "Y") (dom "Y" "Z")])
                           "limit" 100000})]
            (is (= (set (for [z (range n) y (ancestors z) x (ancestors y) :when (verb? x)] [(toks x) (toks z)]))
                   (pairs r)))
            (is (< ms 5000) (str ms " ms"))))))
    (testing "a count of the pairs"
      (let [[r ms] (q {"where" [["span" "?a" {"layer" pos}]
                                ["span" "?b" {"layer" pos}]
                                ["related*" "?a" "?b" {"layer" dep}]]
                       "return" {"group" [] "aggregates" [["count"]]}})]
        (is (= [[(count expected)]] (:results r)))
        (is (< ms 5000) (str ms " ms"))))))

(deftest related-star-over-a-treebank
  (check-treebank! false (build!)))

(deftest related-star-on-statistics-of-the-treebank
  (let [tb (build!)]
    (psc/execute! db ["ANALYZE"])
    (evict-pool!)
    (check-treebank! true tb)))

(deftest related-star-on-statistics-of-a-near-empty-database
  (tiny-statistics!)
  (let [tb (build!)]
    (is (= "3 1" (:stat (psc/q1 db ["SELECT stat FROM sqlite_stat1 WHERE idx = 'sqlite_autoindex_spans_1'"])))
        "the statistics still say three spans")
    (check-treebank! false tb)))
