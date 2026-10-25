(ns plaid.algos.plain-edits-oracle
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
  There are no exemptions.

  This namespace holds the generators and the judge. The tests that run
  them are `plaid.algos.plain-edits-oracle-test` and its siblings, split
  so the suite's shards can balance them."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [plaid.algos.text :as ta]
            [plaid.algos.text.chars :as chars]
            [plaid.algos.text-helpers :as th]
            [plaid.util.codepoint :as cp]))

;; ---------------------------------------------------------------- documents

(def vocab
  ["the" "cat" "sat" "on" "a" "mat" "kai" "tat" "köye" "dog" "كتاب" "שלום" "𐌰𐌱𐌲" "café" "你好" "cat," "(ab)"])

;; Spaced words from real FLEx projects (lamkang, manipuri).
(def phrases
  ["talu lei" "pang khuu" "thee da" "thung ki" "ava ngi" "thungbi ngu" "ə́múk   su"])

(def typed
  ["Q" "XZ" "Ж𐍂" " " "  " "Q R" "Q " " Q" "XZ XZ XZ" "\n" "Q\nR" "ǃ" "," "-"])

(defn cps [^String s] (.toArray (.codePoints s)))

(defn gen-doc
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
            ;; a row over the whole sentence, its whitespace included, as
            ;; a script or an import may make one (REV2-TEXT-1)
            (when (:sentence-rows opts)
              (conj! toks {:token/id [:rw si] :token/layer :rw :token/begin sb0 :token/end e}))
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
       :tokens (mapv #(if (#{[:s (dec nsent)] [:rw (dec nsent)]} (:token/id %))
                        (assoc % :token/end n) %)
                     tokens)})))

(defn gen-gaps
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

(defn keystrokes
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

(defn ws? [c] (or (Character/isWhitespace (int c)) (Character/isSpaceChar (int c))))

(defn punct?
  "Whether code point `c` is neither a letter, a mark nor a number."
  [c]
  (not (re-find #"[\p{L}\p{M}\p{N}]" (String. (Character/toChars (int c))))))

(defn gap-fill
  "The sentences as `compensate-partition-layers!` leaves them."
  [sents n]
  (let [sorted (vec (sort-by :token/begin sents))
        k (count sorted)]
    (vec (map-indexed (fn [i t]
                        (cond-> t
                          (zero? i) (assoc :token/begin 0)
                          true (assoc :token/end (if (= i (dec k)) n (max (:token/end t) (:token/begin (sorted (inc i))))))))
                      sorted))))

(defn trim-ws [^ints cs [b e]]
  (let [b (loop [x b] (if (and (< x e) (ws? (aget cs x))) (recur (inc x)) x))
        e (loop [x e] (if (and (> x b) (ws? (aget cs (dec x)))) (recur (dec x)) x))]
    [b e]))

(defn problems
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
                           (let [k (aget oldpos p)] (or (< k begin) (>= k end)))
                           ;; a sentence typed ahead of, past whitespace, begins
                           ;; at the typed text and takes the whitespace between
                           ;; (Luke, 2026-10-15)
                           (not (let [k (aget oldpos p)]
                                  (and (= :s layer) (< k begin)
                                       (every? #(ws? (aget o %)) (range k begin))
                                       (some (fn [{a :start b :end}] (and (= a b) (<= a k))) gaps)))))
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
      ;; a new letter joined to a word's letters is in a word, but for a
      ;; word made only of punctuation, which takes no text typed against
      ;; it (REV7-IGT-1)
      (let [word-at (let [a (boolean-array (alength nw))]
                      (doseq [t (vals by-id) :when (and (= wl (:token/layer t)) (not (gone (:token/id t))))
                              p (range (:token/begin t) (:token/end t))]
                        (aset a p true))
                      a)
            word-letter (let [a (boolean-array (alength nw))]
                          (doseq [t tokens :when (and (= wl (:token/layer t)) (not (gone (:token/id t)))
                                                      (not (every? #(chars/punct? #{} (aget o %)) (range (:token/begin t) (:token/end t)))))
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
                                              (or (some #(and (= (:start g) (:token/begin %)) (= (:end g) (:token/end %))
                                                              (< (:start g) (:end g)))
                                                        tokens)
                                                  ;; typed where two sentences meet with
                                                  ;; punctuation and no whitespace, it goes to the one
                                                  ;; after, and its letters before its
                                                  ;; whitespace to no word (Luke, 2026-10-15)
                                                  (let [a (:start g)]
                                                    (and (= a (:end g)) (pos? a) (< a (alength o))
                                                         (not (ws? (aget o (dec a)))) (not (ws? (aget o a)))
                                                         (punct? (aget o (dec a)))
                                                         (some #(and (= :s (:token/layer %)) (= a (:token/begin %))) tokens)))))))
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
      (doseq [layer [:w :a :s :ms :rw]]
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

(def layouts
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
          {:id :rw :overlap-mode "non-overlapping"}
          {:id :u :overlap-mode "any"}]
   ;; the same with the layer under the words that holds several tokens as
   ;; long as a word marked as ud's syntactic words, whose multi-word tokens
   ;; a typed space deals out one word to each part (FX6-SPLIT)
   :apps-dealt [{:id :s :overlap-mode "partitioning"}
                {:id :w :overlap-mode "non-overlapping" :parent :s}
                {:id :m :overlap-mode "any" :parent :w :role "syntactic-word"}
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

(defn layout-tokens
  "`tokens` less those on layers `layout` has none of."
  [layout tokens]
  (let [ids (into #{} (map :id) (layouts layout))]
    (filterv #(ids (:token/layer %)) tokens)))

(defn roles [layout split?]
  (cond-> (ta/layer-roles (layouts layout)) split? (assoc :split-on-space true)))

(defn run
  "What a save of `ops` from the caret does, the layers as `layout` has them."
  ([old tokens ops] (run old tokens ops :apps false))
  ([old tokens ops layout split?]
   (let [{:keys [partitioning deciders] :as r} (roles layout split?)]
     (th/plain-edits old tokens ops partitioning deciders (select-keys r [:split-on-space :children :dealt :exclusive :head-layers])))))

(defn exact
  "What `ops` do taken exactly as made: each net gap less the text it shares
  with the old at either end, read by the plain rule (REV2-F-TEXT-CORE X)."
  [^String old tokens ops layout]
  (let [{:keys [partitioning deciders] :as r} (roles layout false)
        o (cps old)]
    (ta/apply-plain-gaps old tokens (vec (keep #(#'ta/trim-gap o %) (ta/compose-edits ops old)))
                         partitioning deciders
                         (select-keys r [:split-on-space :children :dealt :exclusive :head-layers]))))

(defn lost-problems
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

(defn letters-left-problems
  "The words and sentences `r` deletes though an old letter of theirs, not
  whitespace, lies outside every net gap of `ops` (Luke: a word goes only
  when all its letters do)."
  [^String old tokens ops r]
  (let [o (cps old)
        in-gap (let [a (boolean-array (alength o))]
                 (doseq [{:keys [start end]} (ta/compose-edits ops old), i (range start end)] (aset a i true))
                 a)
        gone (set (:deleted r))]
    (into [] (keep (fn [{:token/keys [id layer begin end]}]
                     (when (and (#{:w :s} layer) (gone id) (< begin end)
                                (some #(and (not (aget in-gap %)) (not (ws? (aget o %)))) (range begin end)))
                       (str id " deleted with a letter left outside the change " (pr-str (cp/cp-subs old begin end))))))
          tokens)))

(declare server-gaps)

(defn edit-loss-problems
  "An edit never deletes a word or sentence with a letter left outside the
  change, and where the server took each gap as made (no gap read as a
  whole-body save reads it, see `plaid.algos.text/plain-edit-gaps`), none
  the edit as made keeps (REV3-F-TEXT-CORE G3)."
  [^String old tokens ops layout r]
  (let [o (cps old)
        as-made (vec (keep #(#'ta/trim-gap o %) (ta/compose-edits ops old)))]
    (cond-> (letters-left-problems old tokens ops r)
      (= as-made (server-gaps old tokens ops layout))
      (into (lost-problems old tokens r (exact old tokens ops layout))))))

(defn server-gaps
  "The gaps an edit by `ops` is taken as, the layers as `layout` has them."
  [old tokens ops layout]
  (let [{:keys [partitioning deciders] :as r} (roles layout false)]
    (ta/plain-edit-gaps old ops tokens partitioning deciders (select-keys r [:split-on-space :children :dealt :exclusive :head-layers]))))

(defn save-read
  "`[gaps result]` of a whole-body save of `new`, the layers as `layout` has
  them (see `plain-body-read`)."
  [old new tokens layout split?]
  (let [{:keys [partitioning deciders] :as r} (roles layout split?)]
    (ta/plain-body-read old new tokens partitioning deciders (select-keys r [:split-on-space :children :dealt :exclusive :head-layers]))))

(defn save
  "What a whole-body save of `new` does, the layers as `layout` has them."
  ([old new tokens] (save old new tokens :apps false))
  ([old new tokens layout split?] (second (save-read old new tokens layout split?))))

(def nbsp "\u00a0")

(def configs
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

(def cases-per-config 1500)

;; ---------------------------------------------------------------- the whole-body judge

(defn lcs-length
  "The length of a longest common subsequence of `o` and `n`, code points,
  where no position `i` of `o` with `(barred i)` may be matched. Its own
  dynamic program, independent of `plaid.algos.text`."
  [^ints o ^ints n ^booleans barred]
  (let [m (alength n)
        prev (int-array (inc m))
        cur (int-array (inc m))]
    (dotimes [i (alength o)]
      (let [c (aget o i) bar (aget barred i)]
        (dotimes [j m]
          (aset cur (inc j) (int (if (and (not bar) (= c (aget n j)))
                                   (inc (aget prev j))
                                   (max (aget prev (inc j)) (aget cur j))))))
        (System/arraycopy cur 0 prev 0 (inc m))))
    (aget prev m)))

(defn survivor-problems
  "The tokens a whole-body save of `old` as `new` deleted though every
  shortest diff of the two keeps a letter of theirs (whitespace aside):
  barring the token's letters from the longest common subsequence makes it
  shorter. A word goes only when all its letters can go (REV2-one-rule
  G1). The diff is this test's own, not the reading under test (R1-DEBT-22),
  so where the diff can stand in several places (`the a ab` to `the aX`)
  either word may go. A token inside a word the save kept, read as that
  word typed over (`cow`, `co` + `w`, to `abc`, F4), may go."
  [^String old ^String new tokens layout r]
  (let [{:keys [partitioning deciders]} (roles layout false)
        o (cps old)
        nw (cps new)
        full (lcs-length o nw (boolean-array (alength o)))
        left? (fn [b e] (let [barred (boolean-array (alength o))]
                          (doseq [i (range b e) :when (not (ws? (aget o i)))] (aset barred i true))
                          (< (lcs-length o nw barred) full)))
        gone (set (:deleted r))
        words (if (seq deciders) (filter #(deciders (:token/layer %)) tokens)
                  (remove #(partitioning (:token/layer %)) tokens))
        kept-word? (fn [{:token/keys [id begin end]}]
                     (some #(and (not= id (:token/id %)) (not (gone (:token/id %)))
                                 (<= (:token/begin %) begin) (<= end (:token/end %)))
                           words))]
    (into [] (keep (fn [{:token/keys [id begin end] :as t}]
                     (when (and (gone id) (< begin end)
                                (not (kept-word? t))
                                (left? begin end))
                       (str id " deleted with a letter left " (pr-str (cp/cp-subs old begin end))))))
          tokens)))

