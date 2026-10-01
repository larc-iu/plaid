(ns plaid.algos.text-edits-test
  "`compose-edits`: the net change of a stream of edits from the caret, and
  where it stands. What the tokens do with it is judged by the oracle in
  `plain-edits-oracle-test`."
  (:require [clojure.data.json :as json]
            [clojure.java.io :as io]
            [clojure.test :refer [deftest is testing]]
            [plaid.algos.text :as ta]))

(defn- ins [i v] {:type :insert :index i :value v})
(defn- del [i n] {:type :delete :index i :value n})
(defn- rep [i n v] {:type :replace :index i :length n :value v})

(deftest composing-keeps-only-the-net-change
  (testing "typing runs merge into one gap"
    (is (= [{:start 3 :end 3 :value "hello"}]
           (ta/compose-edits (map-indexed #(ins (+ 3 %1) (str %2)) "hello") "abc def")))
    (is (= (ta/compose-edits [(ins 3 "hello")] "abc def")
           (ta/compose-edits [(rep 3 0 "hello")] "abc def"))))
  (testing "Backspace then retyping is one replace"
    (is (= [{:start 0 :end 3 :value "dog"}]
           (ta/compose-edits [(del 2 1) (del 1 1) (del 0 1) (ins 0 "d") (ins 1 "o") (ins 2 "g")] "cat sat"))))
  (testing "text typed then deleted in the same run vanishes"
    (is (= [{:start 3 :end 3 :value "a"}] (ta/compose-edits [(ins 3 "abc") (del 4 2)] "the cat")))
    (is (= [] (ta/compose-edits [(ins 3 "abc") (del 3 3)] "the cat"))))
  (testing "a letter deleted and typed back is no change"
    (is (= [] (ta/compose-edits [(del 6 1) (ins 6 "t")] "the cat")))
    (is (= [] (ta/compose-edits [(rep 0 3 "the")] "the cat"))))
  (testing "ops out of position order compose"
    (is (= [{:start 0 :end 0 :value "A "} {:start 4 :end 7 :value "dog"}]
           (ta/compose-edits [(rep 4 3 "dog") (ins 0 "A ")] "the cat"))))
  (testing "a delete over old and typed text"
    (is (= [{:start 2 :end 5 :value ""}] (ta/compose-edits [(ins 3 "xy") (del 2 5)] "the cat"))))
  (testing "astral text and combining marks count one code point each"
    (is (= [{:start 1 :end 2 :value "́"}] (ta/compose-edits [(del 1 1) (ins 1 "́")] "𐌰𐌱𐌲")))
    (is (= [{:start 3 :end 3 :value "𐍂"}] (ta/compose-edits [(ins 3 "𐍂")] "𐌰𐌱𐌲"))))
  (testing "a malformed or out-of-bounds op is a 400"
    (doseq [ops [[(ins 9 "x")] [(del 2 9)] [{:type :insert :index 0}] [{:type "move" :index 0 :value 1}]
                 [(ins 0 "ab") (del 5 1)]]]
      (is (= 400 (:code (ex-data (try (ta/compose-edits ops "abc") (catch clojure.lang.ExceptionInfo e e)))))
          (pr-str ops)))))

(deftest the-composers-of-both-clients-and-the-core-agree
  ;; The fixture the JS and Python clients run too.
  (let [cases (json/read-str (slurp (io/file "../plaid-client-js/test/fixtures/text-edits.json")) :key-fn keyword)]
    (is (< 10 (count cases)))
    (doseq [{:keys [name body ops gaps result]} cases]
      (is (= gaps (ta/compose-edits ops body)) name)
      (is (= result (ta/edit-ops-body ops body)) name)
      (is (= result (ta/edit-ops-body (ta/gap-ops gaps) body)) name))))

(defn- words [s]
  (let [m (re-matcher #"\S+" s)]
    (loop [i 0 out []]
      (if (.find m) (recur (inc i) (conj out {:token/id i :token/layer :w :token/begin (.start m) :token/end (.end m)})) out))))

(defn- typed [old ops]
  (let [tokens (words old)
        r (ta/plain-edits old tokens ops #{} #{:w})
        body (:text/body (:text r))]
    [body (->> (:tokens r) (sort-by :token/begin) (mapv (fn [{:token/keys [id begin end]}] [id (subs body begin end)])))]))

(deftest an-edit-at-the-caret-stands-where-it-was-made
  (testing "a delete between two words of one spelling takes the one the caret was at"
    ;; the whole-body diff of `the cat cat` to `the cat` cannot tell them apart
    (is (= ["the cat" [[0 "the"] [2 "cat"]]] (typed "the cat cat" [(del 4 4)])))
    (is (= ["the cat" [[0 "the"] [1 "cat"]]] (typed "the cat cat" [(del 7 4)]))))
  (testing "Backspace over the space alone keeps both words"
    (is (= ["bb bbbb bb" [[0 "bb"] [1 "bb"] [2 "bb"] [3 "bb"]]] (typed "bb bb bb bb" [(del 5 1)]))))
  (testing "letters typed at a word's end join it"
    (is (= ["cats sat" [[0 "cats"] [1 "sat"]]] (typed "cat sat" [(ins 3 "s")]))))
  (testing "a word selected and typed over keeps its token"
    (is (= ["dog sat" [[0 "dog"] [1 "sat"]]] (typed "cat sat" [(rep 0 3 "dog")])))))

(deftest composing-many-ops-costs-what-they-move
  ;; A long paste sent as one op per word, and the same typed a letter at a
  ;; time: 40 s at 16k ops when each op walked the whole text.
  (let [old (apply str (repeat 20000 "ab "))
        per-word (vec (for [i (range 20000)] (ins (+ (* 3 i) (* 2 i)) "xy")))
        t0 (System/nanoTime)
        gaps (ta/compose-edits per-word old)
        ms (/ (- (System/nanoTime) t0) 1e6)]
    (is (= 20000 (count gaps)))
    (is (= (ta/edit-ops-body per-word old) (ta/edit-ops-body (ta/gap-ops gaps) old)))
    (is (< ms 5000) (str ms " ms"))))
