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
    (is (= ["dog sat" [[0 "dog"] [1 "sat"]]] (typed "cat sat" [(rep 0 3 "dog")])))))

(deftest a-typed-over-stretch-is-read-inside-itself
  ;; `sat tat` typed over as `tX` deletes `sat ` and respells `tat`: the
  ;; whole-body save's reading (` sat` deleted) is put back at the equal place
  ;; inside the selection, and an insert just before the selection changes
  ;; nothing about it.
  (let [old "kai sat tat\n"
        tokens (words old)
        free (ta/apply-edits old tokens [(rep 4 7 "tX")] {:partitioning #{} :word-layers #{:w}})
        beside (ta/apply-edits old tokens [(rep 4 7 "tX") (ins 3 "Q")] {:partitioning #{} :word-layers #{:w}})
        extents (fn [r] (sort (map (juxt :token/id :token/begin :token/end) (:tokens r))))]
    (is (= "kai tX\n" (:text/body (:text free))))
    (is (= [[0 0 3] [2 4 6]] (extents free)))
    (is (= "kaiQ tX\n" (:text/body (:text beside))))
    (is (= [[0 0 3] [2 5 7]] (extents beside)))))

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

(deftest a-word-fixed-at-two-carets-is-one-change-of-it
  ;; R8: a transposition fixed at two carets keeps the whole word, as the
  ;; whole-body save did
  (is (= ["a the cat" [[0 "a"] [1 "the"] [2 "cat"]]] (typed "a teh cat" [(del 3 1) (ins 4 "e")])))
  (is (= ["a danced x" [[0 "a"] [1 "danced"] [2 "x"]]] (typed "a dancde x" [(del 6 1) (ins 7 "d")])))
  ;; a letter deleted inside and one typed at the end
  (is (= ["a mtX" [[0 "a"] [1 "mtX"]]] (typed "a mat" [(del 3 1) (ins 4 "X")])))
  ;; R2: a space typed with another change earlier in the word folds it
  (is (= ["a pmp kin x" [[0 "a"] [1 "pmp"] [2 "x"]]] (typed "a pumpkin x" [(del 3 1) (ins 5 " ")])))
  (is (= ["a pXump kin x" [[0 "a"] [1 "pXump"] [2 "x"]]] (typed "a pumpkin x" [(ins 6 " ") (ins 3 "X")]))))

(deftest a-space-typed-in-a-one-morpheme-word-with-another-change-drops-the-morpheme
  ;; R2 with segmentsParent: Luke's ruling holds for any mix of edits in the word
  (let [old "a pumpkin x"
        r (ta/apply-edits old (one-morpheme old) [(del 3 1) (ins 5 " ")] {:partitioning #{} :word-layers #{:w} :segments #{:m}})]
    (is (= "a pmp kin x" (:text/body (:text r))))
    (is (some #{[:m 1]} (:deleted r)))))

(deftest a-selection-typed-over-changes-no-token-outside-it
  ;; R3: `ab b` of `a ab ab b` selected and typed over as `bd` leaves the
  ;; first `ab` alone
  (is (= ["a ab bd" [[0 "a"] [1 "ab"]]]
         (update (typed "a ab ab b" [(rep 5 4 "bd")]) 1 #(filterv (fn [[id]] (#{0 1} id)) %))))
  ;; and over random selections of repeated words: every word apart from the
  ;; selection keeps its place and length
  (let [rng (java.util.Random. 7)
        vocab ["a" "ab" "ba" "big" "bag" "dog" "do" "g" "bb" "b"]
        pick #(nth % (.nextInt rng (count %)))]
    (dotimes [_ 5000]
      (let [old (clojure.string/join " " (repeatedly (+ 3 (.nextInt rng 5)) #(pick vocab)))
            n (count old)
            s (.nextInt rng n)
            e (+ s 1 (.nextInt rng (min 8 (- n s))))
            v (apply str (repeatedly (inc (.nextInt rng 5)) #(pick ["a" "b" " " "g" "o" "d"])))
            tokens (words old)
            r (ta/apply-edits old tokens [(rep s (- e s) v)] {:partitioning #{} :word-layers #{:w}})
            after (into {} (map (juxt :token/id identity)) (:tokens r))
            shift (- (count v) (- e s))]
        (doseq [{:token/keys [id begin end]} tokens :when (or (< end s) (> begin e))
                :let [t (after id)
                      want (if (> begin e) [(+ begin shift) (+ end shift)] [begin end])]]
          (is (= want [(:token/begin t) (:token/end t)]) (pr-str old s e v)))))))

(deftest a-space-typed-in-the-first-word-of-a-sentence-leaves-no-word-over-it
  ;; R9: the second half cannot take the word (text in front of it would go to
  ;; the sentence before), so the first does
  (let [old "x. cow y"
        tokens (conj (words old)
                     {:token/id :s1 :token/layer :s :token/begin 0 :token/end 3}
                     {:token/id :s2 :token/layer :s :token/begin 3 :token/end 8})
        r (ta/apply-edits old tokens [(ins 4 " ")] {:partitioning #{:s} :word-layers #{:w}})
        body (:text/body (:text r))
        by-id (into {} (map (juxt :token/id #(subs body (:token/begin %) (:token/end %)))) (:tokens r))]
    (is (= "x. c ow y" body))
    (is (= "c" (by-id 1)))
    (is (= "c ow y" (by-id :s2)))))

(deftest a-new-word-or-a-comma-typed-at-a-words-edge-with-a-typo-fix-stays-outside-it
  ;; N1: a letter deleted inside `walkd` and `slowly ` typed in front keeps
  ;; the word's morpheme and gloss, as the whole-body save does
  (let [old "the man walkd to"
        edit (fn [ops] (let [r (ta/apply-edits old (one-morpheme old) ops {:partitioning #{} :word-layers #{:w} :segments #{:m}})
                             body (:text/body (:text r))]
                         [body (->> (:tokens r) (sort-by (juxt :token/begin (comp str :token/id)))
                                    (mapv (fn [{:token/keys [id begin end]}] [id (subs body begin end)])))]))]
    (is (= ["the man slowly wlkd to" [[0 "the"] [[:m 0] "the"] [1 "man"] [[:m 1] "man"]
                                      [2 "wlkd"] [[:m 2] "wlkd"] [3 "to"] [[:m 3] "to"]]]
           (edit [(del 9 1) (ins 8 "slowly ")])))
    (is (= ["the man walked home to" [[0 "the"] [[:m 0] "the"] [1 "man"] [[:m 1] "man"]
                                      [2 "walked"] [[:m 2] "walked"] [3 "to"] [[:m 3] "to"]]]
           (edit [(ins 12 "e") (ins 14 " home")])))
    ;; N2: a comma typed after it stays outside the word and its morpheme
    (is (= ["the man walked, to" [[0 "the"] [[:m 0] "the"] [1 "man"] [[:m 1] "man"]
                                  [2 "walked"] [[:m 2] "walked"] [3 "to"] [[:m 3] "to"]]]
           (edit [(ins 12 "e") (ins 14 ",")])))))
