(ns plaid.sql.query.exec-reference-test
  "A seeded differential test: random queries from a small grammar, answered by
  the engine and by a brute-force reference over the same data.

  Distilled from the PROP hunter's fuzzer (2026-09-26). The grammar covers
  what scoping and value typing touch: span variables with a layer id, no
  layer, or a layer variable, value literals of every JSON scalar type, value
  variables shared between span values and token offsets, covers, precedes,
  !=, and a negated clause. A second project holds the same shapes and
  values and is out of scope, as a scope limit for an admin and by
  membership for a reader, so a match from it is a leak."
  (:require [clojure.data.json :as json]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [r] (str (-> r :body :id)))

(def ^:private value-pool ["N" "V" "3" 3 true 1 0 false])

(defn- build-project!
  "One document, four words at 0, 3, 6 and 9, a `pos` span on each word and a
  `feat` span on some, with values drawn from `value-pool` by `rng`. Returns
  the model the reference reads."
  [^java.util.Random rng pname]
  (let [pid (h/create-test-project admin-request pname)
        tl (id (h/create-text-layer admin-request pid "text"))
        w (id (h/create-token-layer admin-request tl "w"))
        pos (id (h/create-span-layer admin-request w "pos"))
        feat (id (h/create-span-layer admin-request w "feat"))
        doc (h/create-test-document admin-request pid "d")
        text (id (h/create-text admin-request tl doc "ab cd ef gh"))
        pick #(nth value-pool (.nextInt rng (count value-pool)))
        tokens (vec (for [b [0 3 6 9]]
                      {:id (id (h/create-token admin-request w text b (+ b 2))) :begin b}))
        spans (vec (concat
                    (for [t tokens]
                      (let [v (pick)]
                        {:id (id (h/create-span admin-request pos [(:id t)] v)) :layer pos :value v :token (:id t)}))
                    (for [t tokens :when (.nextBoolean rng)]
                      (let [v (pick)]
                        {:id (id (h/create-span admin-request feat [(:id t)] v)) :layer feat :value v :token (:id t)}))))]
    {:pid pid :pos pos :feat feat :tokens tokens :spans spans}))

;; ---------------------------------------------------------------------------
;; Query generation
;; ---------------------------------------------------------------------------

(defn- gen-query
  "A random query and the spec the reference evaluates it from."
  [^java.util.Random rng {:keys [pos feat]}]
  (let [pick (fn [xs] (nth xs (.nextInt rng (count xs))))
        span-spec (fn [] {:layer (pick [:pos :feat :none :var]) :value (pick [:none :lit :var])
                          :lit (pick value-pool)})
        two? (.nextBoolean rng)
        s0 (span-spec)
        s1 (when two? (span-spec))
        t0 {:begin (pick [:none :none :var :lit]) :lit (pick [0 3 6 9])}
        t1? (and two? (.nextBoolean rng))
        precedes? (and t1? (.nextBoolean rng))
        neq? (and two? (.nextBoolean rng))
        neg (when (zero? (.nextInt rng 3)) (pick value-pool))
        spec {:s0 s0 :s1 s1 :t0 t0 :t1? t1? :precedes? precedes? :neq? neq? :neg neg}
        span-clause (fn [v {:keys [layer value lit]}]
                      ["span" v (cond-> {}
                                  (= layer :pos) (assoc "layer" pos)
                                  (= layer :feat) (assoc "layer" feat)
                                  (= layer :var) (assoc "layer" "?L")
                                  (= value :lit) (assoc "value" lit)
                                  (= value :var) (assoc "value" {"var" "?v"}))])
        uses-L? (some #(= :var (:layer %)) (remove nil? [s0 s1]))
        where (cond-> [(span-clause "?s0" s0)
                       ["token" "?t0" (case (:begin t0)
                                        :none {}
                                        :var {"begin" {"var" "?v"}}
                                        :lit {"begin" (:lit t0)})]
                       ["covers" "?s0" "?t0"]]
                uses-L? (conj ["span-layer" "?L" {"name" "pos"}])
                s1 (conj (span-clause "?s1" s1))
                t1? (conj ["token" "?t1" {}] ["covers" "?s1" "?t1"])
                precedes? (conj ["precedes" "?t0" "?t1"])
                neq? (conj ["!=" "?s0" "?s1"])
                neg (conj ["not" ["span" "?n" {"layer" feat "value" neg}] ["covers" "?n" "?t0"]]))
        find (cond-> ["?s0" "?t0"] s1 (conj "?s1") t1? (conj "?t1"))]
    {:spec spec :query {"find" find "where" where}}))

;; ---------------------------------------------------------------------------
;; The reference
;; ---------------------------------------------------------------------------

(defn- stored= [a b] (= (json/write-str a) (json/write-str b)))

(defn- join-key
  "What a value variable compares: one class for strings, one for numbers,
  and a boolean reads as the number 1 or 0."
  [x]
  (cond (true? x) [:num 1] (false? x) [:num 0] (number? x) [:num x] :else [:str x]))

(defn- reference
  [{:keys [pos feat tokens spans]} {:keys [s0 s1 t0 t1? precedes? neq? neg]}]
  (let [layer-ok (fn [{:keys [layer]} s]
                   (case layer :pos (= pos (:layer s)) :feat (= feat (:layer s)) :none true
                         ;; a layer variable named pos: the in-scope pos layer only
                         :var (= pos (:layer s))))
        span-ok (fn [spec s] (and (layer-ok spec s)
                                  (or (not= :lit (:value spec)) (stored= (:lit spec) (:value s)))))
        covers? (fn [s t] (= (:token s) (:id t)))
        next-token (fn [t] (first (filter #(> (:begin %) (:begin t)) (sort-by :begin tokens))))
        ;; every value the variable ?v is bound to in this match, as join keys
        bound-vs (fn [a0 b0 a1]
                   (cond-> []
                     (= :var (:value s0)) (conj (join-key (:value a0)))
                     (= :var (:begin t0)) (conj (join-key (:begin b0)))
                     (and s1 (= :var (:value s1))) (conj (join-key (:value a1)))))]
    (set
     (for [a0 spans :when (span-ok s0 a0)
           b0 tokens :when (covers? a0 b0)
           :when (case (:begin t0) :lit (= (:lit t0) (:begin b0)) true)
           :when (not (and neg (some #(and (= feat (:layer %)) (stored= neg (:value %)) (covers? % b0)) spans)))
           a1 (if s1 (filter #(span-ok s1 %) spans) [nil])
           :when (not (and neq? (= (:id a0) (:id a1))))
           b1 (if t1? (filter #(covers? a1 %) tokens) [nil])
           :when (or (not precedes?) (= (:id b1) (:id (next-token b0))))
           :when (let [vs (bound-vs a0 b0 a1)] (or (empty? vs) (apply = vs)))]
       (cond-> [(:id a0) (:id b0)] s1 (conj (:id a1)) t1? (conj (:id b1)))))))

(defn- check-seed!
  "Build the two projects from `seed` and compare 60 random queries. Each seed
  runs in its own test, on a clean database, so the reader sees one project."
  [seed]
  (let [rng (java.util.Random. seed)
        in-scope (build-project! rng (str "Ref A" seed))
        _out-of-scope (build-project! (java.util.Random. (+ 100 seed)) (str "Ref B" seed))
        _ (h/add-project-reader admin-request (:pid in-scope) "user1@example.com")]
    (dotimes [n 60]
      (let [{:keys [spec query]} (gen-query rng in-scope)
            ;; even: an admin scoped to the project; odd: a reader of it alone
            [user q] (if (even? n)
                       ["admin@example.com" (assoc query "scope" {"project-ids" [(:pid in-scope)]})]
                       ["user1@example.com" query])
            engine (set (map #(mapv str %) (:results (qe/run db user q))))
            expected (reference in-scope spec)]
        (testing (str "seed " seed " query " n " " (json/write-str q))
          (is (= expected engine)))))))

(deftest engine-agrees-with-the-reference-seed-1 (check-seed! 1))
(deftest engine-agrees-with-the-reference-seed-2 (check-seed! 2))
(deftest engine-agrees-with-the-reference-seed-3 (check-seed! 3))
