(ns plaid.algos.text.index
  "Positions looked up for the text rules: the binary searches over sorted
  offsets.")

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
