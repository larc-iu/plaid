(ns plaid.sql.query.distinct-elision-property-test
  "A differential test of `plaid.sql.query.compile/distinct-redundant?`: over
  random documents and random query shapes, an aggregate answers exactly what it
  answers when the compiler keeps its SELECT DISTINCT on every shape. The data
  has what makes a junction repeat a match: an entry linked twice to one token by
  two links, multi-word links over two or three tokens that overlap, spans over
  one or two tokens, and links in two token layers."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h]
            [plaid.sql.common :as psc]
            [plaid.query.ast :as ast]
            [plaid.sql.query.compile :as qc]
            [plaid.sql.query.resolve :as qr]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [r] (-> r :body :id))

(defn- pick [^java.util.Random rnd xs] (nth xs (.nextInt rnd (count xs))))

(defn- shuffle-with [^java.util.Random rnd xs]
  (let [al (java.util.ArrayList. ^java.util.Collection (vec xs))]
    (java.util.Collections/shuffle al rnd)
    (vec al)))

(defn- pick-distinct [^java.util.Random rnd xs k]
  (vec (take k (shuffle-with rnd xs))))

(defn- build! [^java.util.Random rnd seed]
  (let [pid   (h/create-test-project admin-request (str "DistinctElision " seed))
        txtl  (id (h/create-text-layer admin-request pid "text"))
        words (id (h/create-token-layer admin-request txtl "words"))
        morphs (id (h/create-token-layer admin-request txtl "morphs" "any"))
        sl    (id (h/create-span-layer admin-request words "pos"))
        vl    (id (h/create-vocab-layer admin-request (str "DistinctElision lexicon " seed)))
        _     (h/link-vocab-to-project admin-request pid vl)
        items (vec (for [i (range 5)] (id (h/create-vocab-item admin-request vl (str "e" i)))))]
    (doseq [i (range 3)]
      (let [d (h/create-test-document admin-request pid (str "d" i))
            n (+ 2 (.nextInt rnd 5))
            tx (id (h/create-text admin-request txtl d (apply str (repeat n "ab "))))
            ws (vec (for [j (range n)]
                      (id (h/create-token admin-request words tx (* 3 j) (+ 2 (* 3 j))))))
            ms (vec (for [j (range n) k (range (inc (.nextInt rnd 2)))]
                      (id (h/create-token admin-request morphs tx (* 3 j) (+ 2 (* 3 j)) k))))]
        (doseq [w ws]
          (dotimes [_ (.nextInt rnd 3)]
            (h/create-span admin-request sl [w] (pick rnd ["N" "V" 7])))
          (when (and (> n 1) (.nextBoolean rnd))
            (h/create-span admin-request sl (pick-distinct rnd ws 2) "X")))
        ;; Links, several per token: the same entry twice on one token by two
        ;; links, and multi-word links that overlap.
        (dotimes [_ (+ 2 (.nextInt rnd 8))]
          (let [layer (if (.nextBoolean rnd) ws ms)
                k (min (count layer) (inc (.nextInt rnd 3)))]
            (h/create-vocab-link admin-request (pick rnd items) (pick-distinct rnd layer k))))))
    {:words words :morphs morphs :pos sl :vocab vl}))

(defn- shapes [{:keys [pos vocab]}]
  (let [v   ["vocab" "?v" {"layer" (str vocab)}]
        lnk [["link" "?l" {"item" "?v"}] ["link-token" "?l" "?t"]]]
    {"igt's Entries count"
     {"where" [v ["vocab-link" "?t" "?v"] ["token" "?t" {"layer" "?tl"}] ["token-layer" "?tl" {}]]
      "return" {"group" ["?v" "?tl"] "aggregates" [["count"]]}}
     "named, per entry and layer"
     {"where" (into [v] (concat lnk [["token" "?t" {"layer" "?tl"}] ["token-layer" "?tl" {}]]))
      "return" {"group" ["?v" "?tl"] "aggregates" [["count"]]}}
     "the shorthand twice"
     {"where" [v ["vocab" "?v2" {"layer" (str vocab)}] ["vocab-link" "?t" "?v"] ["vocab-link" "?t" "?v2"]]
      "return" {"group" ["?v" "?v2"] "aggregates" [["count"]]}}
     "the shorthand beside spans"
     {"where" [v ["vocab-link" "?t" "?v"] ["span" "?s" {"layer" (str pos)}] ["covers" "?s" "?t"]]
      "return" {"group" ["?v"] "aggregates" [["count"]]}}
     "one overall count"
     {"where" (into [v] lnk) "return" {"group" [] "aggregates" [["count"]]}}
     "per link"
     {"where" (into [v] lnk) "return" {"group" ["?l"] "aggregates" [["count"]]}}
     "fan-out through spans"
     {"where" (into [v] (concat lnk [["span" "?s" {"layer" (str pos)}] ["covers" "?s" "?t"]]))
      "return" {"group" ["?v"] "aggregates" [["count"]]}}
     "two tokens of one link"
     {"where" [v ["link" "?l" {"item" "?v"}] ["link-token" "?l" "?t1"] ["link-token" "?l" "?t2"]]
      "return" {"group" ["?v"] "aggregates" [["count"]]}}
     "one token twice through the junction"
     {"where" [v ["link" "?l" {"item" "?v"}] ["link-token" "?l" "?t"] ["link-token" "?l" "?t"]]
      "return" {"group" ["?v"] "aggregates" [["count"]]}}
     "named beside the shorthand"
     {"where" (into [v ["vocab-link" "?t" "?v2"]] lnk)
      "return" {"group" ["?v2"] "aggregates" [["count"]]}}
     "the shorthand alone"
     {"where" [v ["vocab-link" "?t" "?v"]]
      "return" {"group" ["?v"] "aggregates" [["count"]]}}
     "an or whose branches name the link or not"
     {"where" [v ["token" "?t" {}]
               ["or" lnk [["vocab-link" "?t" "?v"]]]]
      "return" {"group" ["?v"] "aggregates" [["count"]]}}
     "an or both of whose branches name the link"
     {"where" [v ["token" "?t" {}]
               ["or" lnk [["link" "?l" {"item" "?v"}] ["link-token" "?l" "?t"]
                          ["span" "?s" {"layer" (str pos)}] ["covers" "?s" "?t"]]]]
      "return" {"group" ["?v"] "aggregates" [["count"]]}}
     "a not over the spans"
     {"where" (into [v] (concat lnk [["not" ["span" "?s" {"layer" (str pos)}] ["covers" "?s" "?t"]]]))
      "return" {"group" ["?v"] "aggregates" [["count"]]}}
     "a sum over begin"
     {"where" (into [v] (concat lnk [["token" "?t" {"begin" {"var" "?b"} "doc" {"var" "?d"}}]]))
      "return" {"group" ["?d"] "aggregates" [["count"] ["sum" "?b"]]}}
     "a surface form group key"
     {"where" (into [v] (concat lnk [["token" "?t" {}]]))
      "return" {"group" ["?v" "?t.value"] "aggregates" [["count"]]}}}))

(defn- compiled [body]
  (qc/compile-query (qr/resolve-query db "admin@example.com" (first (ast/expand body)))))

(defn- elided? [body]
  (contains? (compiled body) :select))

(defn- run-sorted [body]
  (sort-by pr-str (map #(mapv str %) (:results (qe/run db "admin@example.com" body)))))

(defn- run-kept [body]
  (with-redefs [qc/distinct-redundant? (fn [& _] false)]
    (run-sorted body)))

(deftest the-elision-never-changes-an-answer
  (doseq [seed (range 6)]
    (let [rnd (java.util.Random. seed)
          ctx (build! rnd seed)]
      (doseq [[label body] (shapes ctx)]
        (testing (str "seed " seed ", " label)
          (is (= (run-kept body) (run-sorted body))))))))

(deftest the-shapes-that-elide
  (let [ctx (build! (java.util.Random. 42) 42)
        elides #{"igt's Entries count" "named, per entry and layer" "one overall count" "per link"
                 "two tokens of one link" "one token twice through the junction" "a sum over begin"
                 "a not over the spans" "an or both of whose branches name the link"
                 "named beside the shorthand" "the shorthand alone" "the shorthand twice"}
        s (shapes ctx)]
    (doseq [[label body] s]
      (testing label
        (is (= (contains? elides label) (elided? body)))))))

(deftest the-test-sees-a-repeated-junction-row
  ;; What the elision rests on: a link names a token once. A row written past
  ;; that rule (never by a write path) makes the two answers differ, so the
  ;; differential above would see a shape that repeats a match.
  (let [ctx (build! (java.util.Random. 7) 7)
        body (get (shapes ctx) "named, per entry and layer")
        {:keys [vocab_link_id token_id]} (first (psc/q db {:select [:vocab_link_id :token_id]
                                                           :from [:vocab_link_tokens]
                                                           :limit 1}))]
    (psc/execute! db {:insert-into :vocab_link_tokens
                      :values [{:vocab_link_id vocab_link_id :token_id token_id :order_idx 99}]})
    (is (not= (run-kept body) (run-sorted body)))))

(defn- twice-linked!
  "An entry \"aa bb\" with a multi-word link over aa and bb, and a second link
  of the same entry on aa alone. Returns the vocab layer id."
  []
  (let [pid  (h/create-test-project admin-request "TwiceLinked")
        txtl (id (h/create-text-layer admin-request pid "text"))
        words (id (h/create-token-layer admin-request txtl "words"))
        doc  (h/create-test-document admin-request pid "d1")
        tx   (id (h/create-text admin-request txtl doc "aa bb"))
        t0   (id (h/create-token admin-request words tx 0 2))
        t1   (id (h/create-token admin-request words tx 3 5))
        vl   (id (h/create-vocab-layer admin-request "TwiceLinked lexicon"))
        _    (h/link-vocab-to-project admin-request pid vl)
        e    (id (h/create-vocab-item admin-request vl "aa bb"))]
    (h/create-vocab-link admin-request e [t0 t1])
    (h/create-vocab-link admin-request e [t0])
    vl))

(deftest the-test-sees-a-shorthand-without-its-guard
  ;; The shorthand drops its DISTINCT only behind first-link-only. Without the
  ;; guard an entry that reaches a word through two links counts it twice, and
  ;; the differential sees it.
  (let [vl (twice-linked!)
        body (get (shapes {:vocab vl :pos nil}) "igt's Entries count")]
    (is (elided? body))
    (is (= (run-kept body) (run-sorted body)))
    (with-redefs [qc/first-link-only (fn [& _] nil)]
      (is (not= (run-kept body) (run-sorted body))))))

(deftest igts-entries-count-counts-a-word-once-per-entry
  ;; perf-entry-link-counts (a): today's counts. The Entries screen's shorthand
  ;; counts an entry and a word once, however many of the entry's links name
  ;; the word, and it does so without the DISTINCT. A named link counts each
  ;; link: 3 here, which is why the Entries screen does not name it.
  (let [vl (twice-linked!)
        entries (get (shapes {:vocab vl :pos nil}) "igt's Entries count")
        count-of (fn [link-clauses]
                   (ffirst (:results (qe/run db "admin@example.com"
                                             {"where" (into [["vocab" "?v" {"layer" (str vl)}]] link-clauses)
                                              "return" {"group" [] "aggregates" [["count"]]}}))))]
    (is (elided? entries))
    (is (= [2] (map last (:results (qe/run db "admin@example.com" entries)))))
    (is (= 2 (count-of [["vocab-link" "?t" "?v"]])))
    (is (= 3 (count-of [["link" "?l" {"item" "?v"}] ["link-token" "?l" "?t"]])))))

