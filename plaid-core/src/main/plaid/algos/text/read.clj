(ns plaid.algos.text.read
  "What a change to a text's body is read as, in gaps for the plain rule:
  a whole-body save's character diff (`plain-body-gaps`), and the net
  change of an editor's edits (`plain-edit-gaps`)."
  (:require [plaid.algos.text.diff :refer [diff]]
            [plaid.algos.text.index :refer [lower-bound]]
            [plaid.algos.text.ops :refer [compose-edits ops->edits]]
            [plaid.algos.text.plain :refer [save-roles]]))

(defn word-extents
  "The `[begin end]` of each word of `tokens` under `roles` (see
  `layer-roles`), the words being the tokens that decide where typed text
  goes (`save-roles`' `:decides?`), for `plain-edit-gaps`."
  [tokens roles]
  (let [wide (filterv #(< (:token/begin %) (:token/end %)) tokens)
        {:keys [decides?]} (save-roles roles wide)]
    (into [] (comp (filter decides?) (map (juxt :token/begin :token/end))) wide)))

(defn- word-index
  "`words` (`[begin end]`) for the lookups of `trim-gap`: `{:bs :es :most}`,
  begins and ends sorted by begin, and the longest word's length."
  [words]
  (let [ws (vec (sort words))]
    {:bs (long-array (map first ws)) :es (long-array (map second ws))
     :most (reduce max 0 (map (fn [[b e]] (- e b)) ws))}))

(defn- words-over
  "The `[begin end]` of the words of `index` that overlap [x, y) (a point
  when x = y), most recent begin first: those beginning before y, back to
  the longest word's length before x."
  [{:keys [^longs bs ^longs es ^long most]} ^long x ^long y]
  (loop [i (dec (lower-bound bs (max y (inc x)))) out []]
    (if (and (>= i 0) (> (+ (aget bs i) most) x))
      (recur (dec i) (if (> (aget es i) x) (conj out [(aget bs i) (aget es i)]) out))
      out)))

(defn- inside-word
  "Where `x` stands strictly inside a word of `index`, that word, else nil."
  [index x]
  (some (fn [[b e :as w]] (when (< b x e) w)) (words-over index x x)))

(defn- trim-gap
  "`gap` without the text its new value shares with the old at either end,
  or nil when nothing is left of it (Q2: `cat` typed over as `cats` types an
  `s`). A gap over two or more of `words` (sorted `[begin end]`) trims only
  back to a word edge, never into a word, so a word keeps no letters of
  another's (R60: select all of `ab a` and paste `a`, and both words go)."
  [^ints o words {:keys [start end value] :as gap}]
  ;; `words`: see `word-index`
  (let [^ints v (.toArray (.codePoints ^String value))
        n (alength v)
        k (- end start)
        p (loop [p 0] (if (and (< p n) (< p k) (= (aget v p) (aget o (+ start p)))) (recur (inc p)) p))
        s (loop [s 0] (if (and (< s (- n p)) (< s (- k p)) (= (aget v (- n 1 s)) (aget o (- end 1 s))))
                        (recur (inc s))
                        s))
        several? (and (pos? (+ p s)) (< 1 (count (filter (fn [[b e]] (and (< b end) (< start e)))
                                                         (words-over words start end)))))
        ;; back out of a word to its edge, never past the gap's own
        x (if several?
            (loop [x (+ start p)] (let [[b _] (inside-word words x)] (if (and b (< start x)) (recur (max start b)) x)))
            (+ start p))
        y (if several?
            (loop [y (- end s)] (let [[_ e] (inside-word words y)] (if (and e (< y end)) (recur (min end e)) y)))
            (- end s))
        p (- x start)
        s (- end y)]
    (cond
      (and (zero? p) (zero? s)) gap
      (and (= (+ p s) n) (= (+ p s) k)) nil
      :else (assoc gap :start (+ start p) :end (- end s) :value (String. v (int p) (int (- n p s)))))))

(defn- edits->gaps
  "Old-coordinate edits in position order (see `ops->edits`) as gaps: edits
  that touch are one gap."
  [edits]
  (reduce (fn [out e]
            (let [s (or (:start e) (:at e))
                  t (or (:end e) (:at e))
                  v (or (when (string? (:value e)) (:value e)) "")
                  prev (peek out)]
              (if (and prev (= (:end prev) s))
                (conj (pop out) (assoc prev :end t :value (str (:value prev) v)))
                (conj out {:start s :end t :value v}))))
          []
          edits))

(defn plain-body-gaps
  "The gaps a whole-body save of `old` as `new` is taken as: the character
  diff as `diff` places it, edits that touch one gap. Where the diff could
  stand in several places for the same new body, it is not moved to spare
  the tokens: deleting `cat` from `the cat cow` is `at c` deleted, which
  cuts both words. The plain rule then reads the gaps as it reads an
  editor's edits (R42), so an editor sends edits."
  [^String old ^String new]
  (-> (diff old new)
      ops->edits
      edits->gaps))

(defn plain-edit-gaps
  "The gaps an edit of `old` by `ops` from the caret is taken as: its net
  change (see `compose-edits`), each gap less the text its new value shares
  with the old at either end, back to a word edge where the gap is over two
  or more of `words` (the words' `[begin end]`, see `word-extents`, R60). A
  gap that both deletes and types is a delete and an insert at the same
  place, read by the plain rule as every other edit is (R42)."
  [^String old ops words]
  (let [^ints o (.toArray (.codePoints old))
        words (word-index words)]
    (into [] (keep #(trim-gap o words %)) (compose-edits ops old))))
