(ns glam.common
  "Truly general utils that don't have much to do with application or component logic.")

;; From https://stackoverflow.com/questions/4830900/how-do-i-find-the-index-of-an-item-in-a-vector
(defn indexed
  "Returns a lazy sequence of [index, item] pairs, where items come
  from 's' and indexes count up from zero.

  (indexed '(a b c d))  =>  ([0 a] [1 b] [2 c] [3 d])"
  [s]
  (map vector (iterate inc 0) s))

;; From https://stackoverflow.com/questions/4830900/how-do-i-find-the-index-of-an-item-in-a-vector
(defn positions
  "Returns a lazy sequence containing the positions at which pred
   is true for items in coll."
  [pred coll]
  (for [[idx elt] (indexed coll) :when (pred elt)] idx))

(defn shift
  "Shift an element in xs up or down by one position. Assumes that
  xs is a vector and that x is unique inside that vector"
  [xs x up?]
  (assert (vector? xs))
  (let [index (first (positions #(= x %) xs))
        new-index (if up?
                    (max (dec index) 0)
                    (min (inc index) (- (count xs) 1)))]
    (if (= new-index index)
      xs
      (let [x' (clojure.core/get xs new-index)
            left (take (min index new-index) xs)
            right (drop (inc (max index new-index)) xs)]
        (reduce into [] [left
                         (if up? [x' x] [x x'])
                         right])))))
