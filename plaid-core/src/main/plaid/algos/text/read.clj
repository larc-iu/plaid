(ns plaid.algos.text.read
  "What a change to a text's body is read as, in gaps for the plain rule:
  a whole-body save's character diff (`plain-body-gaps`), and the net
  change of an editor's edits (`plain-edit-gaps`)."
  (:require [plaid.algos.text.diff :refer [diff]]
            [plaid.algos.text.ops :refer [compose-edits ops->edits]]))

(defn- trim-gap
  "`gap` without the text its new value shares with the old at either end,
  or nil when nothing is left of it."
  [^ints o {:keys [start end value] :as gap}]
  (let [^ints v (.toArray (.codePoints ^String value))
        n (alength v)
        k (- end start)
        p (loop [p 0] (if (and (< p n) (< p k) (= (aget v p) (aget o (+ start p)))) (recur (inc p)) p))
        s (loop [s 0] (if (and (< s (- n p)) (< s (- k p)) (= (aget v (- n 1 s)) (aget o (- end 1 s))))
                        (recur (inc s))
                        s))]
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
  with the old at either end. A gap that both deletes and types is a delete
  and an insert at the same place, read by the plain rule as every other
  edit is (R42)."
  [^String old ops]
  (let [^ints o (.toArray (.codePoints old))]
    (into [] (keep #(trim-gap o %)) (compose-edits ops old))))
