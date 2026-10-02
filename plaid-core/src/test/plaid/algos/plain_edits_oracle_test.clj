(ns plaid.algos.plain-edits-oracle-test
  "A seeded property test of the plain edit rule, which every token layer
  takes: documents of sentences (a partition), words (some holding spaces,
  as FLEx phrases do), morphemes over the whole of their word (as igt
  stores them) and time-alignment segments over runs of words, on the
  layers igt, ud and UMR make, or on the layers a script makes with no app
  config (`layouts`). What each layer is to the rule is read from the
  layers' shape alone (`plaid.algos.text/layer-roles`), as a save reads it.
  Each case is one to four changes made at
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
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
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
        nsent (inc (.nextInt rng (:sentences opts 3)))
        wid (volatile! 0)
        ;; where the next sentence begins: after the whitespace between two
        ;; sentences, or (`:bound-early`) before it
        nstart (volatile! 0)
        ;; whitespace the text begins with (`:lead`), in the first sentence
        _ (when-let [l (:lead opts)] (when (< (.nextDouble rng) 0.5) (add l)))]
    (dotimes [si nsent]
      (let [sb0 @nstart
            n (+ 1 (.nextInt rng (:words opts 5)))
            words (vec (for [i (range n)]
                         (let [w (if (< (.nextDouble rng) (:spaced opts 0.3)) (pick phrases) (pick (:vocab opts vocab)))
                               b @pos]
                           (add w)
                           (let [e @pos id (vswap! wid inc)]
                             (conj! toks {:token/id [:w id] :token/layer :w :token/begin b :token/end e})
                             (if (and (:sub opts) (< (.nextDouble rng) (:sub opts)) (< 1 (- e b)) (not (re-find #"\s" w)))
                               ;; morphemes inside the word, as a script's
                               ;; analysis has them (`[:ms word k]`)
                               (let [cuts (sort (distinct (repeatedly (inc (.nextInt rng 2)) #(+ b 1 (.nextInt rng (dec (- e b)))))))]
                                 (doseq [[k [x y]] (map-indexed vector (partition 2 1 (concat [b] cuts [e])))]
                                   (conj! toks {:token/id [:ms id k] :token/layer :m :token/begin x :token/end y})))
                               (dotimes [m (if (:one-morph opts) 1 (inc (.nextInt rng 3)))]
                                 (conj! toks {:token/id [:m id m] :token/layer :m :token/begin b :token/end e})))
                             ;; another app's layer nested under the words
                             ;; (a ud syntactic word): plain because its parent is
                             (when (and (:child opts) (< (.nextDouble rng) (:child opts)))
                               (conj! toks {:token/id [:x id] :token/layer :x :token/begin b :token/end e}))
                             (when (< i (dec n))
                               ;; words written together, as after the space
                               ;; between them was deleted
                               (add (if (and (:glue opts) (< (.nextDouble rng) (:glue opts)))
                                      ""
                                      (pick (:seps opts [" " " " " " "  " "\t"])))))
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
        text-of (fn [{:token/keys [begin end]}] (String. ^ints nw (int begin) (int (- end begin))))
        ;; a token whose text is one of a gap's words typed over (see
        ;; `cut-at-words`): where it must be now
        ;; (those that are a word's text)
        keep-want (let [extents (into #{} (comp (filter #(and (= wl (:token/layer %)) (< (:token/begin %) (:token/end %))))
                                                (map (juxt :token/begin :token/end)))
                                      tokens)]
                    (into {} (mapcat (fn [g] (keep (fn [[b e off len]]
                                                     (when (extents [b e]) [[b e] [(+ (gap-new g) off) (+ (gap-new g) off len)]]))
                                                   (:keeps g))))
                          gaps))
        holds-keep? (fn [{:token/keys [begin end]}] (some (fn [[[b e] _]] (and (<= begin b) (<= e end))) keep-want))]
    (when (not= expected new-body) (bad! "body " (pr-str new-body) " not " (pr-str expected)))
    (when (= expected new-body)
      ;; each word typed over as a word of its own is on it
      (doseq [{:token/keys [id layer begin end]} tokens
              :let [want (keep-want [begin end])]
              :when (and want
                         ;; a row over a sentence follows it (REV3)
                         (not (and (#{:a :ss} layer)
                                   (some #(and (= :s (:token/layer %))
                                               (= [begin end] (trim-ws o [(:token/begin %) (:token/end %)])))
                                         tokens))))]
        (let [now (by-id id)]
          (when (or (gone id) (not= want [(:token/begin now) (:token/end now)]))
            (bad! id " typed over as a word of its own is not on it: " (pr-str (when-not (gone id) (some-> now text-of)))))))
      (doseq [{:token/keys [id layer begin end] :as t} tokens
              :when (and (plain layer) (< begin end) (not (keep-want [begin end]))
                         ;; a token over a sentence follows it (REV3)
                         (or (= :s layer) (not (#{:a :ss} layer))
                             (not-any? #(and (= :s (:token/layer %))
                                             (= [begin end] (trim-ws o [(:token/begin %) (:token/end %)])))
                                       tokens)))]
        (let [kept (kept-of t)
              cov (covering t)
              ;; no letter of it left, and none typed inside it
              must-go (and (every? #(ws? (aget o %)) kept)
                           (every? (fn [g] (every? ws? (cps (:value g)))) cov)
                           (not (holds-keep? t)))
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
              (when (and (= layer wl) (not (holds-keep? t)))
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
      (doseq [{:token/keys [id]} tokens :when (= :ms (first id))]
        (let [w [:w (second id)] m* (by-id id) w* (by-id w)]
          (cond
            (and (gone w) (not (gone id))) (bad! id " outlived its word")
            (and m* w* (not (gone id)) (not (gone w))
                 (not (and (<= (:token/begin w*) (:token/begin m*)) (<= (:token/end m*) (:token/end w*)))))
            (bad! id " left its word"))))
      (doseq [{:token/keys [id layer]} tokens :when (and (#{:m :x} layer) (not= :ms (first id)))]
        (let [w [:w (second id)]]
          (cond
            (not= (boolean (gone id)) (boolean (gone w))) (bad! id " and its word part")
            (and (by-id id) (not (gone id))
                 (not= ((juxt :token/begin :token/end) (by-id id)) ((juxt :token/begin :token/end) (by-id w))))
            (bad! id " off its word"))))
      ;; no two tokens of a layer without overlaps overlap, nor two sentences
      (doseq [layer [:w :a :s :ms]]
        (let [ts (sort-by (juxt :token/begin :token/end) (filter #(and (if (= :ms layer) (= :ms (first (:token/id %))) (= layer (:token/layer %)))
                                                                       (not (gone (:token/id %))))
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

(def ^:private layouts
  "The token layers of each kind of document, as `layer-roles` takes them."
  {;; igt's, ud's and UMR's layers on one text: sentences, words under
   ;; them, morphemes and another app's syntactic words under the words,
   ;; time-alignment rows and UMR's nodes beside them
   :apps [{:id :s :overlap-mode "partitioning"}
          {:id :w :overlap-mode "non-overlapping" :parent :s}
          {:id :m :overlap-mode "any" :parent :w}
          {:id :x :overlap-mode "non-overlapping" :parent :w}
          {:id :a :overlap-mode "non-overlapping"}
          {:id :ss :overlap-mode "non-overlapping"}
          {:id :u :overlap-mode "any"}]
   ;; a script's layers, no app config: sentences, words on a layer with no
   ;; parent, morphemes under them
   :script [{:id :s :overlap-mode "partitioning"}
            {:id :w :overlap-mode "non-overlapping"}
            {:id :m :overlap-mode "any" :parent :w}]
   ;; a script's words on a root layer with morphemes on a layer that forbids
   ;; overlap under them: the words decide
   :rooted [{:id :s :overlap-mode "partitioning"}
            {:id :w :overlap-mode "non-overlapping"}
            {:id :m :overlap-mode "non-overlapping" :parent :w}]
   ;; one sentence of words, as the whole-body intent judge has them
   :intent [{:id :s :overlap-mode "partitioning"}
            {:id :w :overlap-mode "non-overlapping" :parent :s}]
   ;; and with no sentences, words on a layer that allows overlap
   :script-no-sentences [{:id :w :overlap-mode "any"}
                         {:id :m :overlap-mode "any" :parent :w}]})

(defn- layout-tokens
  "`tokens` less those on layers `layout` has none of."
  [layout tokens]
  (let [ids (into #{} (map :id) (layouts layout))]
    (filterv #(ids (:token/layer %)) tokens)))

(defn- roles [layout split?]
  (cond-> (ta/layer-roles (layouts layout)) split? (assoc :split-on-space true)))

(defn- run
  "What a save of `ops` from the caret does, the layers as `layout` has them."
  ([old tokens ops] (run old tokens ops :apps false))
  ([old tokens ops layout split?]
   (let [{:keys [partitioning deciders] :as r} (roles layout split?)]
     (ta/plain-edits old tokens ops partitioning deciders (select-keys r [:split-on-space :children :exclusive :head-layers])))))

(defn- exact
  "What `ops` do taken exactly as made: each net gap less the text it shares
  with the old at either end, read by the plain rule (REV2-F-TEXT-CORE X)."
  [^String old tokens ops layout]
  (let [{:keys [partitioning deciders] :as r} (roles layout false)
        o (cps old)]
    (ta/apply-plain-gaps old tokens (vec (keep #(#'ta/trim-gap o %) (ta/compose-edits ops old)))
                         partitioning deciders
                         (assoc (select-keys r [:split-on-space :children :exclusive :head-layers]) :caret true))))

(defn- lost-problems
  "The words and sentences `r` deletes that `x`, the edit taken exactly as
  made, keeps (a word counted by its text, so one of two twins may go in
  place of the other): a reading never deletes what the edit as made keeps
  letters of (REV2-F-TEXT-CORE R1). With `:paste`, `r` read the change
  from a paste, which cannot tell a word from one of the same letters
  beside it, and may delete no more words or sentences than `x`."
  ([old tokens r x] (lost-problems old tokens r x nil))
  ([^String old tokens r x mode]
   (let [o (cps old)
         text (fn [{:token/keys [begin end]}] (String. o (int begin) (int (- end begin))))
         gone (fn [r layer] (let [g (set (:deleted r))] (filter #(and (= layer (:token/layer %)) (g (:token/id %))) tokens)))
         wr (frequencies (map text (gone r :w)))
         wx (frequencies (map text (gone x :w)))
         sx (set (map :token/id (gone x :s)))]
     (if (= mode :paste)
       (cond-> []
         (< (count (gone x :w)) (count (gone r :w))) (conj (str "deleted words " (pr-str wr) ", as made " (pr-str wx)))
         (< (count (gone x :s)) (count (gone r :s))) (conj "deleted more sentences than the edit as made"))
       (cond-> []
         (some (fn [[t c]] (< (get wx t 0) c)) wr) (conj (str "deleted words " (pr-str wr) ", as made " (pr-str wx)))
         (some #(not (sx (:token/id %))) (gone r :s)) (conj "deleted a sentence the edit as made keeps"))))))

(defn- server-gaps
  "The gaps an edit by `ops` is taken as, the layers as `layout` has them."
  [old tokens ops layout]
  (let [{:keys [partitioning deciders] :as r} (roles layout false)]
    (ta/plain-edit-gaps old ops tokens partitioning deciders (select-keys r [:split-on-space :children :exclusive :head-layers]))))

(defn- save-read
  "`[gaps result]` of a whole-body save of `new`, the layers as `layout` has
  them (see `plain-body-read`)."
  [old new tokens layout split?]
  (let [{:keys [partitioning deciders] :as r} (roles layout split?)]
    (ta/plain-body-read old new tokens partitioning deciders (select-keys r [:split-on-space :children :exclusive :head-layers]))))

(defn- save
  "What a whole-body save of `new` does, the layers as `layout` has them."
  ([old new tokens] (save old new tokens :apps false))
  ([old new tokens layout split?] (second (save-read old new tokens layout split?))))

(declare survivor-problems)

(def ^:private nbsp "\u00a0")

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
   :empty-segments {:carets 3 :points 0.4 :spaced 0.3 :glue 0.2}
   ;; words apart by no-break spaces, tabs and runs of spaces
   :other-spaces {:carets 3 :spaced 0.2 :seps [" " nbsp "\u202f" "\t" "   "]}
   ;; a script without spaces between words
   :no-spaces {:carets 3 :glue 1.0 :spaced 0.1}
   ;; a script's layers with no app config (a plain API client)
   :script {:carets 3 :spaced 0.3 :glue 0.1 :layout :script}
   :script-several-carets {:carets 4 :spaced 0.2 :reach 30 :layout :script}
   :script-no-sentences {:carets 3 :spaced 0.3 :glue 0.2 :layout :script-no-sentences}
   ;; morphemes inside their words (a script's analysis), words typed over
   ;; as words of their own
   :sub-word-morphemes {:carets 3 :spaced 0.2 :sub 0.7 :layout :script :typed ["Q R" "XZ XZ" "XZ XZ XZ" "Q" "XZ" " " "Q " "ab"]}
   :rooted {:carets 3 :spaced 0.2 :sub 1.0 :one-morph true :glue 0.1 :layout :rooted}
   :words-typed-over {:carets 2 :spaced 0.2 :reach 40 :typed ["Q R" "XZ XZ" "XZ XZ XZ" "Q R S T" "a b" "Q"]}})

(def ^:private cases-per-config 1500)

(deftest a-plain-layer-takes-every-edit-the-plain-way
  (doseq [[cname opts] configs]
    (let [fails (atom [])]
      (dotimes [seed cases-per-config]
        (let [rng (java.util.Random. (+ seed (* 7919 (hash cname))))
              layout (:layout opts :apps)
              {:keys [body tokens]} (gen-doc rng opts)
              gaps (gen-gaps rng body tokens opts)
              tokens (layout-tokens layout tokens)
              new-body (ta/edit-ops-body (ta/gap-ops gaps) body)
              server (server-gaps body tokens (ta/gap-ops gaps) layout)
              readings {:composed (ta/gap-ops gaps)
                        :keys-left-to-right (keystrokes gaps false)
                        :keys-right-to-left (keystrokes gaps true)}]
          (doseq [[rname ops] readings]
            (let [r (run body tokens ops layout false)
                  ps (into (problems body tokens server r)
                           (lost-problems body tokens r (exact body tokens ops layout)))]
              (when (seq ps) (swap! fails conj {:config cname :seed seed :reading rname :old body :gaps gaps :problems (take 3 ps)}))))
          (let [[bgaps r] (save-read body new-body tokens layout false)
                ps (into (problems body tokens bgaps r) (survivor-problems body new-body tokens layout r))]
            (when (seq ps) (swap! fails conj {:config cname :seed seed :reading :whole-body :old body :gaps bgaps :problems (take 3 ps)})))))
      (when (or (System/getenv "PLAIN_ORACLE_DEBUG") (System/getProperty "plain.oracle.debug"))
        (println cname (count @fails) (frequencies (map :reading @fails)))
        (doseq [f (take 6 @fails)] (println (pr-str f))))
      (testing (str cname)
        (is (empty? @fails) (pr-str (take 3 @fails)))))))

;; ---------------------------------------------------------------- pastes over several words

;; H1-IGT-TEXT-1: the same text pasted back with a word more, a word less
;; or a word typed over, over the whole body, a line or any stretch of whole
;; words, read old word i as new word i, so every word after the change took
;; its neighbour's analysis and sentences went. REV-F-TEXT-CORE: with a word
;; that repeats and two changes, or in a script without spaces, pairing the
;; words of the stretch by any rule of its own still put words on the wrong
;; copy or deleted those between the changes. A replace over several words
;; is now read as a whole-body save reads the same change, so a paste (W)
;; reads as the exact edits (X) or the whole-body save (B) do.

(defn- one-word-change
  "`[start end value]`: one word typed in before or after `w`, `w` deleted
  with the whitespace on one side of it, or `w` typed over, or nil when `w`
  is its sentence's only word and the change would delete it. `words` are
  the words typed (some may be words the text has), `sep` what stands
  between words."
  [^java.util.Random rng ^ints o w sole? words sep]
  (let [{:token/keys [begin end]} w
        n (alength o)
        blank? (fn [c] (or (= c (int \space)) (= c (int \tab))))
        run-after (loop [x end] (if (and (< x n) (blank? (aget o x))) (recur (inc x)) x))
        run-before (loop [x begin] (if (and (pos? x) (blank? (aget o (dec x)))) (recur (dec x)) x))
        word (nth words (.nextInt rng (count words)))]
    (case (.nextInt rng 4)
      0 [begin begin (str word sep)]
      1 [end end (str sep word)]
      2 (when-not sole?
          (cond (< end run-after) [begin run-after ""]
                (< run-before begin) [run-before end ""]
                (= sep "") [begin end ""]
                :else nil))
      3 [begin end word])))

(defn- placed-words
  "`[[old text, new text] of each word left, in order, deleted words' old
  texts]` after `r`: a word of the same text may stand in for another, as
  where a word typed in has the text of its neighbour (`a b` to `a a b`)."
  [^ints o tokens r]
  (let [text (fn [{:token/keys [begin end]}] (String. o (int begin) (int (- end begin))))
        nw (cps (:text/body (:text r)))
        old-of (into {} (map (juxt :token/id identity)) tokens)
        gone (set (:deleted r))]
    [(->> (:tokens r)
          (filter #(= :w (:token/layer %)))
          (remove #(gone (:token/id %)))
          (map (fn [t] [(text (old-of (:token/id t))) (String. nw (int (:token/begin t)) (int (- (:token/end t) (:token/begin t))))]))
          frequencies)
     (sort (map text (filter #(and (= :w (:token/layer %)) (gone (:token/id %))) tokens)))]))

(defn- paste-problems
  "What is wrong with `r`, a paste over `old` holding the `changes` (`[a b
  value]` each, in order, apart), for `tokens`, against the nearest of
  `refs`, the same change sent as exact edits and saved as a whole body:
  its words on the same text and the same words deleted as one of them (a word of the same
  text may stand in for another), no sentence deleted unless that one
  deletes it, and every word apart from the changes, not beside one, on its
  own text where they leave it."
  [^String old tokens changes r refs]
  (let [o (cps old)
        got (placed-words o tokens r)
        sentence-gone (fn [r] (some #(and (= :s (:token/layer %)) ((set (:deleted r)) (:token/id %))) tokens))
        shift (fn [x] (reduce (fn [y [a b v]] (if (<= b x) (+ y (- (cp/cp-count v) (- b a))) y)) x changes))
        once (frequencies (keep #(when (= :w (:token/layer %)) (String. o (int (:token/begin %)) (int (- (:token/end %) (:token/begin %))))) tokens))
        apart (into {} (keep (fn [{:token/keys [begin end] :as w}]
                               (let [t (String. o (int begin) (int (- end begin)))]
                                 (when (and (= :w (:token/layer w)) (= 1 (once t))
                                            (not-any? (fn [[_ _ v]] (.contains ^String v t)) changes)
                                            (every? (fn [[a b]] (or (< end (dec a)) (< (inc b) begin))) changes))
                                   [[(shift begin) (shift end)] t]))))
                    tokens)]
    (first
     (sort-by count
              (for [ref refs]
                (cond-> []
                  (not= (:text/body (:text r)) (:text/body (:text (first refs)))) (conj (str "body " (pr-str (:text/body (:text r)))))
                  (not= got (placed-words o tokens ref))
                  (conj (let [[w gw] (placed-words o tokens ref) [g gg] got]
                          (str "words " (pr-str (remove (set g) w)) " got " (pr-str (remove (set w) g))
                               " deleted " (pr-str gg) " want " (pr-str gw))))
                  (not-every? (fn [[[b e] t]] (some #(and (= b (:token/begin %)) (= e (:token/end %)) (not ((set (:deleted r)) (:token/id %)))) (:tokens r)))
                              apart)
                  (conj "a word apart from the changes moved")
                  (and (sentence-gone r) (not (sentence-gone ref))) (conj "a sentence deleted")))))))

(def ^:private paste-configs
  {:apps {:spaced 0.3 :sentences 4 :words 8}
   :apps-nodes-and-children {:spaced 0.2 :nodes true :child 0.5 :points 0.2 :sentences 4 :words 8}
   :long {:spaced 0.2 :sentences 10 :words 14 :sentence-segments true}
   :script {:spaced 0.3 :sentences 4 :words 8 :layout :script}
   :rooted {:spaced 0.2 :sub 1.0 :one-morph true :sentences 4 :words 8 :layout :rooted}
   :script-no-sentences {:spaced 0.3 :words 12 :layout :script-no-sentences}
   :other-spaces {:spaced 0.2 :sentences 4 :words 8 :seps [" " nbsp "\t" "   "] :sentence-seps ["\n" ". " "\n\n"]}
   ;; a small vocabulary that repeats, the words typed among it
   :repeating {:spaced 0 :sentences 3 :words 6 :vocab ["xa" "ba" "cat" "the" "a"] :typed-words ["xa" "the" "a" "teh"]
               :sentence-seps ["\n"] :changes 3}
   :repeating-phrases {:spaced 0.3 :sentences 3 :words 6 :vocab ["a" "b" "talu" "lei"] :typed-words ["a" "b" "lei"] :changes 2}
   ;; a script without spaces: one word a character
   :spaceless {:spaced 0 :glue 1.0 :sentences 3 :words 6 :vocab ["你" "好" "吗" "我" "很" "。"] :typed-words ["嗎" "好" "！"]
               :sep "" :sentence-seps ["" "\n"] :changes 2}})

(def ^:private paste-ceiling
  "Pastes, of the 6,750 the test below makes, read as the whole-body save of
  the same change reads them although that deletes a word the exact edits
  keep. Each holds two or three changes, and the text alone does not tell
  the edits apart from another change of the same result that deletes one
  word more: `xa ba the ba a` pasted as `the ba ba a` (`xa` typed over as
  `the` and `the ` deleted) reads as `xa` and a `ba` deleted. The gap as
  made, the only other reading, deletes more in every one. Finding the
  edits there needs pairing the words of the paste, which REV-F-TEXT-CORE
  ruled out. Two hold one change in a script without spaces, where one of
  two words of the same character on either side of a sentence break is
  deleted (`好好我好` pasted as `好我好`) and the text cannot tell which: the
  save deletes the first and its one-word sentence, the edit the second.
  24 when pinned (2026-10-02, REV2-F-TEXT-CORE)."
  24)

(deftest a-paste-over-several-words-reads-as-the-edits-or-the-whole-body-save
  (let [as-saved (atom [])]
    (doseq [[cname opts] paste-configs
            k (range 1 (inc (:changes opts 3)))]
      (let [fails (atom [])]
        (dotimes [seed 250]
          (let [rng (java.util.Random. (+ seed (* 31 k) (* 104729 (hash cname))))
                layout (:layout opts :apps)
                {:keys [body tokens]} (gen-doc rng opts)
                tokens (layout-tokens layout tokens)
                o (cps body)
                n (alength o)
                words (vec (sort-by :token/begin (filter #(= :w (:token/layer %)) tokens)))
                sents (filter #(= :s (:token/layer %)) tokens)
                sole? (fn [w] (let [sent (some #(when (and (<= (:token/begin %) (:token/begin w)) (<= (:token/end w) (:token/end %))) %) sents)]
                                (or (= 1 (count words))
                                    (and sent (= 1 (count (filter #(and (<= (:token/begin sent) (:token/begin %)) (<= (:token/end %) (:token/end sent))) words)))))))
              ;; k changes, each at its own word, apart from each other
                changes (->> (repeatedly (* 3 k) #(let [w (words (.nextInt rng (count words)))]
                                                    (one-word-change rng o w (sole? w) (:typed-words opts ["XZ" "Ж𐍂" "qoke"]) (:sep opts " "))))
                             (remove nil?)
                             (sort-by first)
                             (reduce (fn [out [a :as c]] (if (and (seq out) (<= a (inc (second (peek out))))) out (conj out c))) [])
                             (take k)
                             vec)]
            (when (seq changes)
              (let [gaps (mapv (fn [[a b v]] {:start a :end b :value v}) changes)
                    new (ta/edit-ops-body (ta/gap-ops gaps) body)
                    d (- (cp/cp-count new) n)
                    exact (run body tokens (ta/gap-ops gaps) layout false)
                    whole (save body new tokens layout false)
                    [a b] [(first (first changes)) (second (peek changes))]
                  ;; a stretch from the start of a word before the changes to
                  ;; the end of one after them, pasted over with its new text
                    over (fn [x y] (let [x (min x a) y (max y b)]
                                     [{:type :replace :index x :length (- y x) :value (cp/cp-subs new x (+ y d))}]))
                    lo (or (last (filter #(<= (:token/begin %) a) (take (- (count words) (.nextInt rng 3)) words))) (first words))
                    hi (or (first (filter #(>= (:token/end %) b) (drop (.nextInt rng 3) words))) (peek words))
                    sent (some #(when (and (<= (:token/begin %) a) (<= b (:token/end %))) %) sents)
                    readings (cond-> {:whole-body-replace [{:type :replace :index 0 :length n :value new}]
                                      :stretch (over (:token/begin lo) (:token/end hi))}
                               sent (assoc :line (over (:token/begin sent) (:token/end sent))))]
                (doseq [[rname ops] readings]
                  (let [r (run body tokens ops layout false)
                        made (#'plaid.algos.plain-edits-oracle-test/exact body tokens ops layout)
                        ps (-> (paste-problems body tokens changes r [exact whole made])
                               (into (problems body tokens (server-gaps body tokens ops layout) r))
                               (into (lost-problems body tokens r exact :paste)))]
                    (when (seq ps)
                      (if (and (= (placed-words o tokens r) (placed-words o tokens whole))
                               (empty? (problems body tokens (server-gaps body tokens ops layout) r)))
                      ;; read as the whole-body save of it reads it, which
                      ;; deletes a word the edits keep: see `paste-ceiling`
                        (swap! as-saved conj [cname k seed rname])
                        (swap! fails conj {:config cname :changes changes :seed seed :reading rname :old body :problems (take 3 ps)})))))))))
        (when (or (System/getenv "PLAIN_ORACLE_DEBUG") (System/getProperty "plain.oracle.debug"))
          (println cname k (count @fails) (frequencies (map :reading @fails)))
          (doseq [f (take 4 @fails)] (println (pr-str f))))
        (testing (str cname " " k " changes")
          (is (empty? @fails) (pr-str (take 3 @fails))))))
    (is (<= (count (distinct (map #(subvec % 0 3) @as-saved))) paste-ceiling)
        (str (count (distinct (map #(subvec % 0 3) @as-saved))) " " (pr-str (take 10 (distinct (map #(subvec % 0 3) @as-saved))))))))

;; ---------------------------------------------------------------- nodes beside the words

(defn- nodes-and-words
  "The words (:w) and nodes (:u) after a save, both on the one rule."
  [old tokens {:keys [ops new]}]
  (let [r (if ops (run old tokens ops) (save old new tokens))
        live (fn [layer] (into {} (comp (filter #(= layer (:token/layer %)))
                                        (remove #((set (:deleted r)) (:token/id %)))
                                        (map (juxt :token/id identity)))
                               (:tokens r)))]
    {:body [(:text/body (:text r)) (:text/body (:text r))]
     :words (live :w)
     :nodes (live :u)
     :deleted-nodes (set (:deleted r))}))

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

(deftest nodes-beside-the-words-keep-to-the-words
  ;; A node layer beside the words (UMR's) takes the words' outcome at their
  ;; edges, whatever the edit (Luke, 2026-09-30, option c).
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
          (let [ps (follow-problems tokens new-body (nodes-and-words body tokens change))]
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
  letters, the first on a tie. Each other part holding one of its old
  letters is a new word, with a new
  token under it on each layer under the words the word had one as long as
  it on, unless that layer had as many as there are parts, which then go one
  to each part in order (Q2-UD-POLISH-2). Another token as long as it goes
  with it, one inside it is cut to the part holding most of its letters (or
  goes when none of it is there), one over several words that began or
  ended with it begins or ends where it does, and nothing else differs.
  `gaps` are the change as the server takes it."
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
        ;; every part of each split word (Q2-UD-POLISH-2: each is a word)
        pieces-of (into {}
                        (keep (fn [{:token/keys [id layer begin end]}]
                                (when (moved [begin end])
                                  (let [t (p id) pb (:token/begin t) pe (:token/end t)
                                        runs (->> (range pb pe) (partition-by #(ws? (aget nw %)))
                                                  (filter #(ws? (aget nw (first %)))))
                                        cuts (filter (fn [r] (some #(aget typed %) r)) runs)
                                        own (set (keep #(let [x (aget newpos %)] (when (and (>= x 0) (not (ws? (aget o %)))) x))
                                                       (range begin end)))
                                        all (map vector (cons pb (map #(inc (last %)) cuts)) (concat (map first cuts) [pe]))]
                                    ;; a part holding none of its letters is text
                                    ;; typed apart from it
                                    [[begin end] (vec (or (not-empty (filter (fn [[x y]] (some own (range x y))) all))
                                                          [(moved [begin end])]))]))))
                        (filter #(= :w (:token/layer %)) tokens))
        ;; the tokens under a split word as long as it, by word and layer: as
        ;; many of a layer as parts go one to each part, in order
        child? #{:m :x}
        under (group-by (juxt (juxt :token/begin :token/end) :token/layer)
                        (filter #(and (child? (:token/layer %)) (p (:token/id %))
                                      (pieces-of [(:token/begin %) (:token/end %)]))
                                tokens))
        shared (into {} (mapcat (fn [[[w _] ts]] (when (= (count ts) (count (pieces-of w)))
                                                   (map vector (map :token/id ts) (pieces-of w))))
                                under))
        want-made (sort (mapcat (fn [[w ps]]
                                  (for [piece ps :when (not= piece (moved w))
                                        l (cons :w (keep (fn [[[w2 l] ts]] (when (and (= w2 w) (not (shared (:token/id (first ts))))) l)) under))]
                                    [l (first piece) (second piece)]))
                                pieces-of))
        out (transient [])]
    (when (not= want-made (sort (map (juxt :token/layer :token/begin :token/end) (:made split))))
      (conj! out (str "made " (pr-str (:made split)) ", want " (pr-str want-made))))
    (when (not= (:text split) (:text plain)) (conj! out "body"))
    (doseq [{:token/keys [id layer begin end]} tokens
            :let [t (p id)
                  got (q id)
                  ;; a token over a sentence follows the sentence (REV3)
                  over (when (and t (#{:a :ss} layer))
                         (some #(when (and (= :s (:token/layer %)) (= [begin end] (trim-ws o [(:token/begin %) (:token/end %)])))
                                  (:token/id %))
                               tokens))
                  inside (some (fn [[[wb we] ps]] (when (and (<= wb begin) (<= end we) (not (and (= wb begin) (= we end)))) ps)) pieces-of)
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
                         (shared id) (let [[x y] (shared id)] (assoc t :token/begin x :token/end y))
                         (moved [begin end]) (let [[x y] (moved [begin end])] (assoc t :token/begin x :token/end y))
                         ;; to the part holding most of its own letters, the
                         ;; first on a tie
                         inside (let [in (fn [[x y]] [(max x (:token/begin t)) (min y (:token/end t))])
                                      own (set (keep #(let [x (aget newpos %)] (when (and (>= x 0) (not (ws? (aget o %)))) x))
                                                     (range begin end)))
                                      score (fn [piece] (let [[b e] (in piece)] [(count (filter own (range b e))) (- e b)]))
                                      best (reduce (fn [a q] (if (pos? (compare (score q) (score a))) q a)) inside)
                                      [b e] (in best)]
                                  (when (< b e) (assoc t :token/begin b :token/end e)))
                         :else (let [b (or (some (fn [[[wb _] [x _]]] (when (= wb begin) x)) moved) (:token/begin t))
                                     e (or (some (fn [[[_ we] [_ y]]] (when (= we end) y)) moved) (:token/end t))]
                                 (if (< b e) (assoc t :token/begin b :token/end e) t)))
                  got (q id)]]
      (when (not= (some-> want ((juxt :token/begin :token/end))) (some-> got ((juxt :token/begin :token/end))))
        (conj! out (str id " at " (some-> got ((juxt :token/begin :token/end))) ", want " (some-> want ((juxt :token/begin :token/end)))))))
    (persistent! out)))

(deftest a-layer-that-splits-on-space-differs-only-there
  ;; ud (Luke, 2026-09-30): the plain rule, but a word given a space splits
  ;; and (Q2-UD-POLISH-2) each other part of the word is a word of its own
  (doseq [[layout opts] [[:apps {:carets 3 :spaced 0.4 :child 0.7 :nodes true :glue 0.1}]
                         ;; a script's words with morphemes inside them
                         [:script {:carets 3 :spaced 0.3 :sub 0.6 :glue 0.1 :typed ["Q" " " "Q R" " Q " "XZ XZ"]}]]]
    (let [fails (atom [])]
      (dotimes [seed cases-per-config]
        (let [rng (java.util.Random. (+ seed 5151 (if (= layout :apps) 0 7)))
              {:keys [body tokens]} (gen-doc rng opts)
              gaps (gen-gaps rng body tokens opts)
              tokens (layout-tokens layout tokens)
              new-body (ta/edit-ops-body (ta/gap-ops gaps) body)
              server (server-gaps body tokens (ta/gap-ops gaps) layout)]
          (doseq [[rname plain split sgaps] [[:composed
                                              (run body tokens (ta/gap-ops gaps) layout false)
                                              (run body tokens (ta/gap-ops gaps) layout true)
                                              server]
                                             [:keys-right-to-left
                                              (run body tokens (keystrokes gaps true) layout false)
                                              (run body tokens (keystrokes gaps true) layout true)
                                              server]
                                             [:whole-body
                                              (save body new-body tokens layout false)
                                              (save body new-body tokens layout true)
                                              (first (save-read body new-body tokens layout false))]]]
            (let [ps (split-problems body tokens sgaps plain split)]
              (when (seq ps) (swap! fails conj {:layout layout :seed seed :reading rname :old body :gaps gaps :problems (take 3 ps)}))))))
      (testing (str layout)
        (is (empty? @fails) (str (count @fails) " " (pr-str (take 3 @fails))))))))

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
          (let [r (run body tokens ops)
                server (server-gaps body tokens ops :apps)
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
                r (run body tokens [op])
                r0 (run body tokens [(dissoc op :side)])
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

;; ---------------------------------------------------------------- whole-body saves by intent

;; The judge above takes a whole-body save as the gaps its own diff gave,
;; which leaves out where the diff can stand in several places (`the a ab`
;; to `the aX`). This one knows what was meant: words of a script's layers,
;; one respelled with neighbours deleted, two respelled, or a run deleted,
;; saved as a whole body, and each word's token must be on the word it was
;; made for, or gone when its word was deleted (REV-one-rule F2, F5).

(defn- survivor-problems
  "The tokens a whole-body save of `old` as `new` deleted though a letter of
  theirs is outside every gap of the diff, as either reading has it
  (`body-diff-gaps`, aligned to the words or not): a
  word goes only when all its letters go (REV2-one-rule G1). A token inside
  a word the save kept, read as that word typed over (`cow`, `co` + `w`, to
  `abc`, F4), may go."
  [^String old ^String new tokens layout r]
  (let [{:keys [partitioning deciders]} (roles layout false)
        o (cps old)
        ;; the two readings of the diff, aligned to the words and as it
        ;; stands: a token may go when all its letters are in the gaps of one
        mark (fn [gaps] (let [a (boolean-array (alength o))]
                          (doseq [{:keys [start end]} gaps, i (range start end)] (aset a i true))
                          a))
        readings [(mark (ta/body-diff-gaps old new tokens partitioning deciders))
                  (mark (ta/body-diff-gaps old new tokens partitioning deciders false))]
        left? (fn [b e] (every? (fn [^booleans in-gap]
                                  (some #(and (not (aget in-gap %)) (not (ws? (aget o %)))) (range b e)))
                                readings))
        gone (set (:deleted r))
        words (if (seq deciders) (filter #(deciders (:token/layer %)) tokens)
                  (remove #(partitioning (:token/layer %)) tokens))
        kept-word? (fn [{:token/keys [id begin end]}]
                     (some #(and (not= id (:token/id %)) (not (gone (:token/id %)))
                                 (<= (:token/begin %) begin) (<= end (:token/end %)))
                           words))]
    (into [] (keep (fn [{:token/keys [id begin end] :as t}]
                     (when (and (gone id) (< begin end)
                                (left? begin end)
                                (not (kept-word? t)))
                       (str id " deleted with a letter left " (pr-str (cp/cp-subs old begin end))))))
          tokens)))

(defn- intent-save
  "The problems of saving `body` as `new` where old word i was meant to be
  new word `(intent i)` (nil: deleted). Words are the runs between spaces,
  on a word layer under one sentence."
  [^String body ^String new intent]
  (let [spans (fn [^String s] (let [m (re-matcher #"[^ .]+" s)] (loop [out []] (if (.find m) (recur (conj out [(.start m) (.end m)])) out))))
        old-w (spans body)
        new-w (spans new)
        tokens (into [{:token/id :s :token/layer :s :token/begin 0 :token/end (cp/cp-count body)}]
                     (map-indexed (fn [i [b e]] {:token/id i :token/layer :w :token/begin b :token/end e}) old-w))
        r (save body new tokens :intent false)
        gone (set (:deleted r))
        got (into {} (comp (remove #(gone (:token/id %))) (map (juxt :token/id (juxt :token/begin :token/end)))) (:tokens r))]
    (into (survivor-problems body new tokens :intent r)
          (keep (fn [i]
                  (let [want (some-> (intent i) new-w)
                        g (got i)]
                    (when (not= want g)
                      (str (apply subs body (old-w i)) " is on " (pr-str (some->> g (apply subs new)))
                           ", want " (pr-str (some->> want (apply subs new))))))))
          (range (count old-w)))))

(deftest a-whole-body-save-keeps-each-word-on-the-word-meant
  ;; the reviewer's cases the rules before the plain rule got right and it
  ;; got wrong (REV-one-rule, intent oracle, seed 31), that a reading of the
  ;; diff can get right without deleting a word it keeps letters of
  (doseq [[body new intent] [["ad ctb td a ctc." "ad ctb ta d ctc." [0 1 2 3 4]]
                             ["bac bbd ata ctc." "bac bba Yca ctc." [0 1 2 3]]
                             ["dtb a at da cdc c." "XZa d at da cdc c." [0 1 2 3 4 5]]
                             ;; a respelled word aligned where that deletes fewer words
                             ["ac d cda." "ac X." [0 1 nil]]]]
    (is (empty? (intent-save body new intent)) (str (pr-str body) " -> " (pr-str new) " " (pr-str (intent-save body new intent))))))

(deftest a-whole-body-save-keeps-every-word-the-diff-keeps-letters-of
  ;; The other eight of those cases. What was meant deletes a word that the
  ;; diff keeps letters of: the rules before the plain rule joined what was
  ;; left of two words into one and deleted the other (`tb ctc` to `ttc`), or
  ;; respelled a word from letters the diff took from its neighbours (`tcad
  ;; b abb` to `atbZ`). That also deleted words with letters left where
  ;; nothing like it was meant (REV2-one-rule G1: `reported prior
  ;; discrimination` to `reportedimination` deleted `reported`). A word goes
  ;; only when all its letters go, so each keeps what the diff left of it, as
  ;; the same change sent as edits does. Pinned with what each word reads.
  (doseq [[body new want] [["tcad b abb d bc." "atbZ d bc." ["at" "bZ" nil "d" "bc"]]
                           ["atc cda aaat bdd dtcb t." "atc dda dtcb t." ["atc" "d" nil "da" "dtcb" "t"]]
                           ["dbdt tb bd dtt." "dbdt tZt." ["dbdt" "tZ" nil "t"]]
                           ["dcb dbad cdd cc tbtc adba ad." "dcb dbad cdd tdba ad." ["dcb" "dbad" "cdd" nil "t" "dba" "ad"]]
                           ["ata bcac dbbb tctb d a." "aca tctb d a." ["a" "ca" nil "tctb" "d" "a"]]
                           ["cb b cdb tddb c cbb bcb." "cb b cdb tddb c cXc." ["cb" "b" "cdb" "tddb" "c" "cX" "c"]]
                           ["dd tb ctc c." "dd ttc c." ["dd" "t" "tc" "c"]]
                           ["b d d tdca bcb." "b ddca bcb." ["b" "d" nil "dca" "bcb"]]]]
    (let [spans (let [m (re-matcher #"[^ .]+" body)] (loop [out []] (if (.find m) (recur (conj out [(.start m) (.end m)])) out)))
          tokens (into [{:token/id :s :token/layer :s :token/begin 0 :token/end (cp/cp-count body)}]
                       (map-indexed (fn [i [b e]] {:token/id i :token/layer :w :token/begin b :token/end e}) spans))
          r (save body new tokens :intent false)
          gone (set (:deleted r))
          by-id (into {} (map (juxt :token/id identity)) (:tokens r))
          got (mapv (fn [i] (when-let [t (and (not (gone i)) (by-id i))] (subs new (:token/begin t) (:token/end t))))
                    (range (count spans)))]
      (is (= new (:text/body (:text r))))
      (is (= want got) (str (pr-str body) " -> " (pr-str new)))
      (is (empty? (survivor-problems body new tokens :intent r)) (str (pr-str body) " -> " (pr-str new))))))

(def ^:private intent-ceiling
  "Cases of `intent-cases` the save reads otherwise than meant, at most. In
  each the text cannot tell: which of two words was deleted and which
  respelled when they share no letter with the new word (`dc d` to `Z`), or
  whether `c d` saved as `cX` respelled `c` or typed `d` over as `X`, and
  a word meant to go that keeps letters the diff leaves it (a word goes only
  when all its letters do, REV2-one-rule, see the test above), or where
  two readings of the diff each delete one word and the meant one is not
  the diff's. 69 of 400 when pinned (2026-10-01). On the reviewer's 200 the rules before the plain
  rule read 78 otherwise, the plain rule before REV-one-rule 37."
  72)

(def ^:private intent-cases 400)

(deftest a-whole-body-save-reads-word-edits-as-meant
  (let [rng (java.util.Random. 31)
        pick #(nth % (.nextInt rng (count %)))
        word (fn [] (apply str (repeatedly (inc (.nextInt rng 4)) #(pick "abcdt"))))
        respell (fn [w] (let [nw (str (apply str (map #(if (< (.nextDouble rng) 0.5) % (pick "abcdtXYZ")) w))
                                      (when (< (.nextDouble rng) 0.3) (pick "XYZ")))]
                          (if (= nw w) (str w "X") nw)))
        fails (atom [])]
    (dotimes [c intent-cases]
      (let [words (vec (repeatedly (+ 3 (.nextInt rng 5)) word))
            n (count words)
            body (str (str/join " " words) ".")
            i (.nextInt rng n)
            new-words (case (pick [:respell+del :respell+del :two-respell :del-run])
                        :respell+del (let [k (inc (.nextInt rng 2))
                                           dels (if (.nextBoolean rng) (range (- i k) i) (range (inc i) (+ i 1 k)))]
                                       (reduce (fn [v j] (if (< -1 j n) (assoc v j nil) v))
                                               (assoc words i (respell (words i))) dels))
                        :two-respell (let [i (if (= i (dec n)) (dec i) i)]
                                       (-> words (update i respell) (update (inc i) respell)))
                        :del-run (reduce #(assoc %1 %2 nil) words (range i (min n (+ i 1 (.nextInt rng 3))))))
            kept (keep-indexed (fn [j w] (when w j)) new-words)]
        (when (seq kept)
          (let [new (str (str/join " " (keep identity new-words)) ".")
                intent (mapv (fn [j] (when (new-words j) (count (filter #(< % j) kept)))) (range n))
                ps (intent-save body new intent)]
            (when (seq ps) (swap! fails conj [body new ps]))))))
    ;; never a word with a letter left deleted, whatever was meant
    (is (empty? (filter (fn [[_ _ ps]] (some #(re-find #"deleted with a letter left" %) ps)) @fails)))
    (when (or (System/getenv "PLAIN_ORACLE_DEBUG") (System/getProperty "plain.oracle.debug"))
      (println "intent fails" (count @fails))
      (doseq [f (take 40 @fails)] (println (pr-str f))))
    (is (<= (count @fails) intent-ceiling) (str (count @fails) " " (pr-str (take 5 @fails))))))
