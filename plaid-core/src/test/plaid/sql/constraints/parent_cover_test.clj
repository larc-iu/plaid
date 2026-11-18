(ns plaid.sql.constraints.parent-cover-test
  "The nesting check of a bulk create (SCL5-1): whether a parent-layer token
  contains each child, asked of one read of the parent layer. It scanned
  every parent for every child, 21 s for the 42,000 morphemes of a
  20,000-word document under the write lock. It must give the answer the
  plain definition gives, and take time near linear in the tokens."
  (:require [clojure.test :refer [deftest is testing]]
            [plaid.sql.constraints.token]))

(def ^:private parent-cover @#'plaid.sql.constraints.token/parent-cover)

(defn- tok [b e] {:token/begin b :token/end e})

(defn- covered-by-definition? [parents b e]
  (boolean (some #(and (<= (:token/begin %) b) (>= (:token/end %) e)) parents)))

(deftest the-cover-agrees-with-the-definition
  (let [rnd (java.util.Random. 42)]
    (dotimes [_ 300]
      (let [parents (vec (repeatedly (.nextInt rnd 12)
                                     #(let [b (.nextInt rnd 40)] (tok b (+ b (.nextInt rnd 15))))))
            covered? (parent-cover parents)]
        (dotimes [_ 30]
          (let [b (.nextInt rnd 50) e (+ b (.nextInt rnd 12))]
            (is (= (covered-by-definition? parents b e) (covered? b e))
                (pr-str parents b e))))))))

(deftest edges
  (let [covered? (parent-cover [(tok 0 5) (tok 5 10) (tok 3 4)])]
    (testing "a child equal to its parent, and at either edge"
      (is (covered? 0 5)) (is (covered? 5 10)) (is (covered? 9 10)) (is (covered? 0 1)))
    (testing "across two parents, or past the last"
      (is (not (covered? 4 6))) (is (not (covered? 9 11))) (is (not (covered? -1 1))))
    (testing "no parent at all"
      (is (not ((parent-cover []) 0 1))))))

(deftest a-huge-document-s-morphemes-are-checked-in-moments
  ;; 20,000 words and 42,000 morphemes, the shape of the finder's Huge.
  (let [words (mapv #(tok (* 10 %) (+ (* 10 %) 9)) (range 20000))
        morphemes (vec (mapcat (fn [{:token/keys [begin]}] [[begin (+ begin 4)] [(+ begin 4) (+ begin 9)]]) words))
        t0 (System/nanoTime)
        covered? (parent-cover (shuffle words))
        all? (every? (fn [[b e]] (covered? b e)) (concat morphemes morphemes))
        ms (/ (- (System/nanoTime) t0) 1e6)]
    (is all?)
    (is (< ms 2000) (str "took " ms " ms"))))
