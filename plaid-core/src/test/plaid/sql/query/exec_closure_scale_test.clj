(ns plaid.sql.query.exec-closure-scale-test
  "`related*` over every pair of a 4,000-word treebank answers in time and
  exactly (H6-CORE-API-2). A recursive CTE correlated on both ends ran once per
  candidate pair: 16.5 s on 2,000 words and a 408 on 4,000. Now 0.1 s."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin
                                    db admin-request assert-created]]
            [plaid.test-helpers :as h]
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
  sentence, every head earlier in the sentence than its dependent. Returns the
  layers and the expected (ancestor, descendant) pairs."
  []
  (let [rnd (java.util.Random. 7)
        pid (h/create-test-project admin-request "Treebank")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
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
    {:pid pid :pos pos :dep dep :expected expected
     :leaves (set (map (comp str spans) (remove (set (vals heads)) (range n))))}))

(defn- timed [f]
  (let [t (System/nanoTime)
        r (f)]
    [r (/ (- (System/nanoTime) t) 1e6)]))

(deftest related-star-over-a-treebank
  (let [{:keys [pid pos dep expected leaves]} (build!)
        [r ms] (timed #(qe/run db "admin@example.com"
                               {"find" ["?a" "?b"]
                                "where" [["span" "?a" {"layer" pos}]
                                         ["span" "?b" {"layer" pos}]
                                         ["related*" "?a" "?b" {"layer" dep}]]
                                "scope" {"project-ids" [pid]}
                                "limit" 100000}))]
    (testing "every ancestor and descendant, once"
      (is (= (count expected) (count (:results r))))
      (is (= expected (set (map (fn [[a b]] [(str a) (str b)]) (:results r))))))
    (testing "in time"
      (is (< ms 5000) (str ms " ms")))
    (testing "under a not, the spans that reach nothing"
      (let [[r ms] (timed #(qe/run db "admin@example.com"
                                   {"find" ["?a"]
                                    "where" [["span" "?a" {"layer" pos}]
                                             ["not" ["span" "?b" {"layer" pos}]
                                              ["related*" "?a" "?b" {"layer" dep}]]]
                                    "scope" {"project-ids" [pid]}
                                    "limit" 100000}))]
        (is (= leaves (set (map (comp str first) (:results r)))))
        ;; 4.6 s on larc: the planner probes the pairs once per span pair.
        ;; Before, the same query passed the 30 s limit.
        (is (< ms 15000) (str ms " ms"))))
    (testing "from one span, its subtree"
      (let [root (ffirst (sort (filter (fn [[a _]] (= a (ffirst (sort expected)))) expected)))
            below (set (keep (fn [[a b]] (when (= a root) b)) expected))
            [r ms] (timed #(qe/run db "admin@example.com"
                                   {"find" ["?b"]
                                    "where" [["span" "?a" {"layer" pos}]
                                             ["=" "?a.id" root]
                                             ["span" "?b" {"layer" pos}]
                                             ["related*" "?a" "?b" {"layer" dep}]]
                                    "scope" {"project-ids" [pid]}}))]
        (is (seq below))
        (is (= below (set (map (comp str first) (:results r)))))
        (is (< ms 2000) (str ms " ms"))))))
