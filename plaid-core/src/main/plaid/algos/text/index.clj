(ns plaid.algos.text.index
  "Positions looked up for the text rules: the binary searches over sorted
  offsets, and tokens by position.")

(defn lower-bound
  "The first index of `xs`, in ascending order, whose value is at least
  `x`, or the length of `xs` when none is."
  ^long [^longs xs ^long x]
  (loop [a 0 b (alength xs)]
    (if (< a b)
      (let [m (quot (+ a b) 2)]
        (if (< (aget xs m) x) (recur (inc m) b) (recur a m)))
      a)))

(defn upper-bound
  "The first index of `xs`, in ascending order, whose value is above `x`,
  or the length of `xs` when none is."
  ^long [^longs xs ^long x]
  (loop [a 0 b (alength xs)]
    (if (< a b)
      (let [m (quot (+ a b) 2)]
        (if (<= (aget xs m) x) (recur (inc m) b) (recur a m)))
      a)))

(defn begin-index
  "`[begins longest]` for `xs`, sorted by `begin-of`: their begins as a long
  array and the longest extent (`end-of` less `begin-of`). Every one of
  them that ends after position p stands at or after index
  `(lower-bound begins (- p longest))`."
  [xs begin-of end-of]
  [(long-array (map begin-of xs)) (reduce max 0 (map #(- (end-of %) (begin-of %)) xs))])

(defn tokens-near
  "A function of `lo` and `hi` giving the tokens that begin or end within
  [lo, hi]. The others do not change which of an edit's places in that
  stretch is best: one wholly outside is disturbed by none of them, and one
  reaching past both ends is cut by every one of them alike. For more than
  a few `lookups` the tokens are indexed by position first, so a body update
  with many edits over a long text does not scan every token once per edit."
  [tokens lookups]
  (if (< lookups 16)
    (fn [lo hi]
      (filterv (fn [{:token/keys [begin end]}] (or (<= lo begin hi) (<= lo end hi)))
               tokens))
    (let [by-begin (vec (sort-by :token/begin tokens))
          by-end (vec (sort-by :token/end tokens))
          begins (long-array (map :token/begin by-begin))
          ends (long-array (map :token/end by-end))]
      (fn [lo hi]
        (-> []
            (into (subvec by-begin (lower-bound begins lo) (lower-bound begins (inc hi))))
            (into (filter #(< (:token/begin %) lo))
                  (subvec by-end (lower-bound ends lo) (lower-bound ends (inc hi)))))))))
