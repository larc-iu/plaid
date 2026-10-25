(ns plaid.algos.plain-edits-paste-oracle-test
  "The plain-edits oracle on pastes over several words. The generators and the
  judge are in `plaid.algos.plain-edits-oracle`."
  (:require [clojure.test :refer [deftest is testing]]
            [plaid.algos.plain-edits-oracle :as o :refer [cps gen-doc layout-tokens lost-problems nbsp problems run save server-gaps]]
            [plaid.algos.text :as ta]
            [plaid.util.codepoint :as cp]))

;; ---------------------------------------------------------------- pastes over several words

;; H1-IGT-TEXT-1: the same text pasted back with a word more, a word less
;; or a word typed over, over the whole body, a line or any stretch of whole
;; words, read old word i as new word i, so every word after the change took
;; its neighbour's analysis and sentences went. REV-F-TEXT-CORE: with a word
;; that repeats and two changes, or in a script without spaces, pairing the
;; words of the stretch by any rule of its own still put words on the wrong
;; copy or deleted those between the changes. A replace over several words
;; is now read as a whole-body save reads the same change, so a paste (W)
;; reads as the exact edits (X) or the whole-body save (B) do.

(defn- one-word-change
  "`[start end value]`: one word typed in before or after `w`, `w` deleted
  with the whitespace on one side of it, or `w` typed over, or nil when `w`
  is its sentence's only word and the change would delete it. `words` are
  the words typed (some may be words the text has), `sep` what stands
  between words."
  [^java.util.Random rng ^ints o w sole? words sep]
  (let [{:token/keys [begin end]} w
        n (alength o)
        blank? (fn [c] (or (= c (int \space)) (= c (int \tab))))
        run-after (loop [x end] (if (and (< x n) (blank? (aget o x))) (recur (inc x)) x))
        run-before (loop [x begin] (if (and (pos? x) (blank? (aget o (dec x)))) (recur (dec x)) x))
        word (nth words (.nextInt rng (count words)))]
    (case (.nextInt rng 4)
      0 [begin begin (str word sep)]
      1 [end end (str sep word)]
      2 (when-not sole?
          (cond (< end run-after) [begin run-after ""]
                (< run-before begin) [run-before end ""]
                (= sep "") [begin end ""]
                :else nil))
      3 [begin end word])))

(defn- placed-words
  "`[[old text, new text] of each word left, in order, deleted words' old
  texts]` after `r`: a word of the same text may stand in for another, as
  where a word typed in has the text of its neighbour (`a b` to `a a b`)."
  [^ints o tokens r]
  (let [text (fn [{:token/keys [begin end]}] (String. o (int begin) (int (- end begin))))
        nw (cps (:text/body (:text r)))
        old-of (into {} (map (juxt :token/id identity)) tokens)
        gone (set (:deleted r))]
    [(->> (:tokens r)
          (filter #(= :w (:token/layer %)))
          (remove #(gone (:token/id %)))
          (map (fn [t] [(text (old-of (:token/id t))) (String. nw (int (:token/begin t)) (int (- (:token/end t) (:token/begin t))))]))
          frequencies)
     (sort (map text (filter #(and (= :w (:token/layer %)) (gone (:token/id %))) tokens)))]))

(defn- paste-problems
  "What is wrong with `r`, a paste over `old` holding the `changes` (`[a b
  value]` each, in order, apart), for `tokens`, against the nearest of
  `refs`, the same change sent as exact edits and saved as a whole body:
  its words on the same text and the same words deleted as one of them (a word of the same
  text may stand in for another), no sentence deleted unless that one
  deletes it, and every word apart from the changes, not beside one, on its
  own text where they leave it."
  [^String old tokens changes r refs]
  (let [o (cps old)
        got (placed-words o tokens r)
        sentence-gone (fn [r] (some #(and (= :s (:token/layer %)) ((set (:deleted r)) (:token/id %))) tokens))
        shift (fn [x] (reduce (fn [y [a b v]] (if (<= b x) (+ y (- (cp/cp-count v) (- b a))) y)) x changes))
        once (frequencies (keep #(when (= :w (:token/layer %)) (String. o (int (:token/begin %)) (int (- (:token/end %) (:token/begin %))))) tokens))
        apart (into {} (keep (fn [{:token/keys [begin end] :as w}]
                               (let [t (String. o (int begin) (int (- end begin)))]
                                 (when (and (= :w (:token/layer w)) (= 1 (once t))
                                            (not-any? (fn [[_ _ v]] (.contains ^String v t)) changes)
                                            (every? (fn [[a b]] (or (< end (dec a)) (< (inc b) begin))) changes))
                                   [[(shift begin) (shift end)] t]))))
                    tokens)]
    (first
     (sort-by count
              (for [ref refs]
                (cond-> []
                  (not= (:text/body (:text r)) (:text/body (:text (first refs)))) (conj (str "body " (pr-str (:text/body (:text r)))))
                  (not= got (placed-words o tokens ref))
                  (conj (let [[w gw] (placed-words o tokens ref) [g gg] got]
                          (str "words " (pr-str (remove (set g) w)) " got " (pr-str (remove (set w) g))
                               " deleted " (pr-str gg) " want " (pr-str gw))))
                  (not-every? (fn [[[b e] t]] (some #(and (= b (:token/begin %)) (= e (:token/end %)) (not ((set (:deleted r)) (:token/id %)))) (:tokens r)))
                              apart)
                  (conj "a word apart from the changes moved")
                  (and (sentence-gone r) (not (sentence-gone ref))) (conj "a sentence deleted")))))))

(def ^:private paste-configs
  {:apps {:spaced 0.3 :sentences 4 :words 8}
   :apps-nodes-and-children {:spaced 0.2 :nodes true :child 0.5 :points 0.2 :sentences 4 :words 8}
   :long {:spaced 0.2 :sentences 10 :words 14 :sentence-segments true}
   :script {:spaced 0.3 :sentences 4 :words 8 :layout :script}
   :rooted {:spaced 0.2 :sub 1.0 :one-morph true :sentences 4 :words 8 :layout :rooted}
   :script-no-sentences {:spaced 0.3 :words 12 :layout :script-no-sentences}
   :other-spaces {:spaced 0.2 :sentences 4 :words 8 :seps [" " nbsp "\t" "   "] :sentence-seps ["\n" ". " "\n\n"]}
   ;; a small vocabulary that repeats, the words typed among it
   :repeating {:spaced 0 :sentences 3 :words 6 :vocab ["xa" "ba" "cat" "the" "a"] :typed-words ["xa" "the" "a" "teh"]
               :sentence-seps ["\n"] :changes 3}
   :repeating-phrases {:spaced 0.3 :sentences 3 :words 6 :vocab ["a" "b" "talu" "lei"] :typed-words ["a" "b" "lei"] :changes 2}
   ;; a script without spaces: one word a character
   :spaceless {:spaced 0 :glue 1.0 :sentences 3 :words 6 :vocab ["你" "好" "吗" "我" "很" "。"] :typed-words ["嗎" "好" "！"]
               :sep "" :sentence-seps ["" "\n"] :changes 2}})

(def ^:private paste-ceiling
  "Pastes, of the 6,750 the test below makes, read as the whole-body save of
  the same change reads them although that deletes a word or sentence the
  exact edits keep (REV3-F-TEXT-CORE G2 sorted them):
  - 2 are twins the text cannot tell apart: one of two words of the same
    character either side of a sentence break deleted in a script without
    spaces (`好好我好` pasted as `好我好`). The save deletes the first and its
    one-word sentence, the edit the second.
  - 2 are explained more cheaply by more deletions: the exact edits change
    more letters than the diff does.
  - 16 are a known limit of reading a paste without pairing its words, which
    REV-F-TEXT-CORE ruled out. Two or three changes in one stretch, and the
    diff takes another longest common subsequence of the same length as the
    exact edits, which deletes one word more (`a ba the` pasted as `the ba`:
    `a` and `ba` deleted and ` ba` typed, where the edits type `the` over `a`
    and delete ` the`). The single-change forms read right.
  The spaceless pastes of a word typed over beside its twin (`我你好吗。` as
  `我好好吗！`) were 4 more, until `slide-to-tokens` let an insert stand against
  a delete of exactly one token. Lower this whenever the count drops.
  20 when pinned (2026-10-02)."
  20)

(deftest a-paste-over-several-words-reads-as-the-edits-or-the-whole-body-save
  (let [as-saved (atom [])]
    (doseq [[cname opts] paste-configs
            k (range 1 (inc (:changes opts 3)))]
      (let [fails (atom [])]
        (dotimes [seed 250]
          (let [rng (java.util.Random. (+ seed (* 31 k) (* 104729 (hash cname))))
                layout (:layout opts :apps)
                {:keys [body tokens]} (gen-doc rng opts)
                tokens (layout-tokens layout tokens)
                o (cps body)
                n (alength o)
                words (vec (sort-by :token/begin (filter #(= :w (:token/layer %)) tokens)))
                sents (filter #(= :s (:token/layer %)) tokens)
                sole? (fn [w] (let [sent (some #(when (and (<= (:token/begin %) (:token/begin w)) (<= (:token/end w) (:token/end %))) %) sents)]
                                (or (= 1 (count words))
                                    (and sent (= 1 (count (filter #(and (<= (:token/begin sent) (:token/begin %)) (<= (:token/end %) (:token/end sent))) words)))))))
              ;; k changes, each at its own word, apart from each other
                changes (->> (repeatedly (* 3 k) #(let [w (words (.nextInt rng (count words)))]
                                                    (one-word-change rng o w (sole? w) (:typed-words opts ["XZ" "Ж𐍂" "qoke"]) (:sep opts " "))))
                             (remove nil?)
                             (sort-by first)
                             (reduce (fn [out [a :as c]] (if (and (seq out) (<= a (inc (second (peek out))))) out (conj out c))) [])
                             (take k)
                             vec)]
            (when (seq changes)
              (let [gaps (mapv (fn [[a b v]] {:start a :end b :value v}) changes)
                    new (ta/edit-ops-body (ta/gap-ops gaps) body)
                    d (- (cp/cp-count new) n)
                    exact (run body tokens (ta/gap-ops gaps) layout false)
                    whole (save body new tokens layout false)
                    [a b] [(first (first changes)) (second (peek changes))]
                  ;; a stretch from the start of a word before the changes to
                  ;; the end of one after them, pasted over with its new text
                    over (fn [x y] (let [x (min x a) y (max y b)]
                                     [{:type :replace :index x :length (- y x) :value (cp/cp-subs new x (+ y d))}]))
                    lo (or (last (filter #(<= (:token/begin %) a) (take (- (count words) (.nextInt rng 3)) words))) (first words))
                    hi (or (first (filter #(>= (:token/end %) b) (drop (.nextInt rng 3) words))) (peek words))
                    sent (some #(when (and (<= (:token/begin %) a) (<= b (:token/end %))) %) sents)
                    readings (cond-> {:whole-body-replace [{:type :replace :index 0 :length n :value new}]
                                      :stretch (over (:token/begin lo) (:token/end hi))}
                               sent (assoc :line (over (:token/begin sent) (:token/end sent))))]
                (doseq [[rname ops] readings]
                  (let [r (run body tokens ops layout false)
                        made (o/exact body tokens ops layout)
                        ps (-> (paste-problems body tokens changes r [exact whole made])
                               (into (problems body tokens (server-gaps body tokens ops layout) r))
                               (into (lost-problems body tokens r exact :paste)))]
                    (when (seq ps)
                      (if (and (= (placed-words o tokens r) (placed-words o tokens whole))
                               (empty? (problems body tokens (server-gaps body tokens ops layout) r)))
                      ;; read as the whole-body save of it reads it, which
                      ;; deletes a word the edits keep: see `paste-ceiling`
                        (swap! as-saved conj [cname k seed rname])
                        (swap! fails conj {:config cname :changes changes :seed seed :reading rname :old body :problems (take 3 ps)})))))))))
        (when (or (System/getenv "PLAIN_ORACLE_DEBUG") (System/getProperty "plain.oracle.debug"))
          (println cname k (count @fails) (frequencies (map :reading @fails)))
          (doseq [f (take 4 @fails)] (println (pr-str f))))
        (testing (str cname " " k " changes")
          (is (empty? @fails) (pr-str (take 3 @fails))))))
    (is (<= (count (distinct (map #(subvec % 0 3) @as-saved))) paste-ceiling)
        (str (count (distinct (map #(subvec % 0 3) @as-saved))) " " (pr-str (take 10 (distinct (map #(subvec % 0 3) @as-saved))))))))

;; REV-W2-TEXT N2 (FX-W2d), `:spaceless` seed 256 of the test above at two
;; changes, past its default seeds, the case with only its words and
;; sentences: `你` typed over as `嗎` and `好` typed before `。`, pasted over
;; `你好你`. The stretch was read as if its end were the text's end, so the
;; letters typed after the last `你` counted as typed against a word's edge
;; at the text's end, and the diff's reading (insert `嗎好` at 0, delete the
;; last `你`) stayed: it deleted that `你`, which the exact edits keep, and
;; put `嗎好你` on the first word. `。` stands after the stretch, with no
;; space, and the aligner now reads the stretch's end as the inside of the
;; text, as a whole-body save does.
(deftest a-paste-in-a-script-without-spaces-reads-the-text-beyond-its-stretch
  (let [old "你好你。好很"
        w (fn [i b e] {:token/id [:w i] :token/layer :w :token/begin b :token/end e})
        tokens (into [{:token/id [:s 0] :token/layer :s :token/begin 0 :token/end 2}
                      {:token/id [:s 1] :token/layer :s :token/begin 2 :token/end 6}]
                     (map #(w % % (inc %)) (range 6)))
        exact (run old tokens (ta/gap-ops [{:start 0 :end 1 :value "嗎"} {:start 3 :end 3 :value "好"}]))
        pasted (run old tokens [{:type :replace :index 0 :length 3 :value "嗎好你好"}])
        extents (fn [r] (into (sorted-map) (map (juxt :token/id (juxt :token/begin :token/end))) (:tokens r)))]
    (is (= "嗎好你好。好很" (:text/body (:text pasted))))
    (is (empty? (:deleted exact)))
    (is (empty? (:deleted pasted)))
    (is (= (extents exact) (extents pasted)))
    (is (= [2 4] (get (extents pasted) [:w 2])))))

;; REV-PASTE F1: a selection typed over that ends inside a word, with a line
;; break typed. `the cat, mat th` of ` the cat, mat the` is typed over as `Oh.`
;; and a line break, and a node lies over the last word. The stretch reading
;; took the stretch's end for the text's end, so the line break typed before
;; the `e` beyond it cost nothing inside the word: it stood inside `the`'s
;; token and the node, the first sentence and its word were deleted, and
;; the sentences no longer split there. The word runs across the stretch's
;; end, and the aligner now reads the letter beyond it, as a whole-body save
;; of the same change does.
(deftest a-line-break-typed-before-the-rest-of-a-word-beyond-the-stretch-splits-there
  (let [old " the cat, mat the"
        t (fn [id layer b e] {:token/id id :token/layer layer :token/begin b :token/end e})
        tokens [(t [:s 0] :s 0 4) (t [:s 1] :s 4 17) (t [:w 1] :w 1 4) (t [:w 2] :w 5 9) (t [:w 3] :w 10 13)
                (t [:w 4] :w 14 17) (t [:u 1] :u 14 17)]
        r (run old tokens [{:type :replace :index 1 :length 15 :value "Oh.\n"}])
        texts (fn [r] (let [nb (:text/body (:text r)) gone (set (:deleted r))]
                        (into (sorted-map) (keep #(when-not (gone (:token/id %)) [(:token/id %) (cp/cp-subs nb (:token/begin %) (:token/end %))]))
                              (:tokens r))))]
    (is (= " Oh.\ne" (:text/body (:text r))))
    (is (= [[:w 2] [:w 3]] (sort (:deleted r))))
    (is (= {[:s 0] " Oh." [:s 1] "e" [:u 1] "e" [:w 1] "Oh." [:w 4] "e"} (texts r)))
    (is (= (texts (save old (:text/body (:text r)) tokens)) (texts r)))))

;; REV-PASTE F1, the second shape (seed 6000 and up of the edge oracle's
;; sentences-meet test): `cat, a\nth` typed over as `Oh.` and a line break, the
;; stretch ending inside `thung ki`. The stretch reading gave `Oh.` and the
;; line break to `thung ki` and deleted both `cat,` and `a`. It now keeps
;; `Oh.` in the second sentence, on a word of its own, and deletes `a` alone.
(deftest a-line-break-typed-before-the-rest-of-a-word-beyond-the-stretch-keeps-the-sentences
  (let [old " cat. kai\t(ab) sat cat, a\nthung ki\tə́múk   su\t(ab) talu lei  mat"
        tokens (mapv (fn [[id layer b e]] {:token/id id :token/layer layer :token/begin b :token/end e})
                     [[[:w 1] :w 1 4] [[:m 1 0] :m 1 4] [[:a 0 0] :a 1 4] [[:ap 0 4] :a 4 4] [[:s 0] :s 0 6] [[:rw 0] :rw 0 6]
                      [[:as 0] :ss 1 4] [[:w 2] :w 6 9] [[:m 2 0] :m 6 9] [[:w 3] :w 10 14] [[:m 3 0] :m 10 14] [[:m 3 1] :m 10 14]
                      [[:w 4] :w 15 18] [[:m 4 0] :m 15 18] [[:m 4 1] :m 15 18] [[:w 5] :w 19 23] [[:m 5 0] :m 19 23] [[:w 6] :w 24 25]
                      [[:m 6 0] :m 24 25] [[:un 1 0 3] :u 6 18] [[:un 1 1 3] :u 10 18] [[:un 1 2 4] :u 15 23] [[:u 1 3] :u 19 23] [[:u 1 4] :u 24 25]
                      [[:a 1 0] :a 6 14] [[:s 1] :s 6 26] [[:rw 1] :rw 6 26] [[:as 1] :ss 6 25] [[:w 7] :w 26 34] [[:m 7 0] :m 26 34]
                      [[:m 7 1] :m 26 34] [[:m 7 2] :m 26 34] [[:w 8] :w 35 45] [[:m 8 0] :m 35 45] [[:w 9] :w 46 50] [[:m 9 0] :m 46 50]
                      [[:w 10] :w 51 59] [[:m 10 0] :m 51 59] [[:m 10 1] :m 51 59] [[:m 10 2] :m 51 59] [[:w 11] :w 61 64] [[:m 11 0] :m 61 64]
                      [[:m 11 1] :m 61 64] [[:m 11 2] :m 61 64] [[:u 2 0] :u 26 34] [[:u 2 1] :u 35 45] [[:u 2 2] :u 46 50] [[:un 2 2 4] :u 46 59]
                      [[:u 2 4] :u 61 64] [[:a 2 2] :a 46 50] [[:a 2 3] :a 51 64] [[:ap 2 34] :a 34 34] [[:s 2] :s 26 64] [[:rw 2] :rw 26 64]
                      [[:as 2] :ss 26 64]])
        r (run old tokens [{:type :delete :index 5 :value 6} {:type :replace :index 13 :length 9 :value "Oh.\n"}
                           {:type :delete :index 23 :value 6}])
        nb (:text/body (:text r))
        gone (set (:deleted r))
        text (fn [id] (some #(when (and (= id (:token/id %)) (not (gone id))) (cp/cp-subs nb (:token/begin %) (:token/end %))) (:tokens r)))]
    (is (= [[:w 2] [:w 6]] (sort (filter #(#{:w :s} (first %)) (:deleted r)))))
    (is (= "ab) sat Oh.\n" (text [:s 1])))
    (is (= "Oh." (text [:w 5])))
    (is (= "ung ki" (text [:w 7])))))
