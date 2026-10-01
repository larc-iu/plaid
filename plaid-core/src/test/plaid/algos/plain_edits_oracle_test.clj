(ns plaid.algos.plain-edits-oracle-test
  "A seeded property test of the plain edit rule (layers declaring
  `plainEdits`, igt's): documents of sentences (a partition), words (some
  holding spaces, as FLEx phrases do), morphemes over the whole of their
  word (as igt stores them) and time-alignment segments over runs of words,
  all but the sentences plain. Each case is one to four changes made at
  once anywhere in the text (typing, deleting, typing over, pasting text
  with spaces, over a word's inside, its edge, the space between words or
  several words), read as the ops a client sends (composed, and keystroke
  by keystroke in either order of the carets), and as a whole-body save.

  The judge, for each token of a plain layer, against the change as the
  server takes it (the composed gaps, or for a whole body the gaps its
  diff gives):
  - a token (a word, a morpheme, a segment, a sentence, a token of a layer
    nested under the words) is deleted only when none of its old text is
    left and no new text was typed inside it (a token typed over whole is
    kept),
  - a token left keeps all of its old letters that are left, and holds none
    of the old text outside it (so no word takes the space before it or
    another word's letters),
  - it neither begins nor ends on whitespace it did not have there,
  - a new letter joined to a word's letters with no whitespace between is
    in a word, unless it was typed over exactly a sentence's or a segment's
    text, which keeps it, and a new letter in a word is inside the word, joined to its
    letters, or typed over it,
  - a word's morphemes keep its extent, go with it, and are never moved
    onto another word,
  - a word inside a segment stays inside it, and every word stays inside
    one sentence after the partition's gap-fill.
  There are no exemptions."
  (:require [clojure.test :refer [deftest is testing]]
            [plaid.algos.text :as ta]
            [plaid.util.codepoint :as cp]))

;; ---------------------------------------------------------------- documents

(def ^:private vocab
  ["the" "cat" "sat" "on" "a" "mat" "kai" "tat" "köye" "dog" "كتاب" "שלום" "𐌰𐌱𐌲" "café" "你好" "cat," "(ab)"])

;; Spaced words from real FLEx projects (lamkang, manipuri).
(def ^:private phrases
  ["talu lei" "pang khuu" "thee da" "thung ki" "ava ngi" "thungbi ngu" "ə́múk   su"])

(def ^:private typed
  ["Q" "XZ" "Ж𐍂" " " "  " "Q R" "Q " " Q" "XZ XZ XZ" "\n" "Q\nR" "ǃ" "," "-"])

(defn- cps [^String s] (.toArray (.codePoints s)))

(defn- gen-doc
  "{:body :tokens :words} for a random document."
  [^java.util.Random rng opts]
  (let [pick #(nth % (.nextInt rng (count %)))
        sb (StringBuilder.)
        pos (volatile! 0)
        add (fn [^String s] (.append sb s) (vswap! pos + (cp/cp-count s)))
        toks (transient [])
        nsent (inc (.nextInt rng 3))
        wid (volatile! 0)
        ;; where the next sentence begins: after the whitespace between two
        ;; sentences, or (`:bound-early`) before it
        nstart (volatile! 0)
        ;; whitespace the text begins with (`:lead`), in the first sentence
        _ (when-let [l (:lead opts)] (when (< (.nextDouble rng) 0.5) (add l)))]
    (dotimes [si nsent]
      (let [sb0 @nstart
            n (+ 1 (.nextInt rng 5))
            words (vec (for [i (range n)]
                         (let [w (if (< (.nextDouble rng) (:spaced opts 0.3)) (pick phrases) (pick vocab))
                               b @pos]
                           (add w)
                           (let [e @pos id (vswap! wid inc)]
                             (conj! toks {:token/id [:w id] :token/layer :w :token/begin b :token/end e})
                             (dotimes [m (inc (.nextInt rng 3))]
                               (conj! toks {:token/id [:m id m] :token/layer :m :token/begin b :token/end e}))
                             ;; another app's layer nested under the words
                             ;; (a ud syntactic word): plain because its parent is
                             (when (and (:child opts) (< (.nextDouble rng) (:child opts)))
                               (conj! toks {:token/id [:x id] :token/layer :x :token/begin b :token/end e}))
                             (when (< i (dec n))
                               ;; words written together, as after the space
                               ;; between them was deleted
                               (add (if (and (:glue opts) (< (.nextDouble rng) (:glue opts)))
                                      ""
                                      (pick [" " " " " " "  " "\t"]))))
                             [b e]))))]
        ;; another app's nodes beside the words (a layer with overlap
        ;; allowed and no parent, as UMR's): over one word, over a run of
        ;; words, over the whole sentence, overlapping each other
        (when (:nodes opts)
          (dotimes [i n]
            (when (< (.nextDouble rng) 0.5)
              (conj! toks {:token/id [:u si i] :token/layer :u :token/begin (first (words i)) :token/end (second (words i))}))
            (when (and (< (inc i) n) (< (.nextDouble rng) 0.3))
              (let [j (min n (+ i 2 (.nextInt rng 2)))]
                (conj! toks {:token/id [:un si i j] :token/layer :u
                             :token/begin (first (words i)) :token/end (second (words (dec j)))}))))
          (when (< (.nextDouble rng) 0.3)
            (conj! toks {:token/id [:us si] :token/layer :u :token/begin (first (words 0)) :token/end (second (peek words))})))
        ;; segments over runs of words
        (let [segs (loop [i 0 segs []]
                     (if (< i n)
                       (let [j (min n (+ i 1 (.nextInt rng 3)))
                             seg (when (< (.nextDouble rng) 0.5)
                                   {:token/id [:a si i] :token/layer :a
                                    :token/begin (first (words i)) :token/end (second (words (dec j)))})]
                         (when seg (conj! toks seg))
                         (recur j (cond-> segs seg (conj seg))))
                       segs))]
          ;; empty segments (legacy time-alignment data) at a word's edge
          ;; outside every segment's inside, so at a segment's end or start
          ;; too
          (when-let [pr (:points opts)]
            (doseq [p (distinct (mapcat identity words))
                    :when (and (< (.nextDouble rng) pr)
                               (not-any? #(< (:token/begin %) p (:token/end %)) segs))]
              (conj! toks {:token/id [:ap si p] :token/layer :a :token/begin p :token/end p}))))
        (let [before @pos]
          (when (< si (dec nsent))
            (add (if (and (:glue opts) (< (.nextDouble rng) (:glue opts)))
                   ""
                   (pick (:sentence-seps opts [" " "\n" ". "])))))
          (let [e (if (and (:bound-early opts) (< (.nextDouble rng) (:bound-early opts))) before @pos)]
            (vreset! nstart e)
            (conj! toks {:token/id [:s si] :token/layer :s :token/begin sb0 :token/end e})
            ;; a time-alignment segment over the whole sentence (a transcript row)
            (when (:sentence-segments opts)
              ;; less the whitespace at the sentence's edges, as a row is
              (conj! toks {:token/id [:as si] :token/layer :ss
                           :token/begin (first (first words)) :token/end (second (peek words))}))))))
    (let [tokens (persistent! toks)
          body (str sb)
          ;; the last sentence ends at the end of the text
          n (cp/cp-count body)]
      {:body body
       :tokens (mapv #(if (= [:s (dec nsent)] (:token/id %))
                        (assoc % :token/end n) %)
                     tokens)})))

(defn- gen-gaps
  "One to `carets` gaps in old-body order, never touching, some anchored at a
  word's edge or at the space beside it."
  [^java.util.Random rng ^String body tokens opts]
  (let [n (cp/cp-count body)
        words (filterv #(= :w (:token/layer %)) tokens)
        pick #(nth % (.nextInt rng (count %)))
        bounds (vec (keep #(when (and (= :s (:token/layer %)) (pos? (:token/begin %))) (:token/begin %)) tokens))
        spot (fn []
               (let [w (pick words)
                     r (if (and (:at-sentences opts) (seq bounds) (.nextBoolean rng)) 9 (.nextInt rng 6))]
                 (case r
                   9 (min n (max 0 (+ (pick bounds) (if (.nextBoolean rng) 0 (dec (.nextInt rng 3))))))
                   0 (:token/begin w)
                   1 (:token/end w)
                   2 (max 0 (dec (:token/begin w)))
                   3 (min n (inc (:token/end w)))
                   (.nextInt rng (inc n)))))
        one (fn []
              (let [a (spot)
                    k (case (.nextInt rng 4)
                        0 0
                        1 (.nextInt rng 3)
                        2 (.nextInt rng 8)
                        (.nextInt rng (max 1 (:reach opts 20))))
                    b (min n (+ a k))
                    v (if (< (.nextDouble rng) 0.3) "" (pick (:typed opts typed)))]
                (when (or (< a b) (seq v))
                  {:start a :end b :value v})))
        want (inc (.nextInt rng (:carets opts 1)))]
    (->> (repeatedly (* 4 want) one)
         (remove nil?)
         (sort-by :start)
         (reduce (fn [out g]
                   (if (and (seq out) (<= (:start g) (inc (:end (peek out)))))
                     out
                     (conj out g)))
                 [])
         (take want)
         vec)))

;; ---------------------------------------------------------------- readings

(defn- keystrokes
  "Running ops typing `gaps` a key at a time: Backspace over each old
  letter from the gap's end, then each new letter, the carets taken left
  to right, or right to left."
  [gaps right-to-left?]
  (let [one (fn [shift {:keys [start end value]}]
              (let [i (+ start shift)]
                (concat (for [k (range (- end start))] {:type :delete :index (- (+ i (- end start)) k 1) :value 1})
                        (map-indexed (fn [j c] {:type :insert :index (+ i j) :value (String. (Character/toChars (int c)))})
                                     (seq (cps value))))))]
    (if right-to-left?
      (vec (mapcat #(one 0 %) (reverse gaps)))
      (loop [gaps gaps shift 0 out []]
        (if-let [{:keys [start end value] :as g} (first gaps)]
          (recur (rest gaps) (+ shift (- (cp/cp-count value) (- end start))) (into out (one shift g)))
          out)))))

;; ---------------------------------------------------------------- the judge

(defn- ws? [c] (or (Character/isWhitespace (int c)) (Character/isSpaceChar (int c))))

(defn- gap-fill
  "The sentences as `compensate-partition-layers!` leaves them."
  [sents n]
  (let [sorted (vec (sort-by :token/begin sents))
        k (count sorted)]
    (vec (map-indexed (fn [i t]
                        (cond-> t
                          (zero? i) (assoc :token/begin 0)
                          true (assoc :token/end (if (= i (dec k)) n (max (:token/end t) (:token/begin (sorted (inc i))))))))
                      sorted))))

(defn- trim-ws [^ints cs [b e]]
  (let [b (loop [x b] (if (and (< x e) (ws? (aget cs x))) (recur (inc x)) x))
        e (loop [x e] (if (and (> x b) (ws? (aget cs (dec x)))) (recur (dec x)) x))]
    [b e]))

(defn- problems
  "What is wrong with `result` for `tokens` of `old` and the change `gaps`."
  [^String old tokens gaps {:keys [text] :as result}]
  (let [o (cps old)
        new-body (:text/body text)
        nw (cps new-body)
        expected (ta/edit-ops-body (ta/gap-ops gaps) old)
        in-gap (let [a (boolean-array (alength o))]
                 (doseq [{:keys [start end]} gaps, i (range start end)] (aset a i true))
                 a)
        ;; old position -> new position, for old text left, and back
        newpos (let [m (int-array (alength o) -1)]
                 (loop [i 0 gaps (seq gaps) shift 0]
                   (let [{:keys [start end value] :as g} (first gaps)]
                     (cond
                       (and g (= start end) (<= start i))
                       (recur i (next gaps) (+ shift (cp/cp-count value)))
                       (and g (< start end) (<= end i))
                       (recur i (next gaps) (+ shift (- (cp/cp-count value) (- end start))))
                       (< i (alength o))
                       (do (when-not (aget in-gap i) (aset m i (+ i shift)))
                           (recur (inc i) gaps shift)))))
                 m)
        oldpos (let [m (int-array (alength nw) -1)]
                 (dotimes [i (alength o)] (when (>= (aget newpos i) 0) (aset m (aget newpos i) i)))
                 m)
        inserted (let [a (boolean-array (alength nw))]
                   (dotimes [p (alength nw)] (aset a p (neg? (aget oldpos p))))
                   a)
        ;; where each gap's new text starts
        gap-new (loop [gaps gaps shift 0 out {}]
                  (if-let [{:keys [start end value] :as g} (first gaps)]
                    (recur (rest gaps) (+ shift (- (cp/cp-count value) (- end start))) (assoc out g (+ start shift)))
                    out))
        by-id (into {} (map (juxt :token/id identity)) (:tokens result))
        gone (set (:deleted result))
        plain #{:w :m :a :x :s :u}
        ;; the layer whose tokens are the words: UMR's nodes on a text with no
        ;; plain words
        wl (if (some #(= :w (:token/layer %)) tokens) :w :u)
        out (transient [])
        bad! (fn [& xs] (conj! out (apply str xs)))
        kept-of (fn [{:token/keys [begin end]}] (filterv #(not (aget in-gap %)) (range begin end)))
        ;; the gaps inside a token or reaching its ends from inside
        covering (fn [{:token/keys [begin end]}]
                   (filterv (fn [{a :start b :end}]
                              (or (and (< a b) (<= begin a) (<= b end))
                                  (and (= a b) (< begin a) (< a end))))
                            gaps))
        text-of (fn [{:token/keys [begin end]}] (String. ^ints nw (int begin) (int (- end begin))))]
    (when (not= expected new-body) (bad! "body " (pr-str new-body) " not " (pr-str expected)))
    (when (= expected new-body)
      (doseq [{:token/keys [id layer begin end] :as t} tokens
              :when (and (plain layer) (< begin end)
                         ;; a token over a sentence follows it (REV3)
                         (or (= :s layer) (not (#{:a :ss} layer))
                             (not-any? #(and (= :s (:token/layer %))
                                             (= [begin end] (trim-ws o [(:token/begin %) (:token/end %)])))
                                       tokens)))]
        (let [kept (kept-of t)
              cov (covering t)
              ;; no letter of it left, and none typed inside it
              must-go (and (every? #(ws? (aget o %)) kept)
                           (every? (fn [g] (every? ws? (cps (:value g)))) cov))
              now (by-id id)]
          (cond
            (and must-go (not (gone id))) (bad! id " kept with none of its text")
            ;; a sentence or a segment follows the words: with no letter of
            ;; its own left, text typed at its edge may go to the next word
            ;; and its sentence, so it must stay only when a letter is left or
            ;; it was typed over exactly
            (and (not must-go) (gone id)
                 (or (not (#{:s :a} layer))
                     (some #(not (ws? (aget o %))) kept)
                     (some #(and (= begin (:start %)) (= end (:end %))) cov)))
            (bad! id " deleted though it has text")
            (and now (not (gone id)))
            (let [{nb :token/begin ne :token/end} now]
              (doseq [k kept :let [p (aget newpos k)] :when (not (ws? (aget o k)))]
                (when-not (and (<= nb p) (< p ne)) (bad! id " lost its letter at " k " (" (pr-str (text-of now)) ")")))
              (doseq [p (range nb ne)]
                (when (and (not (aget inserted p))
                           (let [k (aget oldpos p)] (or (< k begin) (>= k end))))
                  (bad! id " took old text outside it at " p " (" (pr-str (text-of now)) ")")))
              (when (and (ws? (aget nw nb)) (not (ws? (aget o begin))))
                (bad! id " begins on whitespace " (pr-str (text-of now))))
              (when (and (ws? (aget nw (dec ne))) (not (ws? (aget o (dec end)))))
                (bad! id " ends on whitespace " (pr-str (text-of now))))
              ;; a new letter in a word is inside it, joined to it, or typed over it
              (when (= layer wl)
                (let [letters (filterv #(not (ws? (aget o %))) kept)
                      hull (when (seq letters) [(aget newpos (first letters)) (inc (aget newpos (peek letters)))])
                      kept-new (set (map #(aget newpos %) kept))]
                  (doseq [p (range nb ne) :when (and (aget inserted p) (not (ws? (aget nw p))))]
                    (let [reach (fn [step]
                                  (loop [q (step p)]
                                    (cond
                                      (or (neg? q) (>= q (alength nw)) (ws? (aget nw q))) false
                                      (aget inserted q) (recur (step q))
                                      :else (contains? kept-new q))))]
                      (when-not (or (and hull (<= (first hull) p) (< p (second hull)))
                                    (reach dec) (reach inc)
                                    (some (fn [g] (let [na (gap-new g)]
                                                    (and (<= na p) (< p (+ na (cp/cp-count (:value g)))))))
                                          cov))
                        (bad! id " took a new letter apart from it at " p " (" (pr-str (text-of now)) ")"))))))))))
      ;; a new letter joined to a word's letters is in a word
      (let [word-at (let [a (boolean-array (alength nw))]
                      (doseq [t (vals by-id) :when (and (= wl (:token/layer t)) (not (gone (:token/id t))))
                              p (range (:token/begin t) (:token/end t))]
                        (aset a p true))
                      a)
            word-letter (let [a (boolean-array (alength nw))]
                          (doseq [t tokens :when (and (= wl (:token/layer t)) (not (gone (:token/id t))))
                                  k (kept-of t)]
                            (aset a (aget newpos k) true))
                          a)]
        ;; reached from a word's letter through new letters only, unless it
        ;; was typed over exactly a token's text (a sentence, a segment),
        ;; which keeps it
        (dotimes [p (alength nw)]
          (when (and (aget inserted p) (not (ws? (aget nw p))) (not (aget word-at p))
                     (not-any? (fn [g] (let [na (gap-new g)]
                                         (and (<= na p) (< p (+ na (cp/cp-count (:value g))))
                                              (some #(and (= (:start g) (:token/begin %)) (= (:end g) (:token/end %))
                                                          (< (:start g) (:end g)))
                                                    tokens))))
                               gaps))
            (let [reach (fn [step]
                          (loop [q (step p)]
                            (cond
                              (or (neg? q) (>= q (alength nw)) (ws? (aget nw q))) false
                              (aget inserted q) (recur (step q))
                              :else (aget word-letter q))))]
              (when (or (reach dec) (reach inc))
                (bad! "new letter at " p " joined to a word is in none " (pr-str new-body)))))))
      ;; morphemes and child tokens with their word
      (doseq [{:token/keys [id layer]} tokens :when (#{:m :x} layer)]
        (let [w [:w (second id)]]
          (cond
            (not= (boolean (gone id)) (boolean (gone w))) (bad! id " and its word part")
            (and (by-id id) (not (gone id))
                 (not= ((juxt :token/begin :token/end) (by-id id)) ((juxt :token/begin :token/end) (by-id w))))
            (bad! id " off its word"))))
      ;; no two tokens of a layer without overlaps overlap, nor two sentences
      (doseq [layer [:w :a :s]]
        (let [ts (sort-by (juxt :token/begin :token/end) (filter #(and (= layer (:token/layer %)) (not (gone (:token/id %))))
                                                                 (:tokens result)))]
          (doseq [[x y] (partition 2 1 ts)]
            (when (> (:token/end x) (:token/begin y))
              (bad! (:token/id x) " overlaps " (:token/id y) " " (pr-str new-body))))))
      ;; words in their segments, and in one sentence after the gap-fill
      (let [live (fn [id] (when-not (gone id) (by-id id)))
            inside? (fn [w s] (and (<= (:token/begin s) (:token/begin w)) (<= (:token/end w) (:token/end s))))
            sents (gap-fill (filterv #(and (= :s (:token/layer %)) (not (gone (:token/id %)))) (:tokens result))
                            (alength nw))]
        (doseq [s tokens :when (= :a (:token/layer s))
                w tokens :when (and (= :w (:token/layer w)) (inside? w s))]
          (when (and (live (:token/id s)) (live (:token/id w))
                     (not (inside? (live (:token/id w)) (live (:token/id s)))))
            (bad! (:token/id w) " left its segment " (:token/id s))))
        (doseq [w tokens :when (= :w (:token/layer w))]
          (when-let [w* (live (:token/id w))]
            (when (and (seq sents) (not-any? #(inside? w* %) sents))
              (bad! (:token/id w) " across sentences"))))))
    (persistent! out)))

;; ---------------------------------------------------------------- the test

(def ^:private configs
  {:one-caret {:carets 1}
   :several-carets {:carets 4}
   :spaced-words {:carets 2 :spaced 0.6}
   :across-words {:carets 2 :reach 40}
   :lamkang-like {:carets 3 :spaced 0.39 :reach 30}
   :written-together {:carets 3 :glue 0.3 :spaced 0.3}
   :nested-layer {:carets 3 :child 0.7 :spaced 0.3 :glue 0.1}
   ;; UMR's nodes beside the words: the words decide, the nodes follow
   :nodes-beside-words {:carets 3 :nodes true :spaced 0.3 :glue 0.1}
   ;; empty time-alignment segments at word and segment edges (REV-r4d: text
   ;; typed at one grew the segment before over it, a 500)
   :empty-segments {:carets 3 :points 0.4 :spaced 0.3 :glue 0.2}})

(def ^:private cases-per-config 1500)

(defn- run [old tokens ops] (ta/plain-edits old tokens ops #{:s} #{:w} {:children #{:m :x} :exclusive #{:a :ss}}))

(deftest a-plain-layer-takes-every-edit-the-plain-way
  (doseq [[cname opts] configs]
    (let [fails (atom [])]
      (dotimes [seed cases-per-config]
        (let [rng (java.util.Random. (+ seed (* 7919 (hash cname))))
              {:keys [body tokens]} (gen-doc rng opts)
              gaps (gen-gaps rng body tokens opts)
              new-body (ta/edit-ops-body (ta/gap-ops gaps) body)
              server (ta/plain-edit-gaps body (ta/gap-ops gaps))
              readings {:composed (ta/gap-ops gaps)
                        :keys-left-to-right (keystrokes gaps false)
                        :keys-right-to-left (keystrokes gaps true)}]
          (doseq [[rname ops] readings]
            (let [r (run body tokens ops)
                  ps (problems body tokens server r)]
              (when (seq ps) (swap! fails conj {:config cname :seed seed :reading rname :old body :gaps gaps :problems (take 3 ps)}))))
          (let [bgaps (ta/plain-body-gaps body new-body tokens #{:s})
                r (ta/plain-body body new-body tokens #{:s} #{:w} {:children #{:m :x} :exclusive #{:a :ss}})
                ps (problems body tokens bgaps r)]
            (when (seq ps) (swap! fails conj {:config cname :seed seed :reading :whole-body :old body :gaps bgaps :problems (take 3 ps)})))))
      (when (System/getenv "PLAIN_ORACLE_DEBUG")
        (println cname (count @fails) (frequencies (map :reading @fails)))
        (doseq [f (take 6 @fails)] (println (pr-str f))))
      (testing (str cname)
        (is (empty? @fails) (pr-str (take 3 @fails)))))))

;; ---------------------------------------------------------------- nodes beside words on the other rules

(defn- mixed
  "What `save-plan` does for plain nodes (:u) beside words (:w) that are not
  plain: the words and sentences by the other rules, the nodes plain, then
  following the words at their edges."
  [old tokens {:keys [ops new]}]
  (let [u (filterv #(= :u (:token/layer %)) tokens)
        plain (if ops
                (ta/plain-edits old u ops #{:s} #{:w})
                (ta/plain-body old new u #{:s} #{:w}))
        rest (if ops
               (ta/apply-edits old tokens ops {:partitioning #{:s} :word-layers #{:w}})
               (-> (ta/diff old new) (ta/slide-to-tokens old tokens #{:s}) (ta/normalize-deletes old tokens)
                   (ta/align-to-words old tokens #{:w}) (ta/pair-replacements old tokens)
                   (ta/fold-whole-words old tokens #{:w}) (ta/apply-text-edits {:text/body old} tokens)
                   (as-> r (ta/keep-edges-off-spaces old tokens r #{:s}))))
        plain (ta/follow-word-edges tokens plain rest #(= :w (:token/layer %)) (into #{} (map :token/id) u))]
    {:body [(:text/body (:text plain)) (:text/body (:text rest))]
     :words (into {} (comp (filter #(= :w (:token/layer %))) (map (juxt :token/id identity))) (:tokens rest))
     :nodes (into {} (map (juxt :token/id identity)) (:tokens plain))
     :deleted-nodes (set (:deleted plain))}))

(defn- follow-problems
  "A node edge that stood at a word's edge stands at that word's edge now,
  whenever the word is left, and a node goes only when all its letters do."
  [tokens expected {:keys [body words nodes deleted-nodes]}]
  (let [ws (filterv #(= :w (:token/layer %)) tokens)
        out (transient [])]
    (when (not= [expected expected] body) (conj! out (str "body " (pr-str body))))
    (doseq [{:token/keys [id layer begin end]} tokens :when (= :u layer)]
      (if-let [n (nodes id)]
        (do
          (doseq [w ws :when (= begin (:token/begin w)) :let [w* (words (:token/id w))] :when w*]
            (when (not= (:token/begin w*) (:token/begin n))
              (conj! out (str id " begins at " (:token/begin n) ", its word " (:token/id w) " at " (:token/begin w*)))))
          (doseq [w ws :when (= end (:token/end w)) :let [w* (words (:token/id w))] :when w*]
            (when (not= (:token/end w*) (:token/end n))
              (conj! out (str id " ends at " (:token/end n) ", its word " (:token/id w) " at " (:token/end w*))))))
        (cond
          (not (deleted-nodes id)) (conj! out (str id " missing"))
          ;; REV2 M3: never deleted while a word it stood over, or in, stays
          (some #(and (words (:token/id %))
                      (or (and (<= begin (:token/begin %)) (<= (:token/end %) end))
                          (and (<= (:token/begin %) begin) (<= end (:token/end %)))))
                ws)
          (conj! out (str id " deleted though its word stays")))))
    (persistent! out)))

(deftest nodes-beside-words-on-the-other-rules-keep-to-the-words
  ;; Luke (2026-09-30, option c): a plain node layer beside words that are
  ;; not plain follows the words' outcome at their edges, whatever the edit.
  (let [opts {:carets 3 :nodes true :spaced 0.3 :glue 0.1}
        fails (atom [])]
    (dotimes [seed cases-per-config]
      (let [rng (java.util.Random. (+ seed 424242))
            {:keys [body tokens]} (gen-doc rng opts)
            gaps (gen-gaps rng body tokens opts)
            tokens (filterv #(#{:w :u :s} (:token/layer %)) tokens)
            new-body (ta/edit-ops-body (ta/gap-ops gaps) body)]
        (doseq [[rname change] {:composed {:ops (ta/gap-ops gaps)}
                                :keys-left-to-right {:ops (keystrokes gaps false)}
                                :whole-body {:new new-body}}]
          (let [ps (follow-problems tokens new-body (mixed body tokens change))]
            (when (seq ps) (swap! fails conj {:seed seed :reading rname :old body :gaps gaps :problems (take 3 ps)}))))))
    (is (empty? @fails) (str (count @fails) " " (pr-str (take 3 @fails))))))

;; ---------------------------------------------------------------- ud: a space splits a word

(defn- ws-runs [^ints cs b e]
  (loop [i b in? false n 0]
    (if (< i e)
      (let [w (ws? (aget cs i))] (recur (inc i) w (if (and w (not in?)) (inc n) n)))
      n)))

(defn- split-problems
  "`split` against `plain`, the same edit without `splitOnSpace`, judged by
  the ruling, not by the algorithm: a word the plain rule gives typed
  whitespace inside is cut only at the runs of whitespace holding typed
  whitespace (REV2 M1), and goes on the part holding the most of its own old
  letters, the first on a tie. A token as long as it goes with it, one
  inside it is cut to that part (or goes when none of it is there), one over
  several words that began or ended with it begins or ends where it does,
  and nothing else differs. `gaps` are the change as the server takes it."
  [^String old tokens gaps plain split]
  (let [o (cps old)
        nw (cps (:text/body (:text plain)))
        ;; old position -> new position, and the typed new positions
        newpos (let [m (int-array (alength o) -1)]
                 (loop [i 0 gs (seq gaps) shift 0]
                   (let [{:keys [start end value] :as g} (first gs)]
                     (cond
                       (and g (= start end) (<= start i)) (recur i (next gs) (+ shift (cp/cp-count value)))
                       (and g (< start end) (<= end i)) (recur i (next gs) (+ shift (- (cp/cp-count value) (- end start))))
                       (< i (alength o)) (do (when-not (and g (<= start i) (< i end)) (aset m i (+ i shift)))
                                             (recur (inc i) gs shift)))))
                 m)
        typed (let [a (boolean-array (alength nw) true)]
                (dotimes [i (alength o)] (when (>= (aget newpos i) 0) (aset a (aget newpos i) false)))
                a)
        p (into {} (map (juxt :token/id identity)) (:tokens plain))
        q (into {} (map (juxt :token/id identity)) (:tokens split))
        sentence-now (into {} (map (juxt :token/id (juxt :token/begin :token/end)))
                           (gap-fill (into (filterv #(= :s (:token/layer %)) (:tokens split))
                                           (map-indexed #(assoc %2 :token/id [::head %1]) (:heads split)))
                                     (alength nw)))
        moved (into {}
                    (keep (fn [{:token/keys [id layer begin end]}]
                            (when-let [t (and (= :w layer) (p id))]
                              (let [pb (:token/begin t) pe (:token/end t)
                                    runs (->> (range pb pe) (partition-by #(ws? (aget nw %)))
                                              (filter #(ws? (aget nw (first %)))))
                                    cuts (filter (fn [r] (some #(aget typed %) r)) runs)]
                                (when (seq cuts)
                                  (let [pieces (map vector (cons pb (map #(inc (last %)) cuts)) (concat (map first cuts) [pe]))
                                        own (set (keep #(let [x (aget newpos %)] (when (and (>= x 0) (not (ws? (aget o %)))) x))
                                                       (range begin end)))
                                        score (fn [[x y]] (count (filter own (range x y))))
                                        best (reduce max (map score pieces))]
                                    [[begin end] (first (filter #(= best (score %)) pieces))]))))))
                    tokens)
        out (transient [])]
    (when (not= (:text split) (:text plain)) (conj! out "body"))
    (doseq [{:token/keys [id layer begin end]} tokens
            :let [t (p id)
                  got (q id)
                  ;; a token over a sentence follows the sentence (REV3)
                  over (when (and t (#{:a :ss} layer))
                         (some #(when (and (= :s (:token/layer %)) (= [begin end] (trim-ws o [(:token/begin %) (:token/end %)])))
                                  (:token/id %))
                               tokens))
                  inside (some (fn [[[wb we] xy]] (when (and (<= wb begin) (<= end we) (not (and (= wb begin) (= we end)))) xy)) moved)
                  want (cond
                         ;; a head made only on one side moves the first sentence
                         (and (= :s layer) (not= (:heads plain) (:heads split))) got
                         ;; and a token typed over with the line: one side
                         ;; begins it before the line's end, the other after
                         (and t got (not= (:heads plain) (:heads split))
                              (let [he (:token/end (first (or (:heads plain) (:heads split))))]
                                (not= (< (:token/begin got) he) (< (:token/begin t) he))))
                         got
                         (or (nil? t) (= :s layer)) t
                         over (let [[b e] (trim-ws nw (sentence-now over))] (assoc t :token/begin b :token/end e))
                         (moved [begin end]) (let [[x y] (moved [begin end])] (assoc t :token/begin x :token/end y))
                         inside (let [[x y] inside
                                      b (max x (:token/begin t)) e (min y (:token/end t))]
                                  (when (< b e) (assoc t :token/begin b :token/end e)))
                         :else (let [b (or (some (fn [[[wb _] [x _]]] (when (= wb begin) x)) moved) (:token/begin t))
                                     e (or (some (fn [[[_ we] [_ y]]] (when (= we end) y)) moved) (:token/end t))]
                                 (if (< b e) (assoc t :token/begin b :token/end e) t)))
                  got (q id)]]
      (when (not= (some-> want ((juxt :token/begin :token/end))) (some-> got ((juxt :token/begin :token/end))))
        (conj! out (str id " at " (some-> got ((juxt :token/begin :token/end))) ", want " (some-> want ((juxt :token/begin :token/end)))))))
    (persistent! out)))

(deftest a-layer-that-splits-on-space-differs-from-igt-only-there
  ;; ud (Luke, 2026-09-30): the plain rule, but a word given a space splits
  (let [opts {:carets 3 :spaced 0.4 :child 0.7 :nodes true :glue 0.1}
        fails (atom [])]
    (dotimes [seed cases-per-config]
      (let [rng (java.util.Random. (+ seed 5151))
            {:keys [body tokens]} (gen-doc rng opts)
            gaps (gen-gaps rng body tokens opts)
            new-body (ta/edit-ops-body (ta/gap-ops gaps) body)
            server (ta/plain-edit-gaps body (ta/gap-ops gaps))]
        (doseq [[rname plain split sgaps] [[:composed
                                            (ta/plain-edits body tokens (ta/gap-ops gaps) #{:s} #{:w} {:children #{:m :x} :exclusive #{:a :ss}})
                                            (ta/plain-edits body tokens (ta/gap-ops gaps) #{:s} #{:w} {:split-on-space true :children #{:m :x} :exclusive #{:a :ss}})
                                            server]
                                           [:keys-right-to-left
                                            (ta/plain-edits body tokens (keystrokes gaps true) #{:s} #{:w} {:children #{:m :x} :exclusive #{:a :ss}})
                                            (ta/plain-edits body tokens (keystrokes gaps true) #{:s} #{:w} {:split-on-space true :children #{:m :x} :exclusive #{:a :ss}})
                                            server]
                                           [:whole-body
                                            (ta/plain-body body new-body tokens #{:s} #{:w} {:children #{:m :x} :exclusive #{:a :ss}})
                                            (ta/plain-body body new-body tokens #{:s} #{:w} {:split-on-space true :children #{:m :x} :exclusive #{:a :ss}})
                                            (ta/plain-body-gaps body new-body tokens #{:s})]]]
          (let [ps (split-problems body tokens sgaps plain split)]
            (when (seq ps) (swap! fails conj {:seed seed :reading rname :old body :gaps gaps :problems (take 3 ps)}))))))
    (is (empty? @fails) (str (count @fails) " " (pr-str (take 3 @fails))))))

;; ---------------------------------------------------------------- sentence starts by the caret

;; REV3: a token over a sentence follows it, a node over several words keeps
;; to its words, and a line typed before the first sentence is a sentence
(defn- follow-checks [^String old tokens server r]
  (let [o (cps old)
        nb (:text/body (:text r))
        by-id (into {} (map (juxt :token/id identity)) (:tokens r))
        heads (:heads r)
        filled (into {} (map (juxt :token/id (juxt :token/begin :token/end)))
                     (gap-fill (into (filterv #(= :s (:token/layer %)) (:tokens r))
                                     (map #(assoc % :token/id ::head) heads))
                               (cp/cp-count nb)))
        sents (filter #(= :s (:token/layer %)) tokens)
        words (filter #(= :w (:token/layer %)) tokens)
        out (transient [])]
    ;; segments over sentences
    (doseq [{:token/keys [id begin end]} tokens :when (= :as (first id))
            :let [st (some #(when (= [begin end] (trim-ws o [(:token/begin %) (:token/end %)])) %) sents)
                  want (some->> st :token/id filled (trim-ws (cps nb)))
                  got (some-> (by-id id) ((juxt :token/begin :token/end)))]
            :when (and want got (not= want got))]
      (conj! out (str id " at " got ", its sentence at " want)))
    ;; nodes over several words, not over a sentence, keep to their words
    (doseq [{:token/keys [id begin end]} tokens :when (#{:un :us} (first id))
            :let [n (by-id id)
                  wb (some #(when (= begin (:token/begin %)) (by-id (:token/id %))) words)
                  we (some #(when (= end (:token/end %)) (by-id (:token/id %))) words)]
            :when n]
      (when (and wb (not= (:token/begin wb) (:token/begin n)))
        (conj! out (str id " begins at " (:token/begin n) ", its first word at " (:token/begin wb))))
      (when (and we (not= (:token/end we) (:token/end n)))
        (conj! out (str id " ends at " (:token/end n) ", its last word at " (:token/end we)))))
    ;; a line typed before the first sentence (REV3 N1, REV4 R4 R5): the
    ;; new text before the first sentence's first letter left, when it holds
    ;; a letter before its last line break, is a sentence of its own
    (when-let [s0 (some #(when (zero? (:token/begin %)) %) sents)]
      (let [in-gap? (fn [i] (some #(and (<= (:start %) i) (< i (:end %))) server))
            q (first (filter #(and (not (ws? (aget o %))) (not (in-gap? %))) (range 0 (:token/end s0))))]
        (when q
          (let [p (+ q (reduce + 0 (map #(- (cp/cp-count (:value %)) (- (:end %) (:start %)))
                                        (filter #(or (< (:start %) q) (and (= (:start %) (:end %)) (<= (:start %) q))) server))))
                prefix (cp/cp-subs nb 0 p)
                m (last (re-seq #"[\s\S]*[\n\r\u0085\u2028\u2029]" prefix))
                k (some-> m cp/cp-count)
                want (when (and m (re-find #"\S" m)
                                ;; not over a word the edit kept (typed over)
                                (not-any? #(and (= :w (:token/layer %)) (< (:token/begin %) k)) (:tokens r)))
                       [0 k])
                got (some-> (first heads) ((juxt :token/begin :token/end)))]
            (when (not= want got)
              (conj! out (str "head " (pr-str got) ", want " (pr-str want) " for " (pr-str prefix))))))))
    (persistent! out)))

(deftest text-typed-where-two-sentences-meet-goes-by-the-caret
  ;; Luke (2026-09-30), REV2 H1, REV3: no word taking it, text typed right
  ;; before the next sentence's first letter joins that sentence unless it
  ;; holds a line break, right after a sentence's last letter or in a longer
  ;; run of whitespace the sentence before. A line typed before the first
  ;; sentence is a sentence of its own. A segment over a sentence follows it,
  ;; and a node over several words keeps to them. Sentences never begin on
  ;; whitespace they did not have. Every other rule judged as ever.
  (let [opts {:carets 3 :spaced 0.3 :bound-early 0.5 :at-sentences true :sentence-segments true :nodes true
              :points 0.2 :lead " "
              :sentence-seps [" " "  " "\n" ". " " \n "]
              :typed ["Q" "Oh " "XZ XZ " " Q" "  " "Q\nR" "\n" "-" "Q R" "Oh.\n"]}
        fails (atom [])]
    (dotimes [seed cases-per-config]
      (let [rng (java.util.Random. (+ seed 777))
            {:keys [body tokens]} (gen-doc rng opts)
            gaps (gen-gaps rng body tokens opts)
            ;; the start of the text too
            gaps (if (and (< (.nextDouble rng) 0.3) (seq gaps) (> (:start (first gaps)) 1))
                   (into [(nth [{:start 0 :end 0 :value "Oh "} {:start 0 :end 0 :value "Oh.\n"}
                                {:start 0 :end 0 :value "Oh.\nNew "} {:start 0 :end 0 :value "Q"}
                                {:start 0 :end 0 :value "\n"} {:start 0 :end 0 :value "  \n"}
                                ;; the same line with the first letter typed over
                                {:start 0 :end 1 :value "Oh.\nX"} {:start 0 :end 1 :value "Oh.\n"}]
                               (.nextInt rng 8))]
                         gaps)
                   gaps)
            o (cps body)
            sents (sort-by :token/begin (filter #(= :s (:token/layer %)) tokens))]
        (doseq [[rname ops] {:composed (ta/gap-ops gaps) :keys-left-to-right (keystrokes gaps false)}]
          (let [r (ta/plain-edits body tokens ops #{:s} #{:w} {:children #{:m :x} :exclusive #{:a :ss}})
                server (ta/plain-edit-gaps body ops)
                ps (vec (remove #(re-find #"^\[:as " %) (problems body tokens server r)))
                nb (:text/body (:text r))
                ss (gap-fill (filterv #(= :s (:token/layer %)) (:tokens r)) (cp/cp-count nb))
                shift (fn [g] (reduce + 0 (map #(- (cp/cp-count (:value %)) (- (:end %) (:start %)))
                                               (take-while #(not= % g) server))))
                ps (into ps
                         (keep (fn [{a :start b :end v :value :as g}]
                                 (when-let [[x y] (and (= a b) (seq v)
                                                       (some (fn [[x y]] (when (= a (:token/begin y)) [x y]))
                                                             (partition 2 1 sents)))]
                                   (let [lead-ws (count (take-while ws? (cps v)))
                                         want (cond
                                                (re-find #"[\n\r\u0085\u2028\u2029]" v) (:token/id x)
                                                (not (ws? (aget o (dec a)))) (:token/id x)
                                                (and (< a (alength o)) (not (ws? (aget o a)))) (:token/id y)
                                                :else (:token/id x))
                                         p (+ a (shift g) lead-ws)
                                         got (some #(when (and (<= (:token/begin %) p) (< p (:token/end %))) (:token/id %)) ss)]
                                     (when (and (< lead-ws (cp/cp-count v)) (not= want got)
                                                ;; the sentence it should join is left
                                                (some #(= want (:token/id %)) (:tokens r)))
                                       (str "text typed at " a " went to " got ", not " want))))))
                         server)
                ps (into ps (follow-checks body tokens server r))]
            (when (seq ps) (swap! fails conj {:seed seed :reading rname :old body :gaps gaps :problems (take 3 ps)}))))))
    (is (empty? @fails) (str (count @fails) " " (pr-str (take 3 @fails))))))

;; ---------------------------------------------------------------- the side the caret is on

(deftest text-typed-where-two-words-meet-goes-to-the-side-it-says
  ;; REV2 M2, REV3 N6 N7: letters typed where two words meet with no space,
  ;; the insert saying `side`, go into the word on that side, with what hangs
  ;; off it and its sentence; with no side, into the word before. A side
  ;; where the words do not meet counts for nothing. Every other rule judged
  ;; as ever.
  (let [opts {:carets 3 :spaced 0.2 :glue 0.6 :points 0.2}
        fails (atom [])]
    (dotimes [seed cases-per-config]
      (let [rng (java.util.Random. (+ seed 99))
            {:keys [body tokens]} (gen-doc rng opts)
            o (cps body)
            words (sort-by :token/begin (filter #(= :w (:token/layer %)) tokens))
            meets (vec (keep (fn [[x y]] (when (= (:token/end x) (:token/begin y)) [x y])) (partition 2 1 words)))
            apart (vec (keep (fn [[x y]] (when (< (:token/end x) (:token/begin y)) [x y])) (partition 2 1 words)))
            glued? (and (seq meets) (or (empty? apart) (< (.nextDouble rng) 0.7)))]
        (when (or (seq meets) (seq apart))
          (let [[x y] (if glued? (nth meets (.nextInt rng (count meets))) (nth apart (.nextInt rng (count apart))))
                a (if (or glued? (.nextBoolean rng)) (:token/begin y) (:token/end x))
                side (nth [nil "before" "after"] (.nextInt rng 3))
                v (nth ["Q" "XZ" "Ж𐍂" "x " "x y"] (.nextInt rng 5))
                op (cond-> {:type :insert :index a :value v} side (assoc :side side))
                r (ta/plain-edits body tokens [op] #{:s} #{:w} {:children #{:m :x} :exclusive #{:a :ss}})
                r0 (ta/plain-edits body tokens [(dissoc op :side)] #{:s} #{:w} {:children #{:m :x} :exclusive #{:a :ss}})
                eff (when glued? side)
                ;; the part of sided text away from its side belongs to
                ;; the side's row, not to the word it touches
                ps (vec (cond->> (problems body tokens [(cond-> {:start a :end a :value v} side (assoc :side (keyword side)))] r)
                          eff (remove #(re-find #"joined to a word is in none" %))))
                at (fn [id] (some #(when (= id (:token/id %)) %) (:tokens r)))
                ext (fn [res] (set (map (juxt :token/id :token/begin :token/end) (:tokens res))))
                ps (cond-> ps
                     (and (not eff) (not= (ext r) (ext r0)))
                     (conj (str "side " side " where the words do not meet changed the outcome")))
                ps (if (and glued? (not (re-find #"\s" v)))
                     (let [want (if (= eff "after") (:token/id y) (:token/id x))
                           got (some #(when (and (<= (:token/begin %) a) (< a (:token/end %)) (= :w (:token/layer %))) (:token/id %)) (:tokens r))]
                       (cond-> ps (not= want got) (conj (str "typed " (pr-str v) " side " side " went to " got ", not " want))))
                     ps)
                ;; the typed text's first letter is in the sentence of the side's word
                ps (if glued?
                     (let [nb (:text/body (:text r))
                           ss (gap-fill (filterv #(= :s (:token/layer %)) (:tokens r)) (cp/cp-count nb))
                           sent-of (fn [p] (some #(when (and (<= (:token/begin %) p) (< p (:token/end %))) (:token/id %)) ss))
                           w (at (if (= eff "after") (:token/id y) (:token/id x)))]
                       (cond-> ps
                         (and w (not= (sent-of a) (sent-of (:token/begin w))))
                         (conj (str "typed " (pr-str v) " side " side " is in sentence " (sent-of a) ", its word in " (sent-of (:token/begin w))))))
                     ps)
                ps (cond-> ps (some #(not= ((juxt :token/begin :token/end) (at (:token/id %)))
                                           ((juxt :token/begin :token/end) (at [:w (second (:token/id %))])))
                                    (filter #(= :m (:token/layer %)) tokens))
                           (conj "a morpheme off its word"))]
            (when (seq ps) (swap! fails conj {:seed seed :old body :op op :problems (take 3 ps)}))))))
    (is (empty? @fails) (str (count @fails) " " (pr-str (take 3 @fails))))))
