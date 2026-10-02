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
    (view (ta/plain-edits body tokens ops #{:s} #{:w}) (count (filter #(= :w (:token/layer %)) tokens)))))

(defn- save [s new]
  (let [{:keys [body tokens]} (doc s)]
    (view (ta/plain-body body new tokens #{:s} #{:w}) (count (filter #(= :w (:token/layer %)) tokens)))))

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
  ;; the sentence before holds the stretch typed over, and the letters typed
  ;; against the next word go with it into the next sentence
  (let [{:keys [body tokens]} (doc "|köye| |a| /|dog|")
        r (ta/plain-edits body tokens [(rep 5 2 "XZ XZ XZ")] #{:s} #{:w})
        at (fn [id] (let [t (some #(when (= id (:token/id %)) %) (:tokens r))] [(:token/begin t) (:token/end t)]))]
    (is (= "köye XZ XZ XZdog" (:text/body (:text r))))
    (is (= [11 16] (at [:w 2]) (at [:s 1])))
    (is (= [0 11] (at [:s 0])))))

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
  ;; D28 has it, the tokens inside it dropped and those as long as it moved
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

(deftest text-typed-between-two-sentences-goes-by-the-caret
  ;; Luke (2026-09-30): right after the last letter of a sentence, it joins
  ;; that sentence; right before the first letter of the next, it joins the
  ;; next; in the middle of a longer run of whitespace, or with no caret (a
  ;; whole-body save), the sentence before.
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
      (is (= ["Hi. " "New The end."] (sents "|Hi.| /|The| |end.|" [(ins 4 "New ")]))))
    (testing "right after the last letter of a sentence whose whitespace is the next one's"
      (is (= ["Hi. And more." " The end."] (sents "|Hi.|/ |The| |end.|" [(ins 3 " And more.")]))))
    (testing "in the middle of a longer run of whitespace"
      (is (= ["Hi.  X  " "  The end."] (sents "|Hi.|  /  |The| |end.|" [(ins 5 "X  ")]))
          "a boundary inside the run: the sentence before"))
    (testing "a whole-body save knows no caret: the sentence before"
      (is (= ["Hi. New " "The end."] (sents "|Hi.| /|The| |end.|" nil "Hi. New The end."))))))

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
  ;; more new words than old: the last old word goes to the new word left
  ;; sharing most letters with it, the first on a tie, and the other new
  ;; words are in no word, as a word typed apart is (H1-IGT-TEXT-1: it held
  ;; the rest, so `jadi` pasted over as `xy\njjadi` was one token across a
  ;; line break)
  (is (= ["a x y z b" "a" "x" "y" "b"] (edit "|a| |cat| |eel| |b|" [(rep 2 7 "x y z")])))
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
  ;; one keeps its token whole, the first as the text cannot tell which
  (is (= ["a thee da. b" "a" "thee da" nil "b"]
         (edit "|a| |thee da| |thee da|. |b|" [(rep 0 20 "a thee da. b")])))
  ;; a word deleted before punctuation: the word before keeps off it
  (is (= ["on köye. a" "on" "köye" nil "a"] (edit "|on| |köye| |tat|. |a|" [(rep 0 14 "on köye. a")]))))

(deftest a-split-makes-each-other-part-a-word-of-its-own
  ;; Q2-UD-POLISH-2 (Luke, 2026-10-02): on a layer that splits on space, a
  ;; space typed inside a word splits it. The part holding more letters keeps
  ;; the token and what hangs off it, and the other part is a new token of
  ;; the layer, with a new token under it on each layer the word had one as
  ;; long as it on. A multi-word token's words (as long as it, told apart by
  ;; precedence) go one to each part when there are as many.
  (let [t (fn [id l b e & [p]] (cond-> {:token/id id :token/layer l :token/begin b :token/end e} p (assoc :token/precedence p)))
        opts {:split-on-space true :children #{:x}}
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
