(ns plaid.algos.plain-edits-test
  "Every token layer takes a text edit the plain way (Luke, 2026-09-30: \"if
  something lands within a word boundary grow the word, period\", and
  2026-10-01: one rule set for every layer). Examples here, the property in
  `plain-edits-oracle-test`."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [plaid.algos.text :as ta]
            [plaid.util.codepoint :as cp]))

(defn- ins [i v] {:type :insert :index i :value v})
(defn- del [i n] {:type :delete :index i :value n})
(defn- rep [i n v] {:type :replace :index i :length n :value v})

(defn- doc
  "Tokens for `s` with words split at `|` (so a word may hold a space) and
  sentences at `/`: a word token `[:w i]` and a morpheme `[:m i]` over the
  whole word, and one sentence token per sentence."
  [s]
  (let [body (.replace (.replace ^String s "|" "") "/" "")
        ;; walk the marked string
        [words sents] (loop [i 0 at 0 wb nil ws [] sb 0 ss []]
                        (if (>= i (count s))
                          [ws (conj ss [sb at])]
                          (let [c (.charAt ^String s i)]
                            (case c
                              \| (if wb
                                   (recur (inc i) at nil (conj ws [wb at]) sb ss)
                                   (recur (inc i) at at ws sb ss))
                              \/ (recur (inc i) at wb ws at (conj ss [sb at]))
                              (recur (inc i) (inc at) wb ws sb ss)))))]
    {:body body
     :tokens (-> []
                 (into (map-indexed (fn [i [b e]] {:token/id [:s i] :token/layer :s :token/begin b :token/end e}) sents))
                 (into (mapcat (fn [i [b e]]
                                 [{:token/id [:w i] :token/layer :w :token/begin b :token/end e}
                                  {:token/id [:m i] :token/layer :m :token/begin b :token/end e}])
                               (range) words)))}))

(defn- view
  "The body and each word's text by index, `nil` for a deleted word, after
  `r`, checking that every morpheme stayed on its word."
  [{:keys [text tokens deleted]} n]
  (let [body (:text/body text)
        by-id (into {} (map (juxt :token/id identity)) tokens)
        gone (set deleted)]
    (doseq [i (range n)]
      (is (= (contains? gone [:w i]) (contains? gone [:m i])) (str "word and morpheme " i " go together"))
      (when-let [w (by-id [:w i])]
        (is (= [(:token/begin w) (:token/end w)] ((juxt :token/begin :token/end) (by-id [:m i])))
            (str "morpheme " i " spans its word"))))
    (into [body] (map (fn [i] (when-let [{:token/keys [begin end]} (by-id [:w i])]
                                (cp/cp-subs body begin end)))
                      (range n)))))

(defn- edit [s ops]
  (let [{:keys [body tokens]} (doc s)]
    (view (ta/plain-edits body tokens ops #{:s} #{:w} {:children #{:m}}) (count (filter #(= :w (:token/layer %)) tokens)))))

(defn- save [s new]
  (let [{:keys [body tokens]} (doc s)]
    (view (ta/plain-body body new tokens #{:s} #{:w} {:children #{:m}}) (count (filter #(= :w (:token/layer %)) tokens)))))

(deftest an-edit-inside-a-word-or-at-its-edge-grows-it
  (testing "inside"
    (is (= ["the caat" "the" "caat"] (edit "|the| |cat|" [(ins 6 "a")])))
    (is (= ["the ct" "the" "ct"] (edit "|the| |cat|" [(del 5 1)])))
    (is (= ["the cQt" "the" "cQt"] (edit "|the| |cat|" [(rep 5 1 "Q")]))))
  (testing "letters typed at a word's end or start"
    (is (= ["the cats" "the" "cats"] (edit "|the| |cat|" [(ins 7 "s")])))
    (is (= ["the scat" "the" "scat"] (edit "|the| |cat|" [(ins 4 "s")])))
    (is (= ["the cat," "the" "cat,"] (edit "|the| |cat|" [(ins 7 ",")]))))
  (testing "a word replaced whole keeps its token"
    (is (= ["the dog" "the" "dog"] (edit "|the| |cat|" [(rep 4 3 "dog")])))
    (is (= ["the dog" "the" "dog"] (edit "|the| |cat|" [(del 4 3) (ins 4 "dog")])))))

(deftest a-typed-space-never-splits-a-word
  (is (= ["the c at" "the" "c at"] (edit "|the| |cat|" [(ins 5 " ")])))
  (is (= ["the c xy at" "the" "c xy at"] (edit "|the| |cat|" [(ins 5 " xy ")])))
  (testing "a word holding a space"
    (is (= ["talu lei x" "talu lei" "x"] (edit "|talu lei| |x|" [])))
    (is (= ["t alu lei x" "t alu lei" "x"] (edit "|talu lei| |x|" [(ins 1 " ")])))
    (is (= ["talulei x" "talulei" "x"] (edit "|talu lei| |x|" [(del 4 1)])))
    (is (= ["talu new lei x" "talu new lei" "x"] (edit "|talu lei| |x|" [(ins 4 " new")])))))

(deftest a-deleted-space-never-joins-two-words
  (is (= ["thecat" "the" "cat"] (edit "|the| |cat|" [(del 3 1)])))
  (testing "text typed where they meet goes to the first"
    (is (= ["thexcat" "thex" "cat"] (edit "|the| |cat|" [(del 3 1) (ins 3 "x")])))
    (is (= ["thex ycat" "thex" "ycat"] (edit "|the| |cat|" [(rep 3 1 "x y")])))))

(deftest new-text-apart-from-every-word-is-in-none
  (is (= ["the big cat" "the" "cat"] (edit "|the| |cat|" [(ins 4 "big ")])))
  (is (= ["the cat big" "the" "cat"] (edit "|the| |cat|" [(ins 7 " big")])))
  (testing "the letters touching a word go to it, the rest to none"
    (is (= ["the catx big" "the" "catx"] (edit "|the| |cat|" [(ins 7 "x big")])))
    (is (= ["the big xcat" "the" "xcat"] (edit "|the| |cat|" [(ins 4 "big x")])))))

(deftest only-a-word-whose-text-is-all-deleted-goes
  (is (= ["the " "the" nil] (edit "|the| |cat|" [(del 4 3)])))
  (is (= ["cat" nil "cat"] (edit "|the| |cat|" [(del 0 4)])))
  (testing "a stretch over two words leaves both with the letters they keep"
    (is (= ["tht" "th" "t"] (edit "|the| |cat|" [(del 2 4)])))
    (is (= ["thQt" "thQ" "t"] (edit "|the| |cat|" [(rep 2 4 "Q")]))))
  (testing "a word inside a stretch typed over goes"
    (is (= ["a birdog" "a" nil "birdog"] (edit "|a| |cat| |dog|" [(rep 2 5 "bird")]))))
  (testing "a word replaced by whitespace goes"
    (is (= ["the   dog" "the" nil "dog"] (edit "|the| |cat| |dog|" [(rep 4 3 " ")])))))

(deftest whitespace-typed-at-a-word-edge-stays-outside
  (is (= ["the  cat" "the" "cat"] (edit "|the| |cat|" [(rep 4 1 " c")])))
  (is (= ["the ca " "the" "ca"] (edit "|the| |cat|" [(rep 6 1 " ")]))))

(deftest partitions-follow-the-words
  (let [{:keys [body tokens]} (doc "|Hi.| /|Bye.|")
        r (ta/plain-edits body tokens [(ins 4 "x")] #{:s} #{:w})
        at (fn [id] (let [t (some #(when (= id (:token/id %)) %) (:tokens r))] [(:token/begin t) (:token/end t)]))]
    (is (= "Hi. xBye." (:text/body (:text r))))
    (is (= [4 9] (at [:w 1]) (at [:s 1])))
    (is (= [0 4] (at [:s 0])))))

(deftest a-whole-body-save-takes-the-same-rules
  (is (= ["the cats" "the" "cats"] (save "|the| |cat|" "the cats")))
  (is (= ["the c at" "the" "c at"] (save "|the| |cat|" "the c at")))
  (is (= ["thecat" "the" "cat"] (save "|the| |cat|" "thecat")))
  (is (= ["the dog" "the" "dog"] (save "|the| |cat|" "the dog")))
  (is (= ["the cow" "the" nil "cow"] (save "|the| |cat| |cow|" "the cow")))
  (is (= ["the bat sat in" "the" "bat" "sat" "in"] (save "|the| |cat| |sat| |on|" "the bat sat in")))
  (is (= ["talu new lei x" "talu new lei" "x"] (save "|talu lei| |x|" "talu new lei x"))))

(deftest words-written-together-each-keep-what-is-typed-inside-them
  (is (= ["caxdog" "cax" "dog"] (edit "|cat||dog|" [(rep 2 1 "x")])))
  (is (= ["catxog" "cat" "xog"] (edit "|cat||dog|" [(rep 3 1 "x")])))
  (is (= ["caxdog" "cax" "dog"] (edit "|cat||dog|" [(ins 3 "x") (del 2 1)])))
  (testing "text typed with a space where they meet is shared out"
    (is (= ["cax ydog" "cax" "ydog"] (edit "|cat||dog|" [(rep 2 1 "x y")])))))

(deftest a-sentence-keeps-to-the-words-edges
  ;; `a ` typed over as words of its own is read as a whole-body save reads
  ;; it (REV-F-TEXT-CORE): `a` typed over as the first `XZ`, which keeps its
  ;; token in its sentence, and the rest typed before `dog`, the letters
  ;; against it going with it into the next sentence
  (let [{:keys [body tokens]} (doc "|köye| |a| /|dog|")
        r (ta/plain-edits body tokens [(rep 5 2 "XZ XZ XZ")] #{:s} #{:w})
        at (fn [id] (let [t (some #(when (= id (:token/id %)) %) (:tokens r))] [(:token/begin t) (:token/end t)]))]
    (is (= "köye XZ XZ XZdog" (:text/body (:text r))))
    (is (= [5 7] (at [:w 1])))
    (is (= [11 16] (at [:w 2])))
    (is (= [8 16] (at [:s 1])))
    (is (= [0 8] (at [:s 0])))))

(deftest a-sentence-or-a-segment-typed-over-exactly-keeps-its-token
  ;; L1: `kai\n` (all of sentence 1) typed over as `-`, which touches `dog`
  (let [{:keys [body tokens]} (doc "|kai|\n/|dog| |cat|")
        r (ta/plain-edits body tokens [(rep 0 4 "-")] #{:s} #{:w})
        at (fn [id] (some #(when (= id (:token/id %)) [(:token/begin %) (:token/end %)]) (:tokens r)))]
    (is (= "-dog cat" (:text/body (:text r))))
    (is (= [0 1] (at [:s 0])))
    (is (= [1 8] (at [:s 1])))
    (is (= [1 4] (at [:w 1])))
    (is (nil? (at [:w 0]))))
  ;; a segment glued to the next one, typed over whole
  (let [tokens [{:token/id :s :token/layer :s :token/begin 0 :token/end 7}
                {:token/id :w1 :token/layer :w :token/begin 0 :token/end 2}
                {:token/id :w2 :token/layer :w :token/begin 2 :token/end 4}
                {:token/id :w3 :token/layer :w :token/begin 5 :token/end 7}
                {:token/id :a1 :token/layer :a :token/begin 0 :token/end 2}
                {:token/id :a2 :token/layer :a :token/begin 2 :token/end 7}]
        r (ta/plain-edits "abcd ef" tokens [(rep 2 5 "xy")] #{:s} #{:w})
        at (fn [id] (some #(when (= id (:token/id %)) [(:token/begin %) (:token/end %)]) (:tokens r)))]
    (is (= "abxy" (:text/body (:text r))))
    (is (= [0 2] (at :a1) (at :w1)))
    (is (= [2 4] (at :a2)))))

(defn- edit-with [s ops opts]
  (let [{:keys [body tokens]} (doc s)]
    (view (ta/plain-edits body tokens ops #{:s} #{:w} opts) (count (filter #(= :w (:token/layer %)) tokens)))))

(deftest a-layer-that-splits-on-space-splits-a-word-a-space-is-typed-in
  ;; ud (Luke, 2026-09-30): as igt, but a space typed strictly inside a word
  ;; splits it, the word going on the half sharing more letters with it, as
  ;; `split-spaced-words` has it, the tokens inside it dropped and those as long as it moved
  ;; with it
  (let [split {:split-on-space true}]
    (is (= ["the c at" "the" "at"] (edit-with "|the| |cat|" [(ins 5 " ")] split)))
    (is (= ["the ca t" "the" "ca"] (edit-with "|the| |cat|" [(ins 6 " ")] split)))
    (testing "everything else as igt"
      (is (= ["the cats" "the" "cats"] (edit-with "|the| |cat|" [(ins 7 "s")] split)))
      (is (= ["thecat" "the" "cat"] (edit-with "|the| |cat|" [(del 3 1)] split)))
      (is (= ["the " "the" nil] (edit-with "|the| |cat|" [(del 4 3)] split)))
      ;; F1: `walkdd`, Backspace, ` home` typed after it
      (is (= ["a walkd home" "a" "walkd"] (edit-with "|a| |walkdd|" [(del 7 1) (ins 7 " home")] split))))
    (testing "a space typed at a word's edge splits nothing"
      (is (= ["the  cat" "the" "cat"] (edit-with "|the| |cat|" [(ins 4 " ")] split))))
    (testing "the morpheme as long as the word moves with it"
      (let [{:keys [body tokens]} (doc "|the| |cat|")
            r (ta/plain-edits body tokens [(ins 5 " ")] #{:s} #{:w} split)
            at (fn [id] (some #(when (= id (:token/id %)) [(:token/begin %) (:token/end %)]) (:tokens r)))]
        (is (= [6 8] (at [:w 1]) (at [:m 1])))))))

(deftest text-typed-between-two-sentences-goes-to-the-next-past-the-whitespace
  ;; Luke (2026-10-15, superseding 2026-09-30): text typed after the space
  ;; (or other separator) between two sentences belongs to the sentence that
  ;; follows, in an edit and a whole-body save alike, and so does text typed
  ;; right after the punctuation that ends a sentence with no whitespace
  ;; after it. Between two letters it goes to the sentence before. Right after a
  ;; sentence's last letter it stays in that sentence. Text holding a line
  ;; break, or with a line break between it and the next letter, leaves the
  ;; boundary where it was (a line typed is split off the sentence before).
  (let [sents (fn [s ops & [body-new]]
                (let [{:keys [body tokens]} (doc s)
                      r (if body-new
                          (ta/plain-body body body-new tokens #{:s} #{:w})
                          (ta/plain-edits body tokens ops #{:s} #{:w}))
                      nb (:text/body (:text r))
                      ss (sort-by first (keep #(when (= :s (:token/layer %)) [(:token/begin %) (:token/end %)]) (:tokens r)))
                      ;; the gap-fill, as the save runs it
                      ss (map-indexed (fn [i [b e]] [(if (zero? i) 0 b) (if (= i (dec (count ss))) (cp/cp-count nb) (first (nth ss (inc i))))]) ss)]
                  (mapv (fn [[b e]] (cp/cp-subs nb b e)) ss)))]
    (testing "right before the next sentence's first letter"
      (is (= ["The dog ran. " "Then The cat sat."] (sents "|The| |dog| |ran.| /|The| |cat| |sat.|" [(ins 13 "Then ")])))
      (is (= ["Hi. " "New The end."] (sents "|Hi.| /|The| |end.|" [(ins 4 "New ")]))))
    (testing "the next sentence holding the whitespace before it"
      (is (= ["Hi." " New The end."] (sents "|Hi.|/ |The| |end.|" [(ins 4 "New ")]))))
    (testing "right after the last letter of a sentence"
      (is (= ["Hi. And more." " The end."] (sents "|Hi.|/ |The| |end.|" [(ins 3 " And more.")])))
      (is (= ["Hi. And more. " "The end."] (sents "|Hi.| /|The| |end.|" [(ins 3 " And more.")]))))
    (testing "in the middle of a longer run of whitespace"
      (is (= ["Hi. " "X     The end."] (sents "|Hi.|  /  |The| |end.|" [(ins 4 "X  ")])))
      (is (= ["Hi.  " "X    The end."] (sents "|Hi.|  /  |The| |end.|" [(ins 5 "X  ")]))))
    (testing "no whitespace between the two"
      (is (= ["Hi." "New The end."] (sents "|Hi.|/|The| |end.|" [(ins 3 "New ")])))
      (is (= ["你好。" "他我很好。"] (sents "|你|好|。|/|我|很|好|。|" [(ins 3 "他")])))
      (testing "but between two letters the sentence before, as between two words"
        (is (= ["你好他" "我很好。"] (sents "|你|好|/|我|很|好|。|" [(ins 2 "他")])))))
    (testing "a line typed, or a line break before the next letter: the boundary stays"
      (is (= ["Hi. New\n" "The end."] (sents "|Hi.| /|The| |end.|" [(ins 4 "New\n")])))
      (is (= ["Hi.\nX\n" "The end."] (sents "|Hi.|\n\n/|The| |end.|" [(ins 4 "X")])))
      (is (= ["Hi.\nX" "\nThe end."] (sents "|Hi.|\n/\n|The| |end.|" [(ins 4 "X")]))))
    (testing "a line break before the whitespace on the next letter's line"
      (is (= ["Hi.\n " "X  The end."] (sents "|Hi.|\n  /|The| |end.|" [(ins 5 "X ")]))))
    (testing "a whole-body save reads the same"
      (is (= ["Hi. " "New The end."] (sents "|Hi.| /|The| |end.|" nil "Hi. New The end.")))
      ;; which reads the new text after the text the two bodies share, here
      ;; after the space
      (is (= ["Hi." " And more. The end."] (sents "|Hi.|/ |The| |end.|" nil "Hi. And more. The end."))))
    (testing "the start and end of the text"
      (is (= ["Oh The end."] (sents "|The| |end.|" [(ins 0 "Oh ")])))
      (is (= ["The end. Bye."] (sents "|The| |end.|" [(ins 8 " Bye.")]))))))

(deftest text-typed-in-the-whitespace-between-sentences-keeps-the-partition-whole
  ;; FX-B-TEXT: the sentences as stored, not gap-filled, so a sentence left
  ;; empty or two that overlap show
  (let [raw (fn [s change]
              (let [{:keys [body tokens]} (doc s)
                    r (if (string? change)
                        (ta/plain-body body change tokens #{:s} #{:w})
                        (ta/plain-edits body tokens change #{:s} #{:w}))
                    nb (:text/body (:text r))
                    ss (sort-by first (keep #(when (= :s (:token/layer %)) [(:token/begin %) (:token/end %)]) (:tokens r)))]
                (is (every? (fn [[b e]] (< b e)) ss) "no sentence is left empty")
                (is (= (map second (butlast ss)) (map first (rest ss))) "the sentences meet")
                (is (= [0 (cp/cp-count nb)] [(ffirst ss) (second (last ss))]) "and cover the text")
                (mapv (fn [[b e]] (cp/cp-subs nb b e)) ss)))]
    (testing "REV-TEXT-1: a sentence of only whitespace keeps its place and takes text typed at its start"
      (is (= ["Hi. " "X " "The end."] (raw "|Hi.| / /|The| |end.|" [(ins 4 "X")])))
      (is (= ["Hi. " "X  " "The end."] (raw "|Hi.| / /|The| |end.|" [(ins 4 "X ")])))
      (is (= ["Hi. " "X " "The end."] (raw "|Hi.| / /|The| |end.|" "Hi. X The end.")))
      (is (= ["Hi. " "X  " "The end."] (raw "|Hi.| /  /|The| |end.|" [(ins 4 "X")])))
      (testing "and text typed inside it, past whitespace, goes to the next"
        (is (= ["Hi. " " " "X The end."] (raw "|Hi.| /  /|The| |end.|" [(ins 5 "X")]))))
      (testing "two of them"
        (is (= ["Hi. " "X " " " "The end."] (raw "|Hi.| / / /|The| |end.|" [(ins 4 "X")])))))
    (testing "REV-TEXT-2: every insert in the whitespace goes to the next sentence"
      (is (= ["Hi. " "X Y The end."] (raw "|Hi.|   /|The| |end.|" [(ins 4 "X") (ins 6 "Y")])))
      (is (= ["Hi. " "X Y The end."] (raw "|Hi.|   /|The| |end.|" [(ins 5 "Y") (ins 4 "X")])))
      (is (= ["Hi. " "X Y Z The end."] (raw "|Hi.|    /|The| |end.|" [(ins 4 "X") (ins 6 "Y") (ins 8 "Z")])))
      (testing "but not one before a line break"
        (is (= ["Hi. X\n " "Y The end."] (raw "|Hi.| \n /|The| |end.|" [(ins 4 "X") (ins 7 "Y ")])))))
    (testing "REV-TEXT-3: a whole-body save with several sentence starts typed reads each past the whitespace"
      (is (= ["The dog ran. " "Then The cat sat. " "So A cow mooed."]
             (raw "|The| |dog| |ran.| /|The| |cat| |sat.| /|A| |cow| |mooed.|" "The dog ran. Then The cat sat. So A cow mooed.")))
      (is (= ["A. " "x B. " "y C. " "z D."] (raw "|A.| /|B.| /|C.| /|D.|" "A. x B. y C. z D."))))
    (testing "REV2-TEXT-3: two sentences of only whitespace each take the text typed at their start, alone or together"
      (is (= ["Hi. " "X " " " "The end."] (raw "|Hi.| / / /|The| |end.|" [(ins 4 "X")])))
      (is (= ["Hi. " " " "Y " "The end."] (raw "|Hi.| / / /|The| |end.|" [(ins 5 "Y")])))
      (is (= ["Hi. " "X " "Y " "The end."] (raw "|Hi.| / / /|The| |end.|" [(ins 4 "X") (ins 6 "Y")])))
      (is (= ["Hi. " "X  " "Y  " "Z The end."] (raw "|Hi.| / / /|The| |end.|" [(ins 4 "X ") (ins 7 "Y ") (ins 10 "Z ")]))))))

(deftest a-row-over-sentences-with-their-whitespace-follows-the-boundary-it-shares
  ;; REV2-TEXT-1 and -2: rows of a layer that forbids overlap whose edges are
  ;; the sentences' edges, whitespace included (a script's or an import's
  ;; rows), move with the sentence boundary they share, so two rows never
  ;; overlap and the text a sentence takes at a row's edge is in its row.
  ;; FX-D-TEXT: text typed strictly inside a row stays in it, wherever the
  ;; sentence boundary goes. FX-E-TEXT (REV4-TEXT-1): but in a row over whole
  ;; sentences, text typed in the whitespace where it meets a sentence
  ;; boundary counts as typed at the boundary, so the row follows its sentence
  (let [rows (fn [s extents ops]
               (let [{:keys [body tokens]} (doc s)
                     rs (map-indexed (fn [i [b e]] {:token/id [:r i] :token/layer :r :token/begin b :token/end e}) extents)
                     r (ta/plain-edits body (into tokens rs) ops #{:s} #{:w} {:children #{:m} :exclusive #{:r}})
                     nb (:text/body (:text r))
                     at (fn [l] (sort-by first (keep #(when (= l (:token/layer %)) [(:token/begin %) (:token/end %)]) (:tokens r))))
                     rr (at :r)]
                 (is (every? (fn [[[_ e] [b _]]] (<= e b)) (partition 2 1 rr)) (str "rows overlap: " (pr-str rr)))
                 (mapv (fn [[b e]] (cp/cp-subs nb b e)) rr)))]
    (testing "REV4-TEXT-1: text typed in the whitespace a row over whole sentences holds goes with the sentence that takes it"
      (is (= ["Hi. " "X  The end."] (rows "|Hi.|   /|The| |end.|" [[0 6] [6 14]] [(ins 4 "X")])))
      (is (= ["Hi. " "X Y The end."] (rows "|Hi.|   /|The| |end.|" [[0 6] [6 14]] [(ins 4 "X") (ins 6 "Y")])))
      (is (= ["Hi. " "So The end."] (rows "|Hi.|  /|The| |end.|" [[0 5] [5 13]] [(ins 4 "So")])))
      (testing "and before a line break stays with the sentence before"
        (is (= ["Hi. X\n" "The end."] (rows "|Hi.| \n/|The| |end.|" [[0 5] [5 13]] [(ins 4 "X")]))))
      (testing "and at the row's edge goes with the sentence that takes it"
        (is (= ["Hi.   " "X The end."] (rows "|Hi.|   /|The| |end.|" [[0 6] [6 14]] [(ins 6 "X ")]))))
      (testing "a row over two sentences follows the last of them"
        (is (= ["A. B.  " "X C."] (rows "|A.| /|B.|   /|C.|" [[0 8] [8 10]] [(ins 7 "X")])))
        (is (= ["A. B.   " "X C."] (rows "|A.| /|B.|   /|C.|" [[0 8] [8 10]] [(ins 8 "X ")])))
        (testing "and keeps what is typed between them"
          (is (= ["A. X B.   " "C."] (rows "|A.| /|B.|   /|C.|" [[0 8] [8 10]] [(ins 3 "X ")])))))
      (testing "rows that leave the whitespace out keep it out"
        (is (= ["Hi." "X  The end."] (rows "|Hi.|   /|The| |end.|" [[0 3] [6 14]] [(ins 4 "X")])))))
    (testing "REV2-TEXT-2: a row over a sentence of only whitespace takes the text that sentence takes"
      (is (= ["Hi. " "X " "The end."] (rows "|Hi.| / /|The| |end.|" [[0 4] [4 5] [5 13]] [(ins 4 "X")])))
      (is (= ["Hi. " "X " "Y " "The end."] (rows "|Hi.| / / /|The| |end.|" [[0 4] [4 5] [5 6] [6 14]] [(ins 4 "X") (ins 6 "Y")]))))))

(deftest a-split-cuts-only-at-the-whitespace-typed
  ;; REV2 M1: a word that already held a space is cut only at the space the
  ;; edit typed, and goes on the part holding most of its old letters
  (let [split {:split-on-space true}]
    (is (= ["si nh viên x" "nh viên" "x"] (edit-with "|sinh viên| |x|" [(ins 2 " ")] split)))
    (is (= ["sinh v iên x" "sinh v" "x"] (edit-with "|sinh viên| |x|" [(ins 6 " ")] split)))
    (is (= ["tlaak naa x" "tlaak naa" "x"] (edit-with "|tlaak naa| |x|" [] split)))))

(deftest a-split-keeps-what-stood-inside-the-word-on-its-half
  ;; REV2 L2: a token strictly inside the split word is kept, cut to the part
  ;; holding most of its letters (the other part is a word of its own since
  ;; Q2-UD-POLISH-2, so one wholly on it stays); REV2 L1: a token
  ;; over several words that ended with the split word ends where it does
  (let [{:keys [body tokens]} (doc "|dog| |cat| |eel|")
        tokens (conj tokens
                     {:token/id :at :token/layer :y :token/begin 5 :token/end 7}
                     {:token/id :c :token/layer :y :token/begin 4 :token/end 5}
                     {:token/id :dc :token/layer :u :token/begin 0 :token/end 7})
        r (ta/plain-edits body tokens [(ins 5 " ")] #{:s} #{:w} {:split-on-space true})
        at (fn [id] (some #(when (= id (:token/id %)) [(:token/begin %) (:token/end %)]) (:tokens r)))]
    (is (= "dog c at eel" (:text/body (:text r))))
    (is (= [6 8] (at [:w 1])))
    (is (= [6 8] (at :at)))
    (is (= [4 5] (at :c)) "on the new part, now a token of its own (Q2-UD-POLISH-2)")
    (is (= [0 8] (at :dc)))
    (let [r (ta/plain-edits body tokens [(ins 6 " ")] #{:s} #{:w} {:split-on-space true})
          at (fn [id] (some #(when (= id (:token/id %)) [(:token/begin %) (:token/end %)]) (:tokens r)))]
      (is (= "dog ca t eel" (:text/body (:text r))))
      (is (= [4 6] (at [:w 1])))
      (is (= [0 6] (at :dc)) "the node ends where its last word does")
      (is (= [5 6] (at :at)) "cut to the half"))))

(deftest text-typed-where-two-words-meet-goes-to-the-side-the-caret-says
  ;; REV2 M2: an insert saying `side` goes to that side where two tokens meet
  ;; with no space
  (is (= ["onextwo" "one" "xtwo"] (edit "|one||two|" [(assoc (ins 3 "x") :side "after")])))
  (is (= ["onextwo" "onex" "two"] (edit "|one||two|" [(assoc (ins 3 "x") :side "before")])))
  (is (= ["onextwo" "onex" "two"] (edit "|one||two|" [(ins 3 "x")])) "no side: the word before"))

(deftest a-line-typed-before-a-sentence-goes-to-the-sentence-before
  ;; REV2 H1: a line break in the text typed before a sentence keeps it off
  ;; that sentence, so the line split off later is a sentence of its own and
  ;; the old sentence keeps its translation; sentences never begin on
  ;; whitespace they did not have
  (let [sents (fn [s ops]
                (let [{:keys [body tokens]} (doc s)
                      r (ta/plain-edits body tokens ops #{:s} #{:w})
                      nb (:text/body (:text r))
                      ss (sort-by first (keep #(when (= :s (:token/layer %)) [(:token/begin %) (:token/end %)]) (:tokens r)))
                      ss (map-indexed (fn [i [b e]] [(if (zero? i) 0 b) (if (= i (dec (count ss))) (cp/cp-count nb) (first (nth ss (inc i))))]) ss)]
                  (mapv (fn [[b e]] (cp/cp-subs nb b e)) ss)))]
    (is (= ["Hi.\nOh.\n" "The end."] (sents "|Hi.|\n/|The| |end.|" [(ins 4 "Oh.\n")])))
    (is (= ["Hi.\n" "Oh The end."] (sents "|Hi.|\n/|The| |end.|" [(ins 4 "Oh ")])))
    (is (= ["Hi.  " "Q你好"] (sents "|Hi.| /|你好|" [(ins 4 " Q")]))
        "the space typed before stays with the sentence before")))

(deftest a-segment-that-begins-with-its-sentence-takes-what-the-sentence-takes
  ;; REV2 M5: `Oh ` typed before `The`, the second sentence's first word,
  ;; joins that sentence, and the time-alignment segment over it too, so the
  ;; segment still covers its sentence (the exports' timing and speaker); a
  ;; node over the first word alone stays with the word
  (let [{:keys [body tokens]} (doc "|Hi.| /|The| |end.|")
        tokens (conj tokens
                     {:token/id :seg :token/layer :a :token/begin 4 :token/end 12}
                     {:token/id :node :token/layer :u :token/begin 4 :token/end 7})
        r (ta/plain-edits body tokens [(ins 4 "Oh ")] #{:s} #{:w} {:exclusive #{:a}})
        at (fn [id] (some #(when (= id (:token/id %)) [(:token/begin %) (:token/end %)]) (:tokens r)))]
    (is (= "Hi. Oh The end." (:text/body (:text r))))
    (is (= [4 15] (at [:s 1]) (at :seg)))
    (is (= [7 10] (at [:w 1]) (at :node)))))

(defn- extents-after [s extra ops & [opts]]
  (let [{:keys [body tokens]} (doc s)
        r (ta/plain-edits body (into tokens extra) ops #{:s} #{:w} (merge {:children #{:m} :exclusive #{:a}} opts))
        nb (:text/body (:text r))
        at (fn [id] (some #(when (= id (:token/id %)) (cp/cp-subs nb (:token/begin %) (:token/end %))) (:tokens r)))]
    [nb at r]))

(deftest a-token-over-a-sentence-follows-the-sentence
  ;; REV3: a time-alignment segment whose extent is its sentence's, less
  ;; the whitespace at the sentence's edges, takes exactly what the sentence
  ;; takes: at the text's start (N3), its end (N4), before a sentence (M5), a
  ;; one-word sentence included, and a word split at its edge (N2)
  (let [seg (fn [id b e] {:token/id id :token/layer :a :token/begin b :token/end e})]
    (let [[nb at] (extents-after "|The| |end.| /|Bye.|" [(seg :a0 0 8) (seg :a1 9 13)] [(ins 0 "Oh ")])]
      (is (= "Oh The end. Bye." nb))
      (is (= "Oh The end." (at :a0))))
    (let [[nb at] (extents-after "|Hi.| /|The| |end.|" [(seg :a1 4 12)] [(ins 12 " Oh")])
          [_ at0] (extents-after "|Hi.| /|The| |end.|" [(seg :a0 0 3)] [(ins 3 " Oh")])]
      (is (= "Hi. Oh" (at0 :a0)) "text typed after a sentence's last word, the segment with it")
      (is (= " Oh" (subs nb 12)))
      (is (= "The end. Oh" (at :a1))))
    (let [[nb at] (extents-after "|Hi.| /|Yes.|" [(seg :a1 4 8)] [(ins 4 "Oh ")])]
      (is (= "Oh Yes." (at :a1)))
      (is (= "Yes." (at [:w 1]) (at [:m 1]))))
    (let [[nb at] (extents-after "|toi| |la.| /|sinh viên| |hoc.|" [(seg :a1 8 22)] [(ins 10 " ")] {:split-on-space true})]
      (is (= "si nh viên hoc." (at :a1)))
      (is (= "nh viên" (at [:w 2]))))))

(deftest a-token-that-is-no-sentence-takes-no-sentence-text
  ;; REV3 N5: a node over `New York` at a sentence's start, and a sub-word
  ;; token, keep to their words when `Oh ` is typed before the sentence
  (let [[_ at] (extents-after "|Hi.| /|New| |York| |is| |big.|"
                              [{:token/id :ny :token/layer :u :token/begin 4 :token/end 12}
                               {:token/id :ne :token/layer :u :token/begin 4 :token/end 6}
                               {:token/id :all :token/layer :u :token/begin 4 :token/end 20}]
                              [(ins 4 "Oh ")])]
    (is (= "New York" (at :ny)))
    (is (= "Ne" (at :ne)))
    (is (= "New York is big." (at :all)) "a node (overlap allowed) keeps to its words (REV4 R2)")))

(deftest a-line-typed-before-the-first-sentence-is-a-sentence-of-its-own
  ;; REV3 N1: nothing before it to join, so the core makes a sentence over it
  ;; and the first sentence keeps its place (and its translation)
  (let [[nb at r] (extents-after "|Hi.|\n/|The| |end.|" [] [(ins 0 "Oh.\n")])]
    (is (= "Oh.\nHi.\nThe end." nb))
    (is (= "Hi.\n" (at [:s 0])))
    (is (= [{:token/layer :s :token/begin 0 :token/end 4}] (:heads r))))
  (let [[_ at r] (extents-after "|Hi.|\n/|The| |end.|" [] [(ins 0 "Oh.\nNew ")])]
    (is (= "New Hi.\n" (at [:s 0])) "what follows the last line break joins the sentence")
    (is (= [{:token/layer :s :token/begin 0 :token/end 4}] (:heads r)))))

(deftest side-counts-only-where-two-words-meet
  ;; REV3 N6: `side` pointing at whitespace or at no token is no side; N7: a
  ;; sided insert holding a space takes its sentence with it
  (is (= ["onex two" "onex" "two"] (edit "|one| |two|" [(assoc (ins 3 "x") :side "after")])))
  (is (= ["one xtwo" "one" "xtwo"] (edit "|one| |two|" [(assoc (ins 4 "x") :side "before")])))
  (let [[nb at] (extents-after "|one|/|two|" [] [(assoc (ins 3 "x ") :side "after")])]
    (is (= "onex two" nb))
    (is (= "x two" (at [:s 1])))
    (is (= "one" (at [:s 0])))))

(deftest a-typed-over-stretch-never-stacks-tokens-of-a-layer-that-forbids-overlap
  ;; REV3 N8: two tokens inside `cat eel`, typed over as `one`
  (let [old "dog cat eel fox."
        words (mapv (fn [i [b e]] {:token/id [:w i] :token/layer :w :token/begin b :token/end e})
                    (range) [[0 3] [4 7] [8 11] [12 16]])
        segs [{:token/id :g1 :token/layer :g :token/begin 8 :token/end 9}
              {:token/id :g2 :token/layer :g :token/begin 9 :token/end 11}]
        ops [(rep 4 7 "one")]
        r (ta/plain-edits old (into words segs) ops #{} #{:w} {:exclusive #{:g}})
        gs (sort-by :token/begin (filter #(= :g (:token/layer %)) (:tokens r)))]
    (is (= "dog one fox." (:text/body (:text r))))
    (is (every? (fn [[x y]] (<= (:token/end x) (:token/begin y))) (partition 2 1 gs)) (pr-str gs))))

(deftest side-decides-where-sentences-meet-though-no-words-do
  ;; REV4 R1: rows `Hi.` and `Yo.` written together, the words leaving out the
  ;; punctuation: text typed at the end of row 1 goes to its sentence (and
  ;; its row), and to no word
  (let [{:keys [body tokens]} (doc "|Hi|./|Yo|.")
        run (fn [op] (let [r (ta/plain-edits body tokens [op] #{:s} #{:w} {:exclusive #{:a}})
                           nb (:text/body (:text r))
                           ss (sort-by first (keep #(when (= :s (:token/layer %)) [(:token/begin %) (:token/end %)]) (:tokens r)))
                           ;; the gap-fill
                           ss [[0 (first (second ss))] [(first (second ss)) (cp/cp-count nb)]]
                           ws (sort-by first (keep #(when (= :w (:token/layer %)) [(:token/begin %) (:token/end %)]) (:tokens r)))]
                       [nb (mapv (fn [[b e]] (cp/cp-subs nb b e)) ss) (mapv (fn [[b e]] (cp/cp-subs nb b e)) ws)]))]
    (is (= ["Hi.xYo." ["Hi.x" "Yo."] ["Hi" "Yo"]] (run (assoc (ins 3 "x") :side "before"))))
    (is (= ["Hi. xYo." ["Hi. x" "Yo."] ["Hi" "Yo"]] (run (assoc (ins 3 " x") :side "before"))))
    (is (= ["Hi.xYo." ["Hi." "xYo."] ["Hi" "xYo"]] (run (assoc (ins 3 "x") :side "after"))))))

(deftest only-a-token-of-a-layer-that-forbids-overlap-follows-a-sentence
  ;; REV4 R2: a UMR node (overlap allowed) over a one-word sentence, or over
  ;; every word of one, keeps to its words; a segment follows the sentence
  (let [[_ at] (extents-after "|hi| |there|. /|yes|"
                              [{:token/id :node :token/layer :u :token/begin 10 :token/end 13}
                               {:token/id :seg :token/layer :a :token/begin 10 :token/end 13}]
                              [(ins 13 " sir")] {:exclusive #{:a}})]
    (is (= "yes" (at :node)))
    (is (= "yes sir" (at :seg))))
  (let [[_ at] (extents-after "|the| |big| |dog|\n/|ran|"
                              [{:token/id :node :token/layer :u :token/begin 0 :token/end 11}]
                              [(ins 0 "oh ")] {:exclusive #{:a}})]
    (is (= "the big dog" (at :node)))))

(deftest a-point-at-a-growing-tokens-edge-stays-at-its-edge
  ;; REV4 R3: an empty segment at the end of a row the text grows stays at
  ;; the row's new end, and nothing overlaps
  (let [{:keys [body tokens]} (doc "|Hi.| /|The| |end.|")
        tokens (conj tokens
                     {:token/id :a0 :token/layer :a :token/begin 0 :token/end 3}
                     {:token/id :z :token/layer :a :token/begin 3 :token/end 3})
        r (ta/plain-edits body tokens [(ins 3 "x")] #{:s} #{:w} {:exclusive #{:a}})
        at (fn [id] (some #(when (= id (:token/id %)) [(:token/begin %) (:token/end %)]) (:tokens r)))]
    (is (= [0 4] (at :a0)))
    (is (= [4 4] (at :z)))))

(deftest a-head-sentence-needs-a-line-with-letters-and-any-save-shape
  ;; REV4 R4: whitespace alone typed at the start joins the first sentence;
  ;; R5: the same line typed with a letter of the first word deleted, or
  ;; after whitespace the text began with, makes the same head
  (let [heads (fn [s ops] (:heads (nth (extents-after s [] ops) 2)))]
    (is (nil? (heads "|Hi.|\n/|The| |end.|" [(ins 0 "\n")])))
    (is (nil? (heads "|Hi.|\n/|The| |end.|" [(ins 0 "  \n")])))
    ;; REV5-TEXT-2: no-break and ideographic spaces are whitespace here too,
    ;; so Enter after a paragraph indent of them makes no sentence
    (is (nil? (heads "|Hi.|\n/|The| |end.|" [(ins 0 "\u3000\n")])))
    (is (nil? (heads "|Hi.|\n/|The| |end.|" [(ins 0 "\u00a0\u202f\n")])))
    (is (nil? (heads "\u3000\u3000|他们是学生。|/|他们是老师。|" [(ins 2 "\n")])))
    (is (nil? (heads "\u3000\u3000|他们是学生。|/|他们是老师。|" [(ins 2 "\u3000\n")])))
    (is (nil? (heads "\u00a0\u00a0|Ana| |runs.| /|Ben| |sits.|" [(ins 2 "\n")])))
    (is (= [{:token/layer :s :token/begin 0 :token/end 5}] (heads "\u3000\u3000|他们是学生。|/|他们是老师。|" [(ins 2 "题目\n")])))
    ;; REV6-TEXT-3: NEL ends a line and is whitespace to this rule too, so
    ;; Enter typed as NEL after an indent, or a line of only NEL, makes no
    ;; sentence, and a title line ended by NEL does
    (is (nil? (heads "|Hi.|\n/|The| |end.|" [(ins 0 "\u0085")])))
    (is (nil? (heads "|Hi.|\n/|The| |end.|" [(ins 0 "\u0085\u0085")])))
    (is (nil? (heads "\u3000\u3000|他们是学生。|/|他们是老师。|" [(ins 2 "\u0085")])))
    (is (nil? (heads "\u3000\u3000|他们是学生。|/|他们是老师。|" [(ins 2 "\u3000\u0085")])))
    (is (nil? (heads "\u0085|Hi.|\n/|The| |end.|" [(ins 1 "\n")])))
    (is (= [{:token/layer :s :token/begin 0 :token/end 3}] (heads "\u0085|Hi.|\n/|The| |end.|" [(ins 1 "T\n")])))
    (is (= [{:token/layer :s :token/begin 0 :token/end 5}] (heads "\u3000\u3000|他们是学生。|/|他们是老师。|" [(ins 2 "题目\u0085")])))
    (is (= [{:token/layer :s :token/begin 0 :token/end 4}] (heads "|Hi.|\n/|The| |end.|" [(ins 0 "Oh.\n") (del 4 1)])))
    (is (= [{:token/layer :s :token/begin 0 :token/end 5}] (heads " |Hi.|\n/|The| |end.|" [(ins 1 "Oh.\n")])))
    (let [[nb at] (extents-after "|Hi.|\n/|The| |end.|" [] [(ins 0 "Oh.\n") (del 4 1)])]
      (is (= "Oh.\ni.\nThe end." nb))
      (is (= "i.\n" (at [:s 0]))))))

(deftest side-decides-where-two-rows-meet-in-one-sentence
  ;; REV5 M1: rows `Hi.` and `Yo.` written together in ONE sentence (igt's
  ;; Media tab seeds one sentence for every row): text typed at the end of
  ;; row 1 goes to row 1 with `side: "before"`, and to no word
  (let [row (fn [id b e] {:token/id id :token/layer :a :token/begin b :token/end e})
        rows [(row :a0 0 3) (row :a1 3 6) (row :a2 7 11)]
        run (fn [op] (let [[nb at] (extents-after "|Hi|.|Yo|. /|End|." rows [op])]
                       [nb (at :a0) (at :a1) (at [:w 0]) (at [:w 1])]))]
    (is (= ["Hi.xYo. End." "Hi.x" "Yo." "Hi" "Yo"] (run (assoc (ins 3 "x") :side "before"))))
    (is (= ["Hi. xYo. End." "Hi. x" "Yo." "Hi" "Yo"] (run (assoc (ins 3 " x") :side "before"))))
    (is (= ["Hi.xYo. End." "Hi." "xYo." "Hi" "xYo"] (run (assoc (ins 3 "x") :side "after"))))))

(deftest a-point-beside-the-words-stays-a-point
  ;; REV5 L5: a UMR constant's anchor at 0 on a node layer beside the words
  ;; stays zero-width, whatever the edit
  (let [old "Hi. The end."
        words (mapv (fn [i [b e]] {:token/id [:w i] :token/layer :w :token/begin b :token/end e})
                    (range) [[0 3] [4 7] [8 12]])
        nodes [{:token/id :n0 :token/layer :u :token/begin 0 :token/end 3}
               {:token/id :c :token/layer :u :token/begin 0 :token/end 0}]
        ops [(ins 12 "x")]
        r (ta/plain-edits old (into words nodes) ops #{} #{:w})
        c (some #(when (= :c (:token/id %)) %) (:tokens r))]
    (is (= [0 0] [(:token/begin c) (:token/end c)]))))

(deftest words-typed-over-as-words-each-keep-their-token
  ;; REV-one-rule F1: each word typed over whole keeps its token, on both
  ;; paths. Fewer new words than old: the last goes to the old word sharing
  ;; most letters with it, the first on a tie, and the others go.
  (is (= ["我 x y 好 。" "我" "x" "y" "好" "。"] (edit "|我| |不| |大| |好| |。|" [(rep 2 3 "x y")])))
  (is (= ["我 x y 好 。" "我" "x" "y" "好" "。"] (save "|我| |不| |大| |好| |。|" "我 x y 好 。")))
  (is (= ["dog one fox." "dog" nil "one" "fox."] (edit "|dog| |cat| |eel| |fox.|" [(rep 4 7 "one")])))
  ;; chinese_tlp: `远离 人烟 千 里 之外` typed over as `q `
  (is (= ["在 q  的" "在" "q" nil nil nil nil "的"]
         (edit "|在| |远离| |人烟| |千| |里| |之外| |的|" [(rep 2 12 "q ")])))
  ;; more new words than old, as a whole-body save reads it: the last old
  ;; word holds the rest
  (is (= ["a x y z b" "a" "x" "y z" "b"] (edit "|a| |cat| |eel| |b|" [(rep 2 7 "x y z")])))
  (is (= ["a x y zeel b" "a" "x" "zeel" "b"] (edit "|a| |cat| |eel| |b|" [(rep 2 7 "x y zeel")])))
  (is (= ["wa xy\njjadi ma" "wa" "jjadi" "ma"] (edit "|wa|\n|jadi| |ma|" [(rep 0 10 "wa xy\njjadi ma")]))))

(deftest layer-roles-read-the-layers-shape
  (testing "a root word layer with a layer under it decides, the layer under it follows (F6)"
    (let [r (ta/layer-roles [{:id :s :overlap-mode "partitioning"}
                             {:id :w :overlap-mode "non-overlapping"}
                             {:id :m :overlap-mode "non-overlapping" :parent :w}])]
      (is (= #{:w} (:deciders r)))
      (is (= #{:m} (:children r)))))
  (testing "ud's syntactic words under shared words never decide"
    (is (= #{:w} (:deciders (ta/layer-roles [{:id :s :overlap-mode "partitioning"}
                                             {:id :w :overlap-mode "non-overlapping" :parent :s}
                                             {:id :x :overlap-mode "non-overlapping" :parent :w}])))))
  (testing "a head is made only on the partition the words are under (F7)"
    (is (= #{:s} (:head-layers (ta/layer-roles [{:id :s :overlap-mode "partitioning"}
                                                {:id :d :overlap-mode "partitioning"}
                                                {:id :w :overlap-mode "non-overlapping" :parent :s}]))))
    (is (= #{:s} (:head-layers (ta/layer-roles [{:id :s :overlap-mode "partitioning"}
                                                {:id :w :overlap-mode "non-overlapping"}]))))
    (is (= #{} (:head-layers (ta/layer-roles [{:id :s :overlap-mode "partitioning"}
                                              {:id :d :overlap-mode "partitioning"}
                                              {:id :w :overlap-mode "any"}]))))))

(deftest an-analysed-word-retyped-in-a-whole-body-save-drops-its-morphemes
  ;; REV-one-rule F4: `cow` (`co` + `w`) saved as `abc` is the word typed
  ;; over, as on the edits path (2026-09-27); `cat` (`ca` + `t`) saved as
  ;; `bad` respells inside each morpheme and keeps them
  (let [t (fn [id l b e] {:token/id id :token/layer l :token/begin b :token/end e})
        run (fn [old new tokens f]
              (let [r (f old new tokens)
                    gone (set (:deleted r))]
                (into {} (comp (remove #(gone (:token/id %))) (map (juxt :token/id #(subs new (:token/begin %) (:token/end %))))) (:tokens r))))
        body (fn [old new tokens] (ta/plain-body old new tokens #{} #{:w} {:children #{:m}}))
        edits (fn [old new tokens] (ta/plain-edits old tokens [(rep 4 3 (subs new 4 7))] #{} #{:w}))
        cow [(t :w :w 4 7) (t :co :m 4 6) (t :w2 :m 6 7)]
        cat [(t :w :w 4 7) (t :ca :m 4 6) (t :t :m 6 7)]]
    (is (= {:w "abc"} (run "the cow sat" "the abc sat" cow body) (run "the cow sat" "the abc sat" cow edits)))
    (is (= {:w "bad" :ca "ba" :t "d"} (run "the cat sat" "the bad sat" cat body)))))

(defn- live-texts
  "Each live token's text after `r`, by id."
  [{:keys [text tokens deleted]}]
  (let [body (:text/body text)
        gone (set deleted)]
    (into {} (comp (remove #(gone (:token/id %)))
                   (map (fn [{:token/keys [id begin end]}] [id (cp/cp-subs body begin end)])))
          tokens)))

(deftest a-paste-of-the-same-words-with-one-more-or-less-keeps-every-other-word
  ;; H1-IGT-TEXT-1: the same text pasted over the whole body, a line or a
  ;; stretch, with one word inserted, deleted or replaced, read old word i
  ;; as new word i, so every word after the change took its neighbour's
  ;; analysis and sentences went. Every other word keeps its own token,
  ;; morphemes and sentence, on all three readings: one replace of the
  ;; whole body, one replace of the line, and a whole-body save.
  (let [lines [["wa" "me" "sekarang" "wandi"] ["jadi" "ma" "parlure"]
               ["karena" "arun" "tok" "kurang" "(...)" "ma" "koi" "kielunara" "perlu" "a" "mera"]
               ["yo," "sor..."] ["lore!"]]
        s (str/join "\n/" (map (fn [ws] (str/join " " (map #(str "|" % "|") ws))) lines))
        {:keys [body tokens]} (doc s)
        ;; word ids by line and place
        ids (vec (reductions + 0 (map count lines)))
        wid (fn [li k] [:w (+ (ids li) k)])
        line-text (fn [ls] (str/join "\n" (map #(str/join " " %) ls)))
        cases (for [li (range (count lines))
                    k (distinct [0 (quot (count (lines li)) 2) (dec (count (lines li)))])
                    change [:insert :delete :replace]
                    :when (not (and (= change :delete) (= 1 (count (lines li)))))]
                [li k change])]
    (is (= body (line-text lines)))
    (doseq [[li k change] cases]
      (let [line (lines li)
            new-line (case change
                       :insert (into (conj (subvec line 0 k) "oke") (subvec line k))
                       :delete (into (subvec line 0 k) (subvec line (inc k)))
                       :replace (assoc line k "XYZ"))
            new (line-text (assoc lines li new-line))
            ;; what every word but the changed one should read
            want (into {} (for [l (range (count lines)) j (range (count (lines l)))
                                :when (not (and (= l li) (= j k) (not= change :insert)))]
                            [(wid l j) ((lines l) j)]))
            want (cond-> want (= change :replace) (assoc (wid li k) "XYZ"))
            lb (cp/cp-count (line-text (subvec lines 0 li)))
            lb (if (pos? li) (inc lb) lb)
            le (+ lb (cp/cp-count (str/join " " line)))
            readings {:whole-replace (ta/plain-edits body tokens [(rep 0 (cp/cp-count body) new)] #{:s} #{:w})
                      :line-replace (ta/plain-edits body tokens [(rep lb (- le lb) (str/join " " new-line))] #{:s} #{:w})
                      :whole-body (ta/plain-body body new tokens #{:s} #{:w})}]
        (doseq [[rname r] readings]
          (let [got (live-texts r)
                where (str rname " " change " word " k " of line " li)]
            (is (= new (:text/body (:text r))) where)
            (is (= want (into {} (filter #(= :w (first (key %)))) got)) where)
            (doseq [[[_ i] t] want]
              (is (= t (got [:m i])) (str where ": morpheme " i)))
            (is (every? #(contains? got [:s %]) (range (count lines))) (str where ": every sentence kept"))
            (is (= (if (= change :delete) #{[:w (+ (ids li) k)] [:m (+ (ids li) k)]} #{})
                   (set (:deleted r)))
                where)))))))

(deftest small-edits-sent-as-one-replace-are-each-taken-as-made
  ;; H1-IGT-TEXT-1, the API form: three small inserts written as one replace
  ;; stored `jadi` on `xy`, `ma` on `jjadi`, and `parlure` across a space
  ;; and a line break
  (is (= ["wa me sekarang wandi xy\njjadi ma parlure\nz" "wa" "me" "sekarang" "wandi" "jjadi" "ma" "parlure"]
         (edit "|wa| |me| |sekarang| |wandi|\n|jadi| |ma| |parlure|\n"
               [(rep 0 37 "wa me sekarang wandi xy\njjadi ma parlure\nz")])))
  ;; a phrase (a word holding a space) next to its twin, one of them deleted:
  ;; one keeps its token whole (the text cannot tell which, the save keeps
  ;; the second)
  (is (= ["a thee da. b" "a" nil "thee da" "b"]
         (edit "|a| |thee da| |thee da|. |b|" [(rep 0 20 "a thee da. b")])))
  ;; a word deleted before punctuation: the word before keeps off it
  (is (= ["on köye. a" "on" "köye" nil "a"] (edit "|on| |köye| |tat|. |a|" [(rep 0 14 "on köye. a")]))))

(deftest a-split-makes-each-other-part-a-word-of-its-own
  ;; Q2-UD-POLISH-2 (Luke, 2026-10-02): on a layer that splits on space, a
  ;; space typed inside a word splits it. The part holding more letters keeps
  ;; the token and what hangs off it, and the other part is a new token of
  ;; the layer, with a new token under it on each layer the word had one as
  ;; long as it on. A multi-word token's words (as long as it, told apart by
  ;; precedence, on a layer that deals them out) go one to each part when
  ;; there are as many.
  (let [t (fn [id l b e & [p]] (cond-> {:token/id id :token/layer l :token/begin b :token/end e} p (assoc :token/precedence p)))
        opts {:split-on-space true :children #{:x} :dealt #{:x}}
        run (fn [body tokens ops]
              (let [r (ta/plain-edits body tokens ops #{:s} #{:w} opts)
                    nb (:text/body (:text r))
                    gone (set (:deleted r))]
                {:body nb
                 :live (into {} (comp (remove #(gone (:token/id %))) (map (juxt :token/id #(cp/cp-subs nb (:token/begin %) (:token/end %))))) (:tokens r))
                 :made (mapv (juxt :token/layer #(cp/cp-subs nb (:token/begin %) (:token/end %))) (:made r))}))]
    (testing "Hello wonder ful world."
      (let [body "Hello wonderful world."
            toks [(t :s :s 0 22) (t :w0 :w 0 5) (t :x0 :x 0 5) (t :w1 :w 6 15) (t :x1 :x 6 15) (t :w2 :w 16 22) (t :x2 :x 16 22)]]
        (is (= {:body "Hello wonder ful world."
                :live {:s "Hello wonder ful world." :w0 "Hello" :x0 "Hello" :w1 "wonder" :x1 "wonder" :w2 "world." :x2 "world."}
                :made [[:w "ful"] [:x "ful"]]}
               (run body toks [(ins 12 " ")])))
        (testing "a whole-body save alike"
          (let [r (ta/plain-body body "Hello wonder ful world." toks #{:s} #{:w} opts)]
            (is (= [[:w 13 16] [:x 13 16]] (mapv (juxt :token/layer :token/begin :token/end) (:made r))))))))
    (testing "can't, ca + n't, typed as ca n't: each word on its own part"
      (let [body "I can't go"
            toks [(t :s :s 0 10) (t :w :w 2 7) (t :ca :x 2 7 0) (t :nt :x 2 7 1)]]
        (is (= {:body "I ca n't go" :live {:s "I ca n't go" :w "n't" :ca "ca" :nt "n't"} :made [[:w "ca"]]}
               (run body toks [(ins 4 " ")])))))
    (testing "did + n't, the second word first by precedence"
      (let [body "didn't"
            toks [(t :s :s 0 6) (t :w :w 0 6) (t :nt :x 0 6 1) (t :did :x 0 6 0)]]
        (is (= {:body "did n't" :live {:s "did n't" :w "did" :did "did" :nt "n't"} :made [[:w "n't"]]}
               (run body toks [(ins 3 " ")])))))
    (testing "two spaces typed: three parts, the words under it too few to go one each"
      (let [body "abcdefg"
            toks [(t :s :s 0 7) (t :w :w 0 7) (t :a :x 0 7 0) (t :b :x 0 7 1)]]
        (is (= {:body "ab cdef g" :live {:s "ab cdef g" :w "cdef" :a "cdef" :b "cdef"}
                :made [[:w "ab"] [:x "ab"] [:w "g"] [:x "g"]]}
               (run body toks [(ins 2 " ") (ins 7 " ")])))))
    (testing "no layer splits on space: nothing is made"
      (let [r (ta/plain-edits "wonderful" [(t :s :s 0 9) (t :w :w 0 9)] [(ins 6 " ")] #{:s} #{:w} {:children #{:x}})]
        (is (nil? (:made r)))))))

;; FX6-SPLIT (2026-10-06): the tokens under a word a typed space splits are
;; placed by where they stand. Only a layer that deals them out (role
;; `syntactic-word`, the words of a multi-word token) has those as long as
;; the word go one to each part in order. A morpheme layer's stay with the
;; word, and one reaching over the cut is cut at it, the new part getting a
;; new, bare token over its letters there.
(deftest a-split-places-the-tokens-under-a-word-by-where-they-stand
  (let [t (fn [id l b e & [p]] (cond-> {:token/id id :token/layer l :token/begin b :token/end e} p (assoc :token/precedence p)))
        run (fn [body tokens ops opts]
              (let [r (ta/plain-edits body tokens ops #{:s} #{:w} (merge {:split-on-space true} opts))
                    nb (:text/body (:text r))
                    gone (set (:deleted r))]
                {:body nb
                 :live (into {} (comp (remove #(gone (:token/id %))) (map (juxt :token/id #(cp/cp-subs nb (:token/begin %) (:token/end %))))) (:tokens r))
                 :gone gone
                 :made (mapv (juxt :token/layer #(cp/cp-subs nb (:token/begin %) (:token/end %))) (:made r))}))]
    (testing "singers analysed si + ngers as two morphemes as long as it: both stay on sing, ers gets a bare one"
      (let [body "singers"
            toks [(t :s :s 0 7) (t :w :w 0 7) (t :si :m 0 7 1) (t :ngers :m 0 7 2)]]
        (is (= {:body "sing ers" :live {:s "sing ers" :w "sing" :si "sing" :ngers "sing"} :gone #{}
                :made [[:w "ers"] [:m "ers"]]}
               (run body toks [(ins 4 " ")] {:children #{:m}})))))
    (testing "the same word where a layer beside it deals its words out: only that layer's go one to each part"
      (let [body "singers"
            toks [(t :s :s 0 7) (t :w :w 0 7) (t :si :m 0 7 1) (t :ngers :m 0 7 2) (t :x1 :x 0 7 0) (t :x2 :x 0 7 1)]]
        (is (= {:body "sing ers"
                :live {:s "sing ers" :w "sing" :si "sing" :ngers "sing" :x1 "sing" :x2 "ers"} :gone #{}
                :made [[:w "ers"] [:m "ers"]]}
               (run body toks [(ins 4 " ")] {:children #{:m :x} :dealt #{:x}})))))
    (testing "morphemes inside the word: si stays, ngers is cut at the space, ers is new"
      (let [body "singers"
            toks [(t :s :s 0 7) (t :w :w 0 7) (t :si :m 0 2) (t :ngers :m 2 7)]]
        (is (= {:body "sing ers" :live {:s "sing ers" :w "sing" :si "si" :ngers "ng"} :gone #{}
                :made [[:w "ers"] [:m "ers"]]}
               (run body toks [(ins 4 " ")] {:children #{:m}})))))
    (testing "a morpheme wholly on the new part goes with it"
      (let [body "singers"
            toks [(t :s :s 0 7) (t :w :w 0 7) (t :sing :m 0 4) (t :ers :m 4 7)]]
        (is (= {:body "sing ers" :live {:s "sing ers" :w "sing" :sing "sing" :ers "ers"} :gone #{}
                :made [[:w "ers"]]}
               (run body toks [(ins 4 " ")] {:children #{:m}})))))
    (testing "the word stays on the right part: a morpheme over the cut stays with it there"
      (let [body "abcdefg"
            toks [(t :s :s 0 7) (t :w :w 0 7) (t :a :m 0 1) (t :bcd :m 1 4) (t :efg :m 4 7)]]
        (is (= {:body "ab cdefg" :live {:s "ab cdefg" :w "cdefg" :a "a" :bcd "cd" :efg "efg"} :gone #{}
                :made [[:w "ab"] [:m "b"]]}
               (run body toks [(ins 2 " ")] {:children #{:m}})))))
    (testing "no layer deals: a multi-word token's words stay with the word"
      (let [body "I can't go"
            toks [(t :s :s 0 10) (t :w :w 2 7) (t :ca :x 2 7 0) (t :nt :x 2 7 1)]]
        (is (= {:body "I ca n't go" :live {:s "I ca n't go" :w "n't" :ca "n't" :nt "n't"} :gone #{}
                :made [[:w "ca"] [:x "ca"]]}
               (run body toks [(ins 4 " ")] {:children #{:x}})))))
    (testing "two morphemes over the cut that overlap: each gets its own new piece (REV-FX6 F4)"
      (let [body "singers"
            toks [(t :s :s 0 7) (t :w :w 0 7) (t :m1 :m 2 7) (t :m2 :m 3 7)]]
        (is (= {:body "sing ers" :live {:s "sing ers" :w "sing" :m1 "ng" :m2 "g"} :gone #{}
                :made [[:w "ers"] [:m "ers"] [:m "ers"]]}
               (run body toks [(ins 4 " ")] {:children #{:m}})))))
    (testing "a whole-body save alike"
      (let [r (ta/plain-body "singers" "sing ers" [(t :s :s 0 7) (t :w :w 0 7) (t :si :m 0 2) (t :ngers :m 2 7)]
                             #{:s} #{:w} {:split-on-space true :children #{:m}})]
        (is (= [[:w 5 8] [:m 5 8]] (mapv (juxt :token/layer :token/begin :token/end) (:made r))))
        (is (= [2 4] ((juxt :token/begin :token/end) (some #(when (= :ngers (:token/id %)) %) (:tokens r)))))))))

(deftest layer-roles-deals-only-a-syntactic-word-layer
  (let [r (ta/layer-roles [{:id :s :overlap-mode "partitioning" :role "sentence"}
                           {:id :w :overlap-mode "non-overlapping" :parent :s :role "word" :split-on-space true}
                           {:id :m :overlap-mode "any" :parent :w :role "morpheme"}
                           {:id :x :overlap-mode "any" :parent :w :role "syntactic-word"}
                           {:id :u :overlap-mode "any" :role "syntactic-word"}])]
    (is (= #{:m :x} (:children r)))
    ;; a layer of that role not under the words is no child, so deals nothing
    (is (= #{:x} (:dealt r)))))

(deftest a-paste-over-several-words-reads-as-a-whole-body-save
  ;; REV-F-TEXT-CORE F1 to F5: one replace over several words, the paste a
  ;; Baseline or a row sends, is read as the whole-body save of the same
  ;; change reads it, so a repeated word, a second change, a word inserted
  ;; beside a respelled one or a script without spaces moves and deletes
  ;; no word the save keeps
  (doseq [[s new] [;; F1: a word that repeats, two changes
                   ["|ba|\n/|xa|\n/|cat| |xa| |xa| |end|" "xa\nxa\ncat xa end"]
                   ["|kon| |the| |the|\n/|kon|" "kon jalan the\nשלום"]
                   ["|a| |a| |b|" "x a bb"]
                   ["|jalan| |jalan| |ke| |pasar|\n/|saya| |makan| |nasi|" "jalang jalan ke pasar\nsaya makan nasih"]
                   ["|jalab| |jalan| |ke| |pasar|\n/|saya| |makan| |nasi|" "jalan jalan ke pasar\nsaya makan nasih"]
                   ["|I| |saw| |the| |the| |dog|\n/|it| |ran|" "I saw teh the dog\nit run"]
                   ;; F2: inside a stretch
                   ["|na| |kon| |tok| |ma|" "na oke kan tak ma"]
                   ["|the| |cat| |sat| |down|" "the c at sit down"]
                   ["|x| |cat,| |tat| |y|" "x a b c y"]
                   ;; F3: a word inserted beside a respelled one
                   ["|the| |cat| |sat| |down|" "the big cot sat down"]
                   ["|na| |kon| |tok| |ma|" "na oke kan tok ma"]
                   ;; F4: a run with punctuation typed over
                   ["|x| |cat|, |tat| |y|" "x dog, rat y"]
                   ;; F5: a script without spaces, two changes
                   ["|你||好||吗||。|/|我||很||好||。|" "你好嗎。我很好！"]
                   ["|你||好||吗||。|\n/|我||很||好||。|" "你好嗎。\n我很好！"]]]
    (let [{:keys [body]} (doc s)]
      (is (= (save s new) (edit s [(rep 0 (cp/cp-count body) new)])) (str (pr-str s) " -> " (pr-str new)))))
  (testing "what the save keeps there"
    (is (= ["xa\nxa\ncat xa end" "xa" "xa" "cat" nil "xa" "end"] (save "|ba|\n/|xa|\n/|cat| |xa| |xa| |end|" "xa\nxa\ncat xa end")))
    (is (= ["x a bb" "x" "a" "bb"] (save "|a| |a| |b|" "x a bb")))
    (is (= ["na oke kan tak ma" "na" "kan" "tak" "ma"] (save "|na| |kon| |tok| |ma|" "na oke kan tak ma")))
    ;; (a word made only of punctuation typed over is gone, and what is
    ;; typed there goes where it goes with no token there, REV8-PUNCT-1)
    (is (= ["你好嗎。我很好！" "你" "好" "嗎" "。" "我" "很" "好！" nil] (save "|你||好||吗||。|/|我||很||好||。|" "你好嗎。我很好！")))))

(deftest an-edit-that-only-deletes-or-only-types-is-taken-as-made
  ;; REV2-F-TEXT-CORE R1: a delete across a word boundary carries all it
  ;; means, and no reading of it deletes a word with letters left
  (is (= ["then" "th" "en"] (edit "|the| |then|" [(del 2 4)])))
  (is (= ["I saw then it ran" "I" "saw" "th" "en" "it" "ran"]
         (edit "|I| |saw| |the|\n/|then| |it| |ran|" [(del 8 4)])))
  (is (= ["at" "a" "t"] (edit "|at|\n/|at|" [(del 1 3)])))
  (is (= ["kan ma" "k" "an" "ma"] (edit "|ka| |kan| |ma|" [(del 1 3)])))
  (is (= ["a at" "a" nil "at"] (edit "|at| |at| |at|" [(del 1 4)])) "the word all of whose letters went")
  (testing "sentence 1 is kept"
    (let [{:keys [body tokens]} (doc "|at|\n/|at|")
          r (ta/plain-edits body tokens [(del 1 3)] #{:s} #{:w})]
      (is (empty? (filter #(= :s (first %)) (:deleted r)))))))

(deftest gaps-read-apart-rebuild-the-body-sent
  ;; REV2-F-TEXT-CORE R2: two gaps over several words and a typed gap between
  (let [{:keys [body tokens]} (doc "|an| |a| |a| |is| |sat|")
        ops [(rep 8 3 "x") (rep 4 1 "") (rep 1 1 "b a")]
        r (ta/plain-edits body tokens ops #{:s} #{:w})]
    (is (= (ta/edit-ops-body ops body) (:text/body (:text r))))))

(deftest a-line-typed-in-front-with-the-first-letter-changed-is-a-sentence
  ;; REV2-F-TEXT-CORE R4: `Oh my.\nH` typed over the `h` of `hi`
  (let [{:keys [body tokens]} (doc "|hi| |there.|\n/|bye|")
        r (ta/plain-edits body tokens [(rep 0 1 "Oh my.\nH")] #{:s} #{:w})
        nb (:text/body (:text r))
        w0 (some #(when (= [:w 0] (:token/id %)) %) (:tokens r))]
    (is (= "Oh my.\nHi there.\nbye" nb))
    (is (= "Hi" (cp/cp-subs nb (:token/begin w0) (:token/end w0))))
    (is (= [[0 7]] (mapv (juxt :token/begin :token/end) (:heads r))))))

(defn- big-save
  "Seconds a save of `places` two-word retypes (a word's last letter and the
  next one's first typed over as `x y`, read as a whole-body save reads it)
  and as many letters typed takes on 40,000 words, sentences by line or
  (`one-sentence?`) one sentence over the whole text, and the result."
  [places one-sentence?]
  (let [rng (java.util.Random. 7)
        syl ["ka" "na" "ma" "to" "ri" "lu" "se" "po" "ng" "wa" "the" "en"]
        word #(apply str (repeatedly (inc (.nextInt rng 3)) (fn [] (syl (.nextInt rng (count syl))))))
        sb (StringBuilder.)
        [ws ss] (loop [i 0 s0 0 ws [] ss []]
                  (if (< i 40000)
                    (let [w (word) b (.length sb)]
                      (.append sb w)
                      (let [ws (conj ws [b (.length sb)])]
                        (if (= 11 (mod i 12))
                          (do (.append sb "\n") (recur (inc i) (.length sb) ws (conj ss [s0 (.length sb)])))
                          (do (.append sb " ") (recur (inc i) s0 ws ss)))))
                    [ws (conj ss [s0 (.length sb)])]))
        body (str sb)
        ss (if one-sentence? [[0 (count body)]] ss)
        tokens (-> []
                   (into (map-indexed (fn [i [b e]] {:token/id [:s i] :token/layer :s :token/begin b :token/end e}) ss))
                   (into (mapcat (fn [i [b e]] [{:token/id [:w i] :token/layer :w :token/begin b :token/end e}
                                                {:token/id [:m i] :token/layer :m :token/begin b :token/end e}])
                                 (range) ws)))
        picks (vec (sort (distinct (repeatedly (* 2 places) #(+ 10 (.nextInt rng (- (count ws) 20)))))))
        picks (vec (take places (map first (partition-all 1 (remove (set (map inc picks)) picks)))))
        ops (->> picks
                 (mapcat (fn [i] (let [[_ e] (ws i) [b2] (ws (inc i)) [b0] (ws (- i 2))]
                                   [(rep (dec e) (- (inc b2) (dec e)) "x y") (ins (inc b0) "q")])))
                 (sort-by #(- (:index %)))
                 vec)
        run #(ta/plain-edits body tokens ops #{:s} #{:w} {:children #{:m}})
        _ (run)
        t0 (System/nanoTime)
        r (run)]
    {:secs (/ (- (System/nanoTime) t0) 1e9) :r r :body (ta/edit-ops-body ops body)}))

(deftest many-edits-on-40000-words-save-in-seconds
  ;; REV2-F-TEXT-CORE R3: a save of many edits over word boundaries read
  ;; each over the whole body (396 ops 42 s); REV3-F-TEXT-CORE G1: one long
  ;; token (a text in one sentence) made each read scan every token (6,000
  ;; gaps 30 s). Idle, these take 0.6 s and 2.9 s (11.4 s with the long
  ;; token scanned); each bound leaves room for a busy machine and still
  ;; catches the shape.
  (doseq [[places one? bound] [[200 false 5.0] [4000 true 8.0]]]
    (let [{:keys [secs r body]} (big-save places one?)]
      (is (= body (:text/body (:text r))))
      (is (empty? (filter #(= :w (first %)) (:deleted r))) "no word with letters left is deleted")
      (is (< secs bound) (str places (when one? " in one sentence") ": " secs " s")))))

(deftest a-word-typed-over-beside-its-twin-keeps-its-token
  ;; REV3-F-TEXT-CORE G2: the diff deletes `你` and types `好` after the next
  ;; `好`; the same text is `你` typed over as `好`, which keeps every word
  ;; but the `。` typed over as `！`: a word made only of punctuation does
  ;; not survive that, and the `！` goes to the word before as where the
  ;; `。` has no token (REV8-PUNCT-1)
  (is (= ["我好好吗！" "我" "好" "好" "吗！" nil] (save "|我||你||好||吗||。|" "我好好吗！")))
  (is (= ["我好好吗！" "我" "好" "好" "吗！" nil] (edit "|我||你||好||吗||。|" [(rep 0 5 "我好好吗！")])))
  (is (= ["我你你吗！" "我" "你" "你" "吗！" nil] (save "|我||你||好||吗||。|" "我你你吗！")))
  (testing "spaced text was already right"
    (is (= ["x cd cd y." "x" "cd" "cd" "y."] (save "|x| |ab| |cd| |y|" "x cd cd y.")))))

(deftest a-word-layer-with-no-tokens-reads-as-none
  ;; R1-DEBT-CORE-12: which tokens are the words is decided one way on
  ;; every path. A word layer that holds no token yet (a script made it but
  ;; has not tokenized this text) is as good as none, so the tokens on no
  ;; partition decide, for the whole-body reading as for the plain rule.
  ;; The whole-body reading aligned to the empty layer's words before.
  (let [toks (fn [body]
               (let [m (re-matcher #"[^ .]+" body)]
                 (into [{:token/id :s :token/layer :s :token/begin 0 :token/end (cp/cp-count body)}]
                       (loop [out [] i 0]
                         (if (.find m)
                           (recur (conj out {:token/id i :token/layer :x :token/begin (.start m) :token/end (.end m)}) (inc i))
                           out)))))
        opts {:children #{} :exclusive #{:x}}]
    (doseq [[body new] [["btd c tttt tbaa td." "btd cY ttttX td."]
                        ["abdc bcat aa t daac." "bcat."]]]
      (let [t (toks body)]
        (is (= (ta/plain-body body new t #{:s} #{:x} opts)
               (ta/plain-body body new t #{:s} #{:w} opts)
               (ta/plain-body body new t #{:s} #{} opts))
            (str (pr-str body) " -> " (pr-str new)))
        (is (= (ta/plain-edits body t [{:type :replace :index 0 :length (cp/cp-count body) :value new}] #{:s} #{:x} opts)
               (ta/plain-edits body t [{:type :replace :index 0 :length (cp/cp-count body) :value new}] #{:s} #{:w} opts))
            (str "edits " (pr-str body) " -> " (pr-str new)))))))

(deftest a-space-typed-in-a-row-of-a-text-with-no-words-splits-nothing
  ;; REV6-TEXT-1: with no word token (a transcript typed on the Media tab
  ;; in a script without spaces, or with Tokenize new text off) the rows
  ;; decide where text goes, but they are no words: `splitOnSpace` split
  ;; the row into a new row over its first part while the row stayed, and
  ;; the save was refused with 409.
  (let [body "Ana runs. Ben sits."
        tokens [{:token/id [:s 0] :token/layer :s :token/begin 0 :token/end 10}
                {:token/id [:s 1] :token/layer :s :token/begin 10 :token/end 19}
                {:token/id [:r 0] :token/layer :r :token/begin 0 :token/end 9}
                {:token/id [:r 1] :token/layer :r :token/begin 10 :token/end 19}]
        opts {:split-on-space true :children #{:m} :exclusive #{:w :r}}]
    (doseq [[op new rows] [[(ins 1 " ") "A na runs. Ben sits." [[0 10] [11 20]]]
                           [(ins 4 " ") "Ana  runs. Ben sits." [[0 10] [11 20]]]
                           [(ins 4 "\t") "Ana \truns. Ben sits." [[0 10] [11 20]]]
                           [(ins 4 "and ") "Ana and runs. Ben sits." [[0 13] [14 23]]]
                           [(ins 16 " ") "Ana runs. Ben si ts." [[0 9] [10 20]]]]]
      (doseq [[path r] [[:edits (ta/plain-edits body tokens [op] #{:s} #{:w} opts)]
                        [:body (ta/plain-body body new tokens #{:s} #{:w} opts)]]]
        (is (= new (:text/body (:text r))) (str path " " (pr-str op)))
        (is (empty? (:made r)) (str path " " (pr-str op) " makes no token"))
        (is (= rows (vec (sort (keep #(when (= :r (:token/layer %)) [(:token/begin %) (:token/end %)]) (:tokens r)))))
            (str path " " (pr-str op) " rows"))))))

(deftest a-point-inside-a-part-a-split-makes-goes-to-its-edge
  ;; REV4-TEXT seen: a time-alignment layer given a child layer decides, so
  ;; `splitOnSpace` splits its rows too, and a point at a row's end that the
  ;; new part grew over stayed inside it (the save would answer 409)
  (let [roles (ta/layer-roles [{:id :s :overlap-mode "partitioning"}
                               {:id :w :overlap-mode "non-overlapping" :parent :s :split-on-space true}
                               {:id :r :overlap-mode "non-overlapping"}
                               {:id :c :overlap-mode "any" :parent :r}])
        body "Ab cd ef gh. Xy."
        tokens [{:token/id :s :token/layer :s :token/begin 0 :token/end 16}
                {:token/id :r :token/layer :r :token/begin 0 :token/end 12}
                {:token/id :p :token/layer :r :token/begin 12 :token/end 12}]
        r (ta/plain-edits body tokens [(ins 9 " ") (ins 13 "So ")] (:partitioning roles) (:deciders roles)
                          (select-keys roles [:split-on-space :children :dealt :exclusive :head-layers]))
        rows (concat (filter #(= :r (:token/layer %)) (:tokens r)) (filter #(= :r (:token/layer %)) (:made r)))]
    (is (= "Ab cd ef  gh.So  Xy." (:text/body (:text r))))
    (is (= [[0 8] [10 15] [15 15]] (sort (map (juxt :token/begin :token/end) rows))))))

(defn- runs-doc
  "`body` with one sentence and a word token `[:w i]` over each run of
  letters, and with `punct?` also one over each run of punctuation, as ud's
  Tokenize leaves a text igt tokenized."
  [body punct?]
  (let [m (re-matcher (if punct? #"[\p{L}\p{N}]+|[\p{P}\p{S}]+" #"[\p{L}\p{N}]+") body)]
    (into [{:token/id [:s 0] :token/layer :s :token/begin 0 :token/end (cp/cp-count body)}]
          (loop [out [] i 0]
            (if (.find m)
              (recur (conj out {:token/id [:w i] :token/layer :w :token/begin (.start m) :token/end (.end m)}) (inc i))
              out)))))

(deftest a-letter-typed-against-a-punctuation-token-never-joins-it
  ;; REV7-IGT-1 (parent, under Luke's "igt must not change because ud
  ;; annotation started"): ud's Tokenize gives punctuation a word token,
  ;; which igt reads as text. A letter typed against it went into it (`,x`,
  ;; `(x`, `x,`), where without the token igt made the word `x` or `xcd`.
  ;; Now the same letters make the same words either way, on both paths.
  (let [words (fn [r]
                (let [body (:text/body (:text r))]
                  (vec (sort (keep (fn [{:token/keys [layer begin end]}]
                                     (when (= :w layer)
                                       (let [t (cp/cp-subs body begin end)]
                                         (when-not (re-matches #"[\p{P}\p{S}]+" t) [begin t]))))
                                   (:tokens r))))))
        puncts (fn [r]
                 (let [body (:text/body (:text r))]
                   (keep (fn [{:token/keys [layer begin end]}]
                           (when (= :w layer)
                             (let [t (cp/cp-subs body begin end)]
                               (when-not (re-find #"[\p{L}\p{N}]" t) t))))
                         (:tokens r))))]
    (doseq [[id body op expect] [["B1" "ab, cd" (ins 3 "x") ["ab" "cd"]]
                                 ["B2" "ab cd.ef" (ins 6 "x") ["ab" "cd" "xef"]]
                                 ["B3" "ab (cd)" (ins 4 "x") ["ab" "xcd"]]
                                 ["B4" "ab cd." (ins 6 "x") ["ab" "cd"]]
                                 ["B5" "ab, cd" (ins 3 " y") ["ab" "cd"]]
                                 ["B6" "ab «cd» ef" (ins 7 "z") ["ab" "cd" "ef"]]
                                 ["B7" "ab, cd" (ins 2 "q") ["abq" "cd"]]
                                 ["B8" "ab ¿cd?" (ins 4 "Q") ["ab" "Qcd"]]
                                 ["B9" "ab, cd" (del 2 1) ["ab" "cd"]]
                                 ["B10" "ab ,cd" (ins 3 "x") ["ab" "cd"]]
                                 ["replace" "ab ?!cd" (rep 4 2 "x") ["ab" "xd"]]
                                 ["two" "ab (cd)" (ins 4 "x y") ["ab" "ycd"]]]
            punct? [false true]
            :let [tokens (runs-doc body punct?)
                  new (ta/edit-ops-body [op] body)]
            [path r] [[:edits (ta/plain-edits body tokens [op] #{:s} #{:w})]
                      [:body (ta/plain-body body new tokens #{:s} #{:w})]]]
      (is (= expect (mapv second (words r))) (str id " " path (when punct? " with punctuation tokens")))
      (when punct?
        (is (every? #(re-matches #"[\p{P}\p{S}]+" %) (puncts r)) (str id " " path " punctuation stays punctuation"))))))

(deftest a-letter-like-character-is-a-letter-to-the-punctuation-rule
  ;; FX-I-FOLLOW 1: in a project whose ignored-tokens rule lists `'` as
  ;; letter-like, a word `'` is a word to igt, so a letter typed against it
  ;; joins it as one typed against a letter does, on both paths. Without the
  ;; list it stays apart, as a punctuation token does (REV7-IGT-1).
  (let [ll #{(int \')}
        word-texts (fn [r]
                     (let [body (:text/body (:text r))]
                       (vec (sort-by first (keep (fn [{:token/keys [layer begin end]}]
                                                   (when (= :w layer) [begin (cp/cp-subs body begin end)]))
                                                 (:tokens r))))))
        doc (fn [body spans] (into [{:token/id [:s 0] :token/layer :s :token/begin 0 :token/end (cp/cp-count body)}]
                                   (map-indexed (fn [i [b e]] {:token/id [:w i] :token/layer :w :token/begin b :token/end e}) spans)))]
    (doseq [[id body spans op with without]
            [["after" "ab ' cd" [[0 2] [3 4] [5 7]] (ins 4 "x") ["ab" "'x" "cd"] ["ab" "'" "cd"]]
             ["before" "ab ' cd" [[0 2] [3 4] [5 7]] (ins 3 "x") ["ab" "x'" "cd"] ["ab" "'" "cd"]]
             ["inside a word" "ab 'cd" [[0 2] [3 6]] (ins 3 "x") ["ab" "x'cd"] ["ab" "x'cd"]]]
            [letter-like expect] [[ll with] [#{} without]]
            :let [tokens (doc body spans)
                  new (ta/edit-ops-body [op] body)
                  opts {:letter-like letter-like}]
            [path r] [[:edits (ta/plain-edits body tokens [op] #{:s} #{:w} opts)]
                      [:body (ta/plain-body body new tokens #{:s} #{:w} opts)]]]
      (is (= expect (mapv second (word-texts r))) (str id " " path (when (seq letter-like) " with ' letter-like"))))))

(deftest the-punctuation-rule-reads-the-unicode-16-table
  ;; FX-I-FOLLOW 2: U+10D6E (Garay hyphen) is new in Unicode 16, so Java 21
  ;; reads it as unassigned. igt ignores it, and core's rule reads the same
  ;; table: a token of only it takes no letter typed against it.
  (let [body "ab \uD803\uDD6E cd"
        tokens [{:token/id [:s 0] :token/layer :s :token/begin 0 :token/end 7}
                {:token/id [:w 0] :token/layer :w :token/begin 0 :token/end 2}
                {:token/id [:w 1] :token/layer :w :token/begin 3 :token/end 4}
                {:token/id [:w 2] :token/layer :w :token/begin 5 :token/end 7}]
        r (ta/plain-edits body tokens [(ins 4 "x")] #{:s} #{:w})]
    (is (= [[0 2] [3 4] [6 8]]
           (sort (keep #(when (= :w (:token/layer %)) [(:token/begin %) (:token/end %)]) (:tokens r)))))))

(deftest a-layer-config-names-its-letter-like-characters
  (is (= #{(int \') 0x2019} (ta/ignored-letter-like {"igt" {"ignoredTokens" {"type" "unicodePunctuation"
                                                                             "whitelist" ["'" "\u2019" "ab" ""]}}})))
  (let [ll (ta/ignored-letter-like {"igt" {"ignoredTokens" {"type" "blacklist" "whitelist" ["'"] "blacklist" ["." "..."]}}})]
    ;; under an explicit list every punctuation character but the listed
    ;; ones is a letter, and nothing else is letter-like
    (is (ll (int \')))
    (is (ll (int \;)))
    (is (not (ll (int \.))))
    (is (not (ll (int \a))))
    (is (not (ll (int \space)))))
  (is (= #{} (ta/ignored-letter-like {})))
  (is (= #{(int \')} (:letter-like (ta/layer-roles [{:id :w :overlap-mode "non-overlapping" :parent :s :letter-like #{(int \')}}
                                                    {:id :s :overlap-mode "partitioning"}])))))

(deftest a-typed-nel-parts-words-as-a-line-feed-does
  ;; REV8-CORE-4: NEL ends a line to the sentence, head and row rules, and
  ;; igt's tokenizer reads it as whitespace, but a word took it: `cd` with
  ;; `<NEL>x` typed after it became the word `cd<NEL>x`, where a line feed
  ;; leaves `cd` as it was
  (doseq [[s op] [["|ab| |cd|" (ins 5 "\nx")]
                  ["|ab| |cd|" (ins 2 "\ny")]
                  ["|ab| |cd|" (ins 1 "\nz")]
                  ["|ab| |cd|" (rep 1 3 "q\nr")]]]
    (let [nel (fn [x] (if (string? x) (str/replace x "\n" "\u0085") x))
          lf (edit s [op])
          op-nel (update op :value nel)]
      (is (= (mapv nel lf) (edit s [op-nel])) (pr-str s op))
      (is (= (mapv nel lf) (save s (ta/edit-ops-body [op-nel] (:body (doc s))))) (pr-str s op)))))

(defn- words-of
  "The texts of the `:w` tokens of `r` in order, leaving out those `ll`
  (letter-like, as `ignored-letter-like` gives it) reads as made only of
  punctuation: what igt shows."
  ([r] (words-of r #{}))
  ([r ll]
   (let [body (:text/body (:text r))]
     (vec (keep (fn [{:token/keys [begin end] :as t}]
                  (when (and (= :w (:token/layer t)) (not (@#'ta/punct-only? (.toArray (.codePoints ^String body)) ll t)))
                    (cp/cp-subs body begin end)))
                (sort-by :token/begin (:tokens r)))))))

(deftest a-punctuation-token-typed-over-reads-as-no-token-there
  ;; REV8-PUNCT-1 (Luke's igt-unchanged rule): ud's Tokenize gives `,` a
  ;; word token. A selection of it typed over kept the token on the new
  ;; text, so `ab, cd` with `,` typed over as `x` gave igt the words `ab`
  ;; `x` `cd` (and `x` carried ud's lemma `,`), where with no token there it
  ;; gives `abx` `cd`. The token is now gone, with what is under it, and
  ;; the words are those of the text with no token there, on both paths.
  (let [toks (fn [body spans]
               (into [{:token/id [:s 0] :token/layer :s :token/begin 0 :token/end (cp/cp-count body)}]
                     (mapcat (fn [i [b e]] [{:token/id [:w i] :token/layer :w :token/begin b :token/end e}
                                            {:token/id [:m i] :token/layer :m :token/begin b :token/end e}])
                             (range) spans)))
        opts {:children #{:m}}]
    (doseq [[id body plain punct op want]
            [["R1" "ab, cd" [[0 2] [4 6]] [[2 3]] (rep 2 1 "x") ["abx" "cd"]]
             ["R3" "ab. cd" [[0 2] [4 6]] [[2 3]] (rep 2 1 "‼") ["ab‼" "cd"]]
             ["R5" "Ana, kuti (mo) ok." [[0 3] [5 9] [11 13] [15 17]] [[3 4] [10 11] [13 14] [17 18]] (rep 10 1 "x") ["Ana" "kuti" "xmo" "ok"]]
             ["R7" "ab cd." [[0 2] [3 5]] [[5 6]] (rep 5 1 "!") ["ab" "cd!"]]
             ["R9" "ab, cd" [[0 2] [4 6]] [[2 3]] (rep 2 1 ";") ["ab;" "cd"]]
             ["two words" "ab? cd" [[0 2] [4 6]] [[2 3]] (rep 2 1 "x y") ["abx" "cd"]]
             ["into a run" "ab ... cd" [[0 2] [7 9]] [[3 6]] (ins 4 "x") ["ab" "cd"]]
             ["over part of it" "ab ?! cd" [[0 2] [6 8]] [[3 5]] (rep 4 1 "x") ["ab" "cd"]]
             ["with a word" "ab, cd" [[0 2] [4 6]] [[2 3]] (rep 1 2 "x") ["ax" "cd"]]]
            :let [new (ta/edit-ops-body [op] body)]
            [path f] [[:edits #(ta/plain-edits body % [op] #{:s} #{:w} opts)]
                      [:body #(ta/plain-body body new % #{:s} #{:w} opts)]]]
      (let [without (f (toks body plain))
            with (f (toks body (sort (concat plain punct))))]
        (is (= want (words-of without)) (str id " " path " with no token"))
        (is (= want (words-of with)) (str id " " path " with punctuation tokens"))
        (is (= (:text/body (:text without)) (:text/body (:text with))))
        ;; the morphemes under the punctuation went with it
        (is (= (count (filter #(= :w (:token/layer %)) (:tokens with)))
               (count (filter #(= :m (:token/layer %)) (:tokens with))))
            (str id " " path))))))

(deftest the-punctuation-rule-is-for-words-not-rows
  ;; REV8-PUNCT-2: in a text with no words the rows decide, and a pause
  ;; row `...` took no text typed against it, which was then in no row.
  ;; The punctuation rule is for words only.
  (let [body "ab cd ... ef gh"
        tokens [{:token/id [:s 0] :token/layer :s :token/begin 0 :token/end 15}
                {:token/id [:a 0] :token/layer :a :token/begin 0 :token/end 5}
                {:token/id [:a 1] :token/layer :a :token/begin 6 :token/end 9}
                {:token/id [:a 2] :token/layer :a :token/begin 10 :token/end 15}]
        rows (fn [r] (let [b (:text/body (:text r))]
                       (vec (keep #(when (= :a (:token/layer %)) (cp/cp-subs b (:token/begin %) (:token/end %)))
                                  (sort-by :token/begin (:tokens r))))))
        opts {:exclusive #{:a :w}}]
    (is (= ["ab cd" "...x" "ef gh"] (rows (ta/plain-edits body tokens [(ins 9 "x")] #{:s} #{:w} opts))))
    (is (= ["ab cd" "...x" "ef gh"] (rows (ta/plain-body body "ab cd ...x ef gh" tokens #{:s} #{:w} opts))))))

(deftest the-punctuation-rule-reads-the-projects-rule
  ;; REV8-PUNCT-5: core read every project with the default rule, so in a
  ;; project where `=` is letter-like, or under an explicit list without
  ;; `;`, or an empty one, a letter typed after a lone `=`, `;` or `...`
  ;; stayed apart, where igt's Tokenize makes one word of them
  (let [rule (fn [r] (ta/ignored-letter-like {"igt" {"ignoredTokens" r}}))
        doc (fn [body spans] (into [{:token/id [:s 0] :token/layer :s :token/begin 0 :token/end (cp/cp-count body)}]
                                   (map-indexed (fn [i [b e]] {:token/id [:w i] :token/layer :w :token/begin b :token/end e}) spans)))]
    (doseq [[id r body spans op want]
            [["ll" {"type" "unicodePunctuation" "whitelist" ["="]} "ab = cd" [[0 2] [3 4] [5 7]] (ins 4 "ta") ["ab" "=ta" "cd"]]
             ["bl" {"type" "blacklist" "blacklist" ["." ","]} "ab ; cd" [[0 2] [3 4] [5 7]] (ins 4 "x") ["ab" ";x" "cd"]]
             ["bl listed" {"type" "blacklist" "blacklist" ["." ";"]} "ab ; cd" [[0 2] [3 4] [5 7]] (ins 4 "x") ["ab" ";" "cd"]]
             ["bl0" {"type" "blacklist" "blacklist" []} "ab ... cd" [[0 2] [3 6] [7 9]] (ins 6 "x") ["ab" "...x" "cd"]]
             ["default" {"type" "unicodePunctuation" "whitelist" []} "ab ... cd" [[0 2] [3 6] [7 9]] (ins 6 "x") ["ab" "..." "cd"]]]
            :let [tokens (doc body spans)
                  opts {:letter-like (rule r)}]
            [path res] [[:edits (ta/plain-edits body tokens [op] #{:s} #{:w} opts)]
                        [:body (ta/plain-body body (ta/edit-ops-body [op] body) tokens #{:s} #{:w} opts)]]]
      (is (= want (let [b (:text/body (:text res))]
                    (vec (keep #(when (= :w (:token/layer %)) (cp/cp-subs b (:token/begin %) (:token/end %)))
                               (sort-by :token/begin (:tokens res))))))
          (str id " " path)))))

(deftest text-typed-after-a-letter-like-sentence-end-stays-in-its-sentence
  ;; FX-I-FOLLOW left the sentence-edge rule on Java's categories: text
  ;; typed right after punctuation the sentence before ends on goes to the
  ;; sentence after. Now it reads the project's rule from the shared table:
  ;; after a letter-like `'` the text stays with its word, in the sentence
  ;; before, and after `.` it goes on as before.
  (let [sents (fn [r] (let [b (:text/body (:text r))]
                        (vec (keep #(when (= :s (:token/layer %)) (cp/cp-subs b (:token/begin %) (:token/end %)))
                                   (sort-by :token/begin (:tokens r))))))
        tokens (fn [body cut] [{:token/id [:s 0] :token/layer :s :token/begin 0 :token/end cut}
                               {:token/id [:s 1] :token/layer :s :token/begin cut :token/end (cp/cp-count body)}
                               {:token/id [:w 0] :token/layer :w :token/begin 0 :token/end cut}
                               {:token/id [:w 1] :token/layer :w :token/begin cut :token/end (cp/cp-count body)}])
        ll (ta/ignored-letter-like {"igt" {"ignoredTokens" {"type" "unicodePunctuation" "whitelist" ["'"]}}})]
    (is (= ["ab'x" "cd"] (sents (ta/plain-edits "ab'cd" (tokens "ab'cd" 3) [(ins 3 "x")] #{:s} #{:w} {:letter-like ll}))))
    (is (= ["ab'" "xcd"] (sents (ta/plain-edits "ab'cd" (tokens "ab'cd" 3) [(ins 3 "x")] #{:s} #{:w}))))
    (is (= ["ab." "xcd"] (sents (ta/plain-edits "ab.cd" (tokens "ab.cd" 3) [(ins 3 "x")] #{:s} #{:w} {:letter-like ll}))))))
