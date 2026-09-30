(ns plaid.algos.text-edits-test
  "`compose-edits` and `plan-edits`: the net change of a stream of edits
  from the caret, and where it stands. The whole chain is judged by the
  oracle in `text-oracle-test`."
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
        r (ta/apply-edits old tokens ops {:partitioning #{} :word-layers #{:w}})
        body (:text/body (:text r))]
    [body (->> (:tokens r) (sort-by :token/begin) (mapv (fn [{:token/keys [id begin end]}] [id (subs body begin end)])))]))

(deftest an-edit-at-the-caret-stands-where-it-was-made
  (testing "a delete between two words of one spelling takes the one the caret was at"
    ;; the whole-body diff of `the cat cat` to `the cat` cannot tell them apart
    (is (= ["the cat" [[0 "the"] [2 "cat"]]] (typed "the cat cat" [(del 4 4)])))
    (is (= ["the cat" [[0 "the"] [1 "cat"]]] (typed "the cat cat" [(del 7 4)]))))
  (testing "Backspace over the space alone keeps both words (D22, L2)"
    (is (= ["bb bbbb bb" [[0 "bb"] [1 "bb"] [2 "bb"] [3 "bb"]]] (typed "bb bb bb bb" [(del 5 1)]))))
  (testing "letters typed at a word's end stay outside it"
    (is (= ["cats sat" [[0 "cat"] [1 "sat"]]] (typed "cat sat" [(ins 3 "s")]))))
  (testing "a word selected and typed over keeps its token"
    (is (= ["dog sat" [[0 "dog"] [1 "sat"]]] (typed "cat sat" [(rep 0 3 "dog")]))))
  (testing "a letter deleted inside a word and one typed after it are two edits"
    (is (= ["danced x" [[0 "dance"] [1 "x"]]] (typed "dancde x" [(del 4 1) (ins 5 "d")])))))

(deftest a-typed-over-stretch-whose-reading-would-reach-another-edit-stays-one-replace
  ;; `sat tat` typed over as `tX` deletes ` sat` (past the stretch's start)
  ;; and respells `tat`, but an insert just before the stretch leaves no room
  ;; to go past it, and the stretch is one delete and one insert: the text is
  ;; right either way.
  (let [old "kai sat tat\n"
        tokens (words old)
        free (ta/apply-edits old tokens [(rep 4 7 "tX")] {:partitioning #{} :word-layers #{:w}})
        fenced (ta/apply-edits old tokens [(rep 4 7 "tX") (ins 3 "Q")] {:partitioning #{} :word-layers #{:w}})]
    (is (= "kai tX\n" (:text/body (:text free))))
    (is (= "kaiQ tX\n" (:text/body (:text fenced))))
    (is (some #(= 2 (:token/id %)) (:tokens free)))))

(defn- one-morpheme [old]
  (into (words old) (map (fn [{:token/keys [id begin end]}] {:token/id [:m id] :token/layer :m :token/begin begin :token/end end}))
        (words old)))

(deftest a-space-typed-inside-a-one-morpheme-word-drops-the-morpheme
  ;; Luke's ruling (2026-09-30): as inside any morpheme (D28), when the
  ;; morpheme layer declares `segmentsParent`.
  (let [old "hh pumpkin"
        tokens (one-morpheme old)
        view (fn [r] (let [body (:text/body (:text r))]
                       [body (->> (:tokens r) (sort-by (juxt :token/begin (comp str :token/id)))
                                  (mapv (fn [{:token/keys [id begin end]}] [id (subs body begin end)])))]))
        edit (fn [ops segments] (view (ta/apply-edits old tokens ops {:partitioning #{} :word-layers #{:w} :segments segments})))
        body (fn [new segments]
               (view (-> (ta/diff old new)
                         (ta/slide-to-tokens old tokens #{})
                         (ta/normalize-deletes old tokens)
                         (ta/align-to-words old tokens #{:w})
                         (ta/pair-replacements old tokens)
                         (ta/fold-whole-words old tokens #{:w} segments)
                         (ta/apply-text-edits {:text/body old} tokens))))]
    (testing "from the caret"
      (is (= ["hh pum pkin" [[0 "hh"] [[:m 0] "hh"] [1 "pkin"]]] (edit [(ins 6 " ")] #{:m})))
      ;; a respelling inside it keeps it
      (is (= ["hh bumpkin" [[0 "hh"] [[:m 0] "hh"] [1 "bumpkin"] [[:m 1] "bumpkin"]]] (edit [(rep 3 1 "b")] #{:m})))
      ;; a layer that does not declare it: the token moves with the word, as a ud syntactic word
      (is (= ["hh pum pkin" [[0 "hh"] [[:m 0] "hh"] [1 "pkin"] [[:m 1] "pkin"]]] (edit [(ins 6 " ")] nil))))
    (testing "in a whole body"
      (is (= ["hh pum pkin" [[0 "hh"] [[:m 0] "hh"] [1 "pkin"]]] (body "hh pum pkin" #{:m}))))))
