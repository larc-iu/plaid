(ns plaid.algos.text-test
  "Unit tests for plaid.algos.text.

  Task #71 regression: zero-width token (begin == end == p) handling must be
  symmetric between :insert and :delete:
    - :insert at p keeps a zero-width token at p pinned at p.
    - :delete with a range whose endpoint equals p (either side) does NOT
      delete a zero-width token at p — only a range that *strictly* contains
      p does."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [plaid.algos.text :as ta]
            [plaid.util.codepoint :as cp]))

(defn- tok [id begin end]
  {:token/id id :token/begin begin :token/end end})

(defn- ids [tokens] (mapv :token/id tokens))

(deftest zero-width-delete-strict-containment
  (testing "(1) zero-width at p; delete [p, q] (q > p) — token survives at p"
    (let [text {:text/body "abcdef"}
          tokens [(tok :zw 3 3)]
          {:keys [tokens deleted]}
          (ta/apply-text-edit (ta/delete-op 3 2) text tokens)]
      (is (= [] deleted))
      (is (= [{:token/id :zw :token/begin 3 :token/end 3}] tokens))))

  (testing "(2) zero-width at p; delete [q, p] (q < p) — token survives,
            shifted left by value"
    (let [text {:text/body "abcdef"}
          tokens [(tok :zw 3 3)]
          {:keys [tokens deleted]}
          (ta/apply-text-edit (ta/delete-op 1 2) text tokens)]
      (is (= [] deleted))
      (is (= [{:token/id :zw :token/begin 1 :token/end 1}] tokens))))

  (testing "(3) zero-width at p; delete [q, r] (q < p < r) — token deleted
            (range strictly contains p)"
    (let [text {:text/body "abcdef"}
          tokens [(tok :zw 3 3)]
          {:keys [tokens deleted]}
          (ta/apply-text-edit (ta/delete-op 2 2) text tokens)]
      (is (= [:zw] deleted))
      (is (= [] tokens))))

  (testing "zero-width far before deletion range is unaffected"
    (let [text {:text/body "abcdef"}
          tokens [(tok :zw 1 1)]
          {:keys [tokens deleted]}
          (ta/apply-text-edit (ta/delete-op 3 2) text tokens)]
      (is (= [] deleted))
      (is (= [{:token/id :zw :token/begin 1 :token/end 1}] tokens))))

  (testing "non-zero-width token fully inside delete range is still deleted"
    (let [text {:text/body "abcdef"}
          tokens [(tok :t 2 4)]
          {:keys [tokens deleted]}
          (ta/apply-text-edit (ta/delete-op 1 4) text tokens)]
      (is (= [:t] deleted))
      (is (= [] tokens)))))

(deftest zero-width-insert-pinning
  (testing "(4) zero-width at p; insert at p — token survives at p (pinned)"
    (let [text {:text/body "abcdef"}
          tokens [(tok :zw 3 3)]
          {:keys [tokens deleted]}
          (ta/apply-text-edit (ta/insert-op 3 "XX") text tokens)]
      (is (= [] deleted))
      (is (= [{:token/id :zw :token/begin 3 :token/end 3}] tokens))))

  (testing "(5) zero-width at p; insert at q < p — token shifts right by
            insert length"
    (let [text {:text/body "abcdef"}
          tokens [(tok :zw 3 3)]
          {:keys [tokens deleted]}
          (ta/apply-text-edit (ta/insert-op 1 "XX") text tokens)]
      (is (= [] deleted))
      (is (= [{:token/id :zw :token/begin 5 :token/end 5}] tokens))))

  (testing "zero-width at p; insert at q > p — token unaffected"
    (let [text {:text/body "abcdef"}
          tokens [(tok :zw 3 3)]
          {:keys [tokens deleted]}
          (ta/apply-text-edit (ta/insert-op 5 "XX") text tokens)]
      (is (= [] deleted))
      (is (= [{:token/id :zw :token/begin 3 :token/end 3}] tokens)))))

(deftest mixed-zero-width-and-normal-delete
  (testing "Delete range with multiple zero-width tokens at the boundaries"
    (let [text {:text/body "abcdefgh"}
          ;; zw1 at left boundary, zw2 strictly inside, zw3 at right
          ;; boundary, normal token strictly inside the range.
          tokens [(tok :zw1 2 2)
                  (tok :zw2 4 4)
                  (tok :zw3 6 6)
                  (tok :norm 3 5)]
          {:keys [tokens deleted]}
          (ta/apply-text-edit (ta/delete-op 2 4) text tokens)]
      ;; zw2 strictly contained -> deleted; norm fully inside -> deleted.
      (is (= #{:zw2 :norm} (set deleted)))
      ;; zw1 stays at p=2; zw3 stays at p but shifts left by value=4
      (let [by-id (into {} (map (juxt :token/id identity) tokens))]
        (is (= {:token/id :zw1 :token/begin 2 :token/end 2}
               (by-id :zw1)))
        (is (= {:token/id :zw3 :token/begin 2 :token/end 2}
               (by-id :zw3)))
        (is (= 2 (count tokens)))))))

;; ---------------------------------------------------------------------------
;; Task #102.3 — apply-text-edits compound edits around zero-width
;; ---------------------------------------------------------------------------
;; Insert at p, delete [q, r] where q < p < r in a SINGLE batch. The
;; single-edit semantics (see zero-width-delete-strict-containment case 3)
;; say a delete whose range STRICTLY contains p removes a zero-width
;; token at p — but interleaving an :insert at p in the SAME batch
;; before the :delete should pin the token at p, so the eventual delete
;; sees a (now-extended) text and the zero-width is at the boundary,
;; not strictly interior. The test pins down the actual behavior so a
;; future refactor doesn't silently flip semantics.

(deftest compound-insert-then-delete-around-zero-width
  (testing "insert-at-p first; delete-strict-around-p second; single batch.
            After the insert the zero-width is pinned at p; after the delete
            (which strictly contains p), the zero-width is removed because
            the delete is processed against the post-insert state."
    (let [text {:text/body "abcdef"}
          tokens [(tok :zw 3 3)]
          ;; insert "XX" at p=3 first (zw pinned at 3),
          ;; then delete [2, 5) — but post-insert the body is "abcXXdef"
          ;; (len 8). The delete-op (start=2, value=3) removes "cXX" =
          ;; positions [2,5). Strictly contains p=3. zw should be removed.
          ops [(ta/insert-op 3 "XX")
               (ta/delete-op 2 3)]
          {:keys [tokens deleted]} (ta/apply-text-edits ops text tokens)]
      (is (= [:zw] deleted)
          (str "Expected :zw to be deleted by the second op (strict interior); "
               "got deleted=" deleted " tokens=" tokens))
      (is (= [] tokens)))))

(deftest compound-delete-around-zero-width-preserves-boundary
  (testing "delete-then-insert variant: delete whose RIGHT boundary equals
            p — token survives (delete-op uses (>= q p p < r), not >). After
            the delete the zero-width moves to the new boundary position;
            a follow-up insert at that boundary keeps it pinned."
    (let [text {:text/body "abcdef"}
          tokens [(tok :zw 3 3)]
          ;; Delete [1, 3) — right boundary equals p=3; zw survives at p=1
          ;; (shifted by 2). Then insert "YY" at p=1 — zw pinned at 1.
          ops [(ta/delete-op 1 2)
               (ta/insert-op 1 "YY")]
          {:keys [tokens deleted]} (ta/apply-text-edits ops text tokens)]
      (is (= [] deleted)
          (str "Boundary-touching delete must NOT remove zw; got " deleted))
      (is (= [{:token/id :zw :token/begin 1 :token/end 1}] tokens)))))

;; Offsets and edit-op indices are Unicode CODE POINTS; `diff` is code-point
;; granular (it diffs over a surrogate-free proxy), so an astral edit never cuts
;; a surrogate pair. Regression guard: diffing+applying an edit between two ASTRAL
;; strings must reconstruct the new body EXACTLY. Earlier broken versions either
;; corrupted the body (UTF-16 indices sliced at code-point boundaries) or
;; mis-shifted tokens (editscript cutting a shared surrogate pair).
(deftest astral-diff-reconstructs-body-exactly
  (doseq [[old new] [["hello😀world" "hello😁world"] ; shared high surrogate
                     ["😀X" "😁X"]
                     ["😀😁😂" "😀😂"]               ; delete a middle astral char
                     ["😀😀" "😀😁"]
                     ["😀" "🎯"]                     ; different high surrogate
                     ["𐌰𐌱𐌲" "𐌰𐌲"]                  ; Gothic (SMP) interior delete
                     ["a😀b" "a😀😁b"]]]
    (let [{:keys [text]} (ta/apply-text-edits (ta/diff old new) {:text/body old} [])]
      (is (= new (:text/body text))
          (str "body must reconstruct exactly for " (pr-str old) " -> " (pr-str new))))))

(deftest astral-interior-delete-shifts-tokens-correctly
  ;; "😀😁😂" -> "😀😂": deleting the MIDDLE astral char (the three emoji share
  ;; the high surrogate D83D). Correct result: 😁's token is deleted, 😂's token
  ;; shifts left by ONE code point. A char-level diff cut the pair and instead
  ;; left 😁's token pointing at 😂 while 😂's collapsed to zero-width.
  (let [tokens [(tok :a 0 1) (tok :b 1 2) (tok :c 2 3)]
        {result-text :text result-tokens :tokens deleted :deleted}
        (ta/apply-text-edits (ta/diff "😀😁😂" "😀😂") {:text/body "😀😁😂"} tokens)]
    (is (= "😀😂" (:text/body result-text)))
    (is (= [:b] deleted))
    (is (= [[:a 0 1] [:c 1 2]]
           (mapv (juxt :token/id :token/begin :token/end) result-tokens)))))

;; ---------------------------------------------------------------------------
;; normalize-deletes: a kept run that repeats the edge of a neighbouring delete
;; is folded into ONE contiguous delete when that cuts fewer tokens.

(defn- apply-all [ops body tokens]
  (ta/apply-text-edits ops {:text/body body} tokens))

(deftest normalize-deletes-merges-across-a-repeated-edge
  (let [old "Todos los derechos. ¿Qué? ? dog's"
        new "Todos los derechos. ? dog's"
        ;; word tokens: Todos los derechos. ¿Qué? ? dog's
        tokens [(tok :todos 0 5) (tok :los 6 9) (tok :derechos 10 19)
                (tok :que 20 25) (tok :q 26 27) (tok :dogs 28 33)]
        raw (ta/diff old new)
        norm (ta/normalize-deletes raw old tokens)]
    (testing "both op lists rebuild the same body"
      (is (= new (get-in (apply-all raw old tokens) [:text :text/body])))
      (is (= new (get-in (apply-all norm old tokens) [:text :text/body]))))
    (testing "the normalized form deletes the whole ¿Qué? token and keeps the real ?"
      (let [{:keys [tokens deleted]} (apply-all norm old tokens)]
        (is (= [:que] deleted))
        (is (= [{:token/id :q :token/begin 20 :token/end 21}]
               (filter #(= :q (:token/id %)) tokens)))
        (is (not-any? #(= :que (:token/id %)) tokens))))))

(deftest normalize-deletes-leaves-unambiguous-edits-alone
  (let [old "aa bb cc"
        tokens [(tok :a 0 2) (tok :b 3 5) (tok :c 6 8)]]
    (testing "a plain middle deletion is untouched"
      (let [ops (ta/diff old "aa cc")]
        (is (= ops (ta/normalize-deletes ops old tokens)))))
    (testing "an append is untouched"
      (let [ops (ta/diff old "aa bb cc dd")]
        (is (= ops (ta/normalize-deletes ops old tokens)))))
    (testing "explicit ops with no delete pairs pass through"
      (let [ops [(ta/insert-op 2 "X") (ta/delete-op 4 1)]]
        (is (= ops (ta/normalize-deletes ops old tokens)))))))

(deftest normalize-deletes-never-worsens-token-cuts
  (let [old "xa xa xa"
        new "xa xa"
        tokens [(tok :t1 0 2) (tok :t2 3 5) (tok :t3 6 8)]
        raw (ta/diff old new)
        norm (ta/normalize-deletes raw old tokens)
        cut (fn [ops] (let [{:keys [tokens]} (apply-all ops old tokens)]
                        (count (filter #(< 0 (- (:token/end %) (:token/begin %)) 2) tokens))))]
    (is (= new (get-in (apply-all norm old tokens) [:text :text/body])))
    (is (<= (cut norm) (cut raw)))))

;; ---------------------------------------------------------------------------
;; :replace — a delete+insert that keeps a token covering the whole range.

(deftest replace-keeps-a-token-covering-the-whole-range
  (testing "respelling an entire word keeps its token (resized)"
    (let [text {:text/body "the kat sat"}
          tokens [(tok :a 0 3) (tok :b 4 7) (tok :c 8 11)]
          {:keys [text tokens deleted]}
          (ta/apply-text-edit (ta/replace-op 4 3 "cat") text tokens)]
      (is (= "the cat sat" (:text/body text)))
      (is (= [] deleted))
      (is (= #{[:a 0 3] [:b 4 7] [:c 8 11]}
             (set (map (juxt :token/id :token/begin :token/end) tokens))))))

  (testing "a longer replacement grows the token and shifts what follows"
    (let [text {:text/body "the kat sat"}
          tokens [(tok :a 0 3) (tok :b 4 7) (tok :c 8 11)]
          {:keys [text tokens deleted]}
          (ta/apply-text-edit (ta/replace-op 4 3 "kitten") text tokens)]
      (is (= "the kitten sat" (:text/body text)))
      (is (= [] deleted))
      (is (= #{[:a 0 3] [:b 4 10] [:c 11 14]}
             (set (map (juxt :token/id :token/begin :token/end) tokens))))))

  (testing "a one-character word can be respelled — no interior position needed"
    (let [text {:text/body "ʔa"}
          tokens [(tok :g 0 1) (tok :a 1 2)]
          {:keys [text tokens deleted]}
          (ta/apply-text-edit (ta/replace-op 0 1 "'") text tokens)]
      (is (= "'a" (:text/body text)))
      (is (= [] deleted))
      (is (= #{[:g 0 1] [:a 1 2]}
             (set (map (juxt :token/id :token/begin :token/end) tokens))))))

  (testing "an interior replacement inside a token resizes it"
    (let [text {:text/body "abcdef"}
          tokens [(tok :t 0 6)]
          {:keys [text tokens]}
          (ta/apply-text-edit (ta/replace-op 2 2 "X") text tokens)]
      (is (= "abXef" (:text/body text)))
      (is (= [{:token/id :t :token/begin 0 :token/end 5}] tokens))))

  (testing "the equivalent delete+insert would have deleted the token"
    (let [text {:text/body "the kat sat"}
          tokens [(tok :b 4 7)]
          {:keys [deleted]}
          (ta/apply-text-edits [(ta/delete-op 4 3) (ta/insert-op 4 "cat")] text tokens)]
      (is (= [:b] deleted)))))

(deftest replace-partial-overlap-behaves-like-delete-plus-insert
  (testing "tokens straddling the range are clipped; the replacement belongs to no token"
    (let [text {:text/body "ab cd"}
          tokens [(tok :x 0 2) (tok :y 3 5)]
          {:keys [text tokens deleted]}
          (ta/apply-text-edit (ta/replace-op 1 3 "--") text tokens)]
      (is (= "a--d" (:text/body text)))
      (is (= [] deleted))
      (is (= #{[:x 0 1] [:y 3 4]}
             (set (map (juxt :token/id :token/begin :token/end) tokens))))))

  (testing "a token strictly inside the range is deleted"
    (let [text {:text/body "a bc d"}
          tokens [(tok :x 0 1) (tok :y 2 4) (tok :z 5 6)]
          {:keys [text tokens deleted]}
          (ta/apply-text-edit (ta/replace-op 1 4 "_") text tokens)]
      (is (= "a_d" (:text/body text)))
      (is (= [:y] deleted))
      (is (= #{[:x 0 1] [:z 2 3]}
             (set (map (juxt :token/id :token/begin :token/end) tokens))))))

  (testing "a zero-width token stays at the end it was at"
    ;; The boundary tokens hold their sides of the replacement: the one at the
    ;; range's start stays there, the one at its end follows the end, as a
    ;; covering token's end does. A delete and an insert would bring both to
    ;; the start, which puts the end one strictly inside whatever word the
    ;; range belongs to.
    (let [text {:text/body "abcd"}
          tokens [(tok :at-start 1 1) (tok :inside 2 2) (tok :at-end 3 3)]
          {:keys [tokens deleted]}
          (ta/apply-text-edit (ta/replace-op 1 2 "XYZ") text tokens)]
      (is (= [:inside] deleted))
      (is (= #{[:at-start 1 1] [:at-end 4 4]}
             (set (map (juxt :token/id :token/begin :token/end) tokens)))))))

(deftest replace-degenerate-forms
  (testing "empty value is a delete (a covering token collapses, as delete does)"
    (let [text {:text/body "the kat sat"}
          tokens [(tok :b 4 7)]
          {:keys [text deleted]}
          (ta/apply-text-edit (ta/replace-op 4 3 "") text tokens)]
      (is (= "the  sat" (:text/body text)))
      (is (= [:b] deleted))))

  (testing "zero length is an insert"
    (let [text {:text/body "the kat sat"}
          tokens [(tok :b 4 7)]
          {:keys [text tokens]}
          (ta/apply-text-edit (ta/replace-op 5 0 "i") text tokens)]
      (is (= "the kiat sat" (:text/body text)))
      (is (= [{:token/id :b :token/begin 4 :token/end 8}] tokens))))

  (testing "astral text: indices and lengths are code points"
    (let [text {:text/body "a😀b"}
          tokens [(tok :t 0 3)]
          {:keys [text tokens]}
          (ta/apply-text-edit (ta/replace-op 1 1 "😺😺") text tokens)]
      (is (= "a😺😺b" (:text/body text)))
      (is (= [{:token/id :t :token/begin 0 :token/end 4}] tokens))))

  (testing "string type keys and validation"
    (let [text {:text/body "abc"}]
      (is (= "aXc" (-> (ta/apply-text-edit {:type "replace" :index 1 :length 1 :value "X"} text [])
                       :text :text/body)))
      (is (thrown? clojure.lang.ExceptionInfo
                   (ta/apply-text-edit {:type :replace :index 1 :length 5 :value "X"} text [])))
      (is (thrown? clojure.lang.ExceptionInfo
                   (ta/apply-text-edit {:type :replace :index 1 :value "X"} text []))))))

;; ---------------------------------------------------------------------------
;; pair-replacements: in a whole-body update, a diffed delete with an insert
;; beside it becomes one replace op, so a token covering the changed letters
;; keeps the new ones.

(defn- extents [tokens] (set (map (juxt :token/id :token/begin :token/end) tokens)))

(defn- body-edit
  "Apply a whole-body edit the way update-body does: diff, slide, snap the
  deletes, pair them with their inserts, fold a word replaced outright.
  `partitioning` is the set of layers that are partitions."
  ([old new tokens] (body-edit old new tokens #{}))
  ([old new tokens partitioning]
   (-> (ta/diff old new)
       (ta/slide-to-tokens old tokens partitioning)
       (ta/normalize-deletes old tokens)
       (ta/pair-replacements old tokens)
       (ta/fold-whole-words old tokens)
       (apply-all old tokens))))

(deftest pair-replacements-turns-a-respelled-letter-into-a-replace
  (testing "the diff spells the respelling as delete then insert at one index"
    (is (= [(ta/delete-op 4 1) (ta/insert-op 4 "ь")]
           (ta/diff "юкъуз хьана" "юкъуь хьана"))))
  (testing "the pair becomes one replace op"
    (is (= [(ta/replace-op 4 1 "ь")]
           (ta/pair-replacements (ta/diff "юкъуз хьана" "юкъуь хьана") "юкъуз хьана")))
    (is (= [(ta/replace-op 0 1 "c")]
           (ta/pair-replacements (ta/diff "kat sat" "cat sat") "kat sat")))))

(deftest pairing-keeps-a-zero-width-token-between-two-deletes
  ;; Two lines joined, a quote dropped: the diff deletes the newline and the
  ;; quote one by one and inserts a space. An unaligned UMR node's zero-width
  ;; token sat between the two deletes, at the edge of each, and was kept;
  ;; folded into one replace it was strictly inside, and went.
  (let [old "Ali went home.\n\"The dog barked.\"\n"
        new "Ali went home. The dog barked.\n"
        tokens [(tok :node 15 15)]
        result (body-edit old new tokens)]
    (is (= new (:text/body (:text result))))
    (is (= #{[:node 14 14]} (extents (:tokens result))))
    (is (empty? (:deleted result)))))

(deftest respelling-a-last-letter-keeps-it-in-the-tokens-over-the-word
  (let [old "юкъуз хьана"
        new "юкъуь хьана"
        tokens [(tok :word 0 5) (tok :next 6 11) (tok :sentence 0 11)]]
    (testing "the word token covers the new letter, the sentence token still covers all"
      (let [{:keys [text tokens deleted]} (body-edit old new tokens)]
        (is (= new (:text/body text)))
        (is (= [] deleted))
        (is (= #{[:word 0 5] [:next 6 11] [:sentence 0 11]} (extents tokens)))
        (is (= "юкъуь" (subs (:text/body text) 0 5)))))
    (testing "applied as a bare delete and insert, the word loses the letter"
      (is (contains? (extents (:tokens (apply-all (ta/diff old new) old tokens)))
                     [:word 0 4])))))

(deftest respelling-a-first-letter-keeps-it-in-the-word
  (let [{:keys [text tokens]} (body-edit "kat sat" "cat sat" [(tok :kat 0 3) (tok :sat 4 7)])]
    (is (= "cat sat" (:text/body text)))
    (is (= #{[:kat 0 3] [:sat 4 7]} (extents tokens)))))

(deftest respelling-next-to-a-zero-width-token-keeps-it-at-the-word-end
  ;; A zero-width token at the end of a replaced stretch stands at the end of
  ;; what replaces it, as a covering token's end does. Pulled back to the
  ;; stretch's start it would sit strictly inside the word, which a
  ;; non-overlapping layer refuses and a restore of that moment cannot
  ;; rebuild.
  (let [old "юкъуз хьана"
        new "юкъуь хьана"
        tokens [(tok :word 0 5) (tok :zw 5 5)]
        {:keys [tokens deleted]} (body-edit old new tokens)]
    (is (= [] deleted))
    (is (= #{[:word 0 5] [:zw 5 5]} (extents tokens)))
    (testing "and it follows the length the replacement changes"
      (is (= #{[:zw 6 6]}
             (extents (:tokens (ta/apply-text-edit (ta/replace-op 4 1 "ьь")
                                                   {:text/body old} [(tok :zw 5 5)])))))
      (is (= #{[:zw 4 4]}
             (extents (:tokens (ta/apply-text-edit (ta/replace-op 2 2 "х")
                                                   {:text/body old} [(tok :zw 5 5)]))))))))

(deftest respelling-a-letter-each-side-of-a-kept-one-keeps-the-word-whole
  ;; `dancde` -> `danced` is delete, keep, insert: the ops do not touch, and
  ;; folding only what touches left the word token over `dance` with the new
  ;; letter outside it.
  (let [old "she dancde now"
        new "she danced now"
        tokens [(tok :she 0 3) (tok :word 4 10) (tok :now 11 14)]]
    (is (= [(ta/delete-op 8 1) (ta/insert-op 9 "d")] (ta/diff old new)))
    (is (= [(ta/replace-op 8 2 "ed")] (ta/pair-replacements (ta/diff old new) old tokens)))
    (let [{:keys [text tokens deleted]} (body-edit old new tokens)]
      (is (= new (:text/body text)))
      (is (= [] deleted))
      (is (= #{[:she 0 3] [:word 4 10] [:now 11 14]} (extents tokens)))))
  (testing "with no token holding the stretch, the ops stay as they are"
    (is (= [(ta/delete-op 8 1) (ta/insert-op 9 "d")]
           (ta/pair-replacements (ta/diff "she dancde now" "she danced now")
                                 "she dancde now"))))
  (testing "a token inside the stretch is not swallowed by a fold"
    (let [old "she dancde now"
          tokens [(tok :word 4 10) (tok :m1 4 8) (tok :m2 8 10)]]
      ;; the morphemes hold the changed stretch exactly, so nothing is lost
      (is (= [(ta/replace-op 8 2 "ed")]
             (ta/pair-replacements (ta/diff old "she danced now") old tokens)))
      (is (= [(ta/delete-op 8 1) (ta/insert-op 9 "d")]
             (ta/pair-replacements (ta/diff old "she danced now") old
                                   (conj tokens (tok :m3 9 10))))))))

(deftest a-text-typed-over-from-scratch-keeps-none-of-its-tokens
  ;; Folding the whole body into one replace would hand the new text every
  ;; token of the old one, and the spans, relations and links on them.
  (let [old "aaa"
        tokens [(tok :word 0 3) (tok :sentence 0 3)]
        {:keys [text tokens deleted]} (body-edit old "zzz" tokens)]
    (is (= "zzz" (:text/body text)))
    (is (= #{:word :sentence} (set deleted)))
    (is (= #{} (extents tokens))))
  (testing "a word typed over inside a longer text still keeps its token"
    (let [{:keys [tokens deleted]} (body-edit "aaa bbb" "zzz bbb"
                                              [(tok :word 0 3) (tok :next 4 7)])]
      (is (= [] deleted))
      (is (= #{[:word 0 3] [:next 4 7]} (extents tokens))))))

(deftest pair-replacements-folds-a-split-run
  (testing "insert then delete at the same place in the old text"
    (is (= [(ta/replace-op 1 1 "X")]
           (ta/pair-replacements [(ta/insert-op 1 "X") (ta/delete-op 2 1)] "abcdef"))))
  (testing "two deletes at one index then an insert are one replace"
    (is (= [(ta/replace-op 2 6 "X")]
           (ta/pair-replacements [(ta/delete-op 2 5) (ta/delete-op 2 1) (ta/insert-op 2 "X")]
                                 "AABBCCDDEE x"))))
  (testing "a token wholly inside the replaced stretch is still deleted"
    (let [old "AABBCCDDEE x"
          tokens [(tok :aa 0 2) (tok :bb 2 4) (tok :cc 4 6) (tok :dd 6 8) (tok :ee 8 10)]
          {:keys [text tokens deleted]} (body-edit old "AAXEE x" tokens)]
      (is (= "AAXEE x" (:text/body text)))
      (is (= #{:bb :cc :dd} (set deleted)))
      (is (= #{[:aa 0 2] [:ee 3 5]} (extents tokens)))))
  (testing "separate edits stay separate"
    (is (= [(ta/replace-op 1 1 "a") (ta/replace-op 7 1 "a")]
           (ta/pair-replacements (ta/diff "hello world" "hallo warld") "hello world")))))

(deftest pair-replacements-leaves-lone-deletes-and-inserts-alone
  (testing "a delete with no insert at its position is unchanged"
    (let [ops (ta/diff "юкъуз хьана" "юкъу хьана")]
      (is (= [(ta/delete-op 4 1)] ops))
      (is (= ops (ta/pair-replacements ops "юкъуз хьана")))
      (is (= #{[:word 0 4]}
             (extents (:tokens (body-edit "юкъуз хьана" "юкъу хьана" [(tok :word 0 5)])))))))
  (testing "a delete and an insert with kept text between them are unchanged"
    (let [ops [(ta/delete-op 1 1) (ta/insert-op 3 "x")]]
      (is (= ops (ta/pair-replacements ops "abcdef")))
      (testing "and unchanged when no token holds both with room to spare"
        (is (= ops (ta/pair-replacements ops "abcdef" [(tok :w 1 3)]))))))
  (testing "appending to a word stays an insert at the token's end"
    (let [ops (ta/diff "юкъу хьана" "юкъуз хьана")]
      (is (= [(ta/insert-op 4 "з")] ops))
      (is (= ops (ta/pair-replacements ops "юкъу хьана"))))))

(deftest pair-replacements-reconstructs-the-body
  (doseq [[old new] [["юкъуз хьана" "юкъуь хьана"]
                     ["ea" "ebbbccd"]
                     ["  acdadabeb " "bc"]
                     ["ecdcecbb " " babcaee"]
                     ["hello😀world" "hello😁world"]
                     ["😀" "🎯"]
                     ["abc" ""]
                     ["" "abc"]]]
    (let [tokens [(tok :t 0 (cp/cp-count old))]]
      (is (= new (get-in (body-edit old new tokens) [:text :text/body]))
          (str (pr-str old) " -> " (pr-str new))))))

;; ---------------------------------------------------------------------------
;; A whole-body update changes only the words it changes. Editscript picks any
;; one of the cheapest edit scripts, and some of them scatter one edit into the
;; text the two bodies share, which moved the tokens of untouched words onto
;; their neighbours (PROP finding 1, 2026-09-26).

(def ^:private fuzz-words
  ["the" "cat" "sat" "on" "a" "mat" "at" "as" "tat" "ta" "kai" "kaki" "𐌰𐌱" "𐌰" "é"])

(defn- word-tokens
  "One token per word of `words` joined by single spaces, in code points."
  [words]
  (loop [ws words p 0 i 0 out []]
    (if-let [w (first ws)]
      (let [n (cp/cp-count w)]
        (recur (rest ws) (+ p n 1) (inc i) (conj out (tok i p (+ p n)))))
      out)))

(deftest deleting-or-inserting-a-word-leaves-the-others-in-place
  ;; Tokens are named by their old begin, so each triple reads old begin,
  ;; new begin, new end.
  (doseq [[old new expected deleted-n]
          [["kai tat mat at a" "kai tat at a" #{[0 0 3] [4 4 7] [12 8 10] [15 11 12]} 1]
           ["mat a at on cat kaki" "mat kai a at on cat kaki"
            #{[0 0 3] [4 8 9] [6 10 12] [9 13 15] [12 16 19] [16 20 24]} 0]
           ["at tat sat tat kaki" "cat at tat sat tat kaki"
            #{[0 4 6] [3 7 10] [7 11 14] [11 15 18] [15 19 23]} 0]]]
    (let [tokens (map #(assoc % :token/id (:token/begin %))
                      (word-tokens (str/split old #" ")))
          {:keys [text tokens deleted]} (body-edit old new tokens)]
      (is (= new (:text/body text)))
      (is (= expected (extents tokens)) (str (pr-str old) " -> " (pr-str new)))
      (is (= deleted-n (count deleted))))))

(defn- window-errors
  "Tokens wholly outside every window equivalent to `old` -> `new` (the
  shared start and end, taken as far as either goes) must keep their id, and
  shift by the length change when they come after it."
  [old new before after]
  (let [o (vec (.toArray (.codePoints ^String old)))
        n (vec (.toArray (.codePoints ^String new)))
        n0 (count o) n1 (count n)
        l (count (take-while true? (map = o n)))
        r (count (take-while true? (map = (rseq o) (rseq n))))
        lo (min l (- n0 r) (- n1 r))
        hi (- n0 (min r (- n0 l) (- n1 l)))
        delta (- n1 n0)
        now (into {} (map (juxt :token/id (juxt :token/begin :token/end))) after)]
    (keep (fn [{:token/keys [id begin end]}]
            (let [want (cond (< end lo) [begin end]
                             (> begin hi) [(+ begin delta) (+ end delta)])]
              (when (and want (not= want (now id)))
                [id [begin end] :want want :got (now id)])))
          before)))

(deftest a-one-word-edit-moves-no-other-word
  ;; Seeded, so a failure names the seed that reproduces it.
  (doseq [seed (range 1 7)]
    (let [rng (java.util.Random. seed)
          pick #(nth % (.nextInt rng (count %)))]
      (dotimes [case-n 150]
        (let [words (vec (repeatedly (+ 3 (.nextInt rng 5)) #(pick fuzz-words)))
              k (.nextInt rng (count words))
              words' (case (pick [:replace :delete :insert])
                       :replace (assoc words k (pick (remove #{(words k)} fuzz-words)))
                       :delete (into (subvec words 0 k) (subvec words (inc k)))
                       :insert (into (conj (subvec words 0 k) (pick fuzz-words)) (subvec words k)))
              old (str/join " " words)
              new (str/join " " words')
              before (word-tokens words)
              {:keys [text tokens]} (body-edit old new before)]
          (is (= new (:text/body text)))
          (is (empty? (window-errors old new before tokens))
              (str "seed " seed " case " case-n ": " (pr-str old) " -> " (pr-str new))))))))

;; The window check above spares every token inside the stretch the two bodies
;; could share, and that stretch is exactly where a greedy trim puts a word
;; edit wrong: deleting `cat` from `the cat cow` shares `the c` at the start,
;; so a delete placed after it leaves `cat`'s tokens on `c` and `cow`'s on
;; `ow`. These say where each word's token must end up.

(deftest a-word-edit-beside-a-word-that-repeats-its-letters
  ;; old, new, and the new extent of each old word token by its index (nil
  ;; for a deleted one).
  (doseq [[old new expected]
          [["the cat cow" "the cow" [[0 3] nil [4 7]]]
           ["mat a at" "mat at" [[0 3] nil [4 6]]]
           ["x ab abc" "x abc" [[0 1] nil [2 5]]]
           ["a big bad dog" "a bad dog" [[0 1] nil [2 5] [6 9]]]
           ["the cow" "the cat cow" [[0 3] [8 11]]]
           ["cat dog" "cat cat dog" [[0 3] [8 11]]]
           ["a b" "a ab b" [[0 1] [5 6]]]]]
    (let [before (word-tokens (str/split old #" "))
          {:keys [text tokens]} (body-edit old new before)
          got (into {} (map (juxt :token/id (juxt :token/begin :token/end))) tokens)]
      (is (= new (:text/body text)))
      (is (= expected (mapv got (range (count before))))
          (str (pr-str old) " -> " (pr-str new))))))

(defn- word-edit-errors
  "After a whole-body edit that deletes or inserts one word, every surviving
  word token must sit exactly on one word of the new body, no two on the same
  word, and each still read as the word it was made for. A delete leaves one
  token fewer, an insert leaves every token."
  [kind old-words new-words new-body before after]
  (let [extents (set (map (juxt :token/begin :token/end) (word-tokens new-words)))
        surface (fn [{:token/keys [begin end]}] (cp/cp-subs new-body begin end))
        old-surface (into {} (map (fn [t] [(:token/id t) (nth old-words (:token/id t))])) before)
        spots (map (juxt :token/begin :token/end) after)]
    (cond-> []
      (not= (count spots) (count (distinct spots)))
      (conj [:two-tokens-on-one-word spots])

      (not-every? extents spots)
      (conj [:token-off-a-word (remove extents spots)])

      (not-every? #(= (old-surface (:token/id %)) (surface %)) after)
      (conj [:token-reads-another-word
             (keep #(when (not= (old-surface (:token/id %)) (surface %))
                      [(old-surface (:token/id %)) (surface %)])
                   after)])

      (not= (count after) (case kind :delete (dec (count old-words)) :insert (count old-words)))
      (conj [:token-count (count after)]))))

(deftest a-word-deleted-or-inserted-leaves-every-other-word-token-on-its-word
  (let [vocab ["the" "cat" "cow" "a" "at" "ab" "abc" "tat" "ta" "big" "bad" "𐌰𐌱" "𐌰" "é"]]
    (doseq [seed (range 1 7)]
      (let [rng (java.util.Random. seed)
            pick #(nth % (.nextInt rng (count %)))]
        (dotimes [case-n 150]
          (let [words (vec (repeatedly (+ 3 (.nextInt rng 5)) #(pick vocab)))
                kind (pick [:delete :insert])
                k (.nextInt rng (count words))
                words' (case kind
                         :delete (into (subvec words 0 k) (subvec words (inc k)))
                         :insert (into (conj (subvec words 0 k) (pick vocab)) (subvec words k)))
                old (str/join " " words)
                new (str/join " " words')
                before (word-tokens words)
                {:keys [text tokens]} (body-edit old new before)]
            (is (= new (:text/body text)))
            (is (empty? (word-edit-errors kind words words' new before tokens))
                (str "seed " seed " case " case-n ": " (pr-str old) " -> " (pr-str new)))))))))

;; ---------------------------------------------------------------------------
;; A word replaced outright keeps its tokens, on the new word (ruled
;; 2026-09-21). The diff spells `cow` to `abc` as insert `ab`, keep `c`,
;; delete `ow`, which left the token of `cow` on the `c` of `abc`.

(deftest a-word-replaced-outright-moves-its-token-onto-the-new-word
  (doseq [[old new tokens expected]
          [["cat cow" "cat abc" [(tok :cat 0 3) (tok :cow 4 7)] #{[:cat 0 3] [:cow 4 7]}]
           ["ta aa bad" "bad aa bad" [(tok :ta 0 2) (tok :aa 3 5) (tok :bad 6 9)]
            #{[:ta 0 3] [:aa 4 6] [:bad 7 10]}]
           ["ab é" "bad é" [(tok :ab 0 2) (tok :e 3 4)] #{[:ab 0 3] [:e 4 5]}]
           ["cat 𐌰" "ta. 𐌰" [(tok :cat 0 3) (tok :goth 4 5)] #{[:cat 0 3] [:goth 4 5]}]
           ["x cow y" "x owl y" [(tok :cow 2 5)] #{[:cow 2 5]}]
           ;; a morpheme over the whole word, and a sentence ending with it,
           ;; move with it, and a zero-width token at either edge stays there
           ["cat cow" "cat abc"
            [(tok :cow 4 7) (tok :morph 4 7) (tok :sent 0 7) (tok :z1 4 4) (tok :z2 7 7)]
            #{[:cow 4 7] [:morph 4 7] [:sent 0 7] [:z1 4 4] [:z2 7 7]}]]]
    (let [{:keys [text tokens deleted]} (body-edit old new tokens)]
      (is (= new (:text/body text)))
      (is (= [] deleted))
      (is (= expected (extents tokens)) (str (pr-str old) " -> " (pr-str new)))))
  (testing "two words respelled keep a token each, and a token over both stays over both"
    (let [{:keys [tokens]} (body-edit "the cat sat" "the cot sit"
                                      [(tok :cat 4 7) (tok :sat 8 11) (tok :both 4 11)])]
      (is (= #{[:cat 4 7] [:sat 8 11] [:both 4 11]} (extents tokens)))))
  (testing "not folded: letters typed at its edges, the whole text"
    (let [fold (fn [old new tokens]
                 (-> (ta/diff old new)
                     (ta/pair-replacements old tokens)
                     (ta/fold-whole-words old tokens)))]
      (is (= [(ta/insert-op 2 "t") (ta/insert-op 4 "t")]
             (fold "x a y" "x tat y" [(tok :a 2 3)])))
      (is (= [(ta/insert-op 0 "ab") (ta/delete-op 3 2)]
             (fold "cow" "abc" [(tok :cow 0 3)]))))))

(defn- subsequence? [a b]
  (loop [a (seq (.toArray (.codePoints ^String a))) b (seq (.toArray (.codePoints ^String b)))]
    (cond (empty? a) true
          (empty? b) false
          (= (first a) (first b)) (recur (rest a) (rest b))
          :else (recur a (rest b)))))

(deftest a-word-replaced-leaves-every-token-on-its-word
  ;; The oracle above, extended to replaces: the replaced word's token reads
  ;; the new word, every other one its own. Left out, since the body cannot
  ;; tell what was meant: a new word that only adds letters to the old one
  ;; (typed at its edge, which stays outside it), and one that repeats a
  ;; neighbour (`cat cow` to `cow cow` is also `cat` deleted and `cow` added).
  (let [vocab ["the" "cat" "cow" "a" "at" "ab" "abc" "tat" "ta" "big" "bad" "𐌰𐌱" "𐌰" "é" "שלום" "ta."]
        cases (atom 0)]
    (doseq [seed (range 1 7)]
      (let [rng (java.util.Random. seed)
            pick #(nth % (.nextInt rng (count %)))]
        (dotimes [_ 200]
          (let [words (vec (repeatedly (+ 2 (.nextInt rng 6)) #(pick vocab)))
                k (.nextInt rng (count words))
                w (pick vocab)]
            (when-not (or (subsequence? (words k) w)
                          (= w (get words (dec k)))
                          (= w (get words (inc k))))
              (swap! cases inc)
              (let [words' (assoc words k w)
                    old (str/join " " words)
                    new (str/join " " words')
                    before (word-tokens words)
                    {:keys [text tokens deleted]} (body-edit old new before)
                    extents (mapv (juxt :token/begin :token/end) (word-tokens words'))]
                (is (= new (:text/body text)))
                (is (= [] deleted))
                (is (= extents (mapv (into {} (map (juxt :token/id (juxt :token/begin :token/end))) tokens)
                                     (range (count words))))
                    (str "seed " seed ": " (pr-str old) " -> " (pr-str new)))))))))
    (is (< 800 @cases))))

(deftest a-letter-typed-where-two-morphemes-meet-joins-one-of-them
  ;; Between two morphemes of one word the letters either side are the same
  ;; as the one typed, so moving an edit there looked free, and the letter
  ;; ended up inside the word but in neither morpheme.
  (let [on (fn [layer t] (assoc t :token/layer layer))]
    (testing "an `a` typed after `aa` (`a` + `a`) stays outside the word, as appending does"
      (let [{:keys [tokens]} (body-edit "ab aa tat" "ab aaa tat"
                                        [(on :w (tok :w 3 5)) (on :m (tok :m1 3 4)) (on :m (tok :m2 4 5))])]
        (is (= #{[:w 3 5] [:m1 3 4] [:m2 4 5]} (extents tokens)))))
    (testing "a `b` doubled in `ab` + `c` stays inside the word, between the two as before the slide"
      ;; Joining `ab` would need the pair to cost more than a letter inside a
      ;; morpheme, and then a letter doubled in `a` + `b` leaves the word
      ;; (see the test below).
      (let [{:keys [tokens]} (body-edit "at abc cat" "at abbc cat"
                                        [(on :w (tok :w 3 6)) (on :m (tok :m1 3 5)) (on :m (tok :m2 5 6))])]
        (is (= #{[:w 3 7] [:m1 3 5] [:m2 6 7]} (extents tokens)))))
    (testing "two sentences meeting at a word's start do not keep a new word out of there"
      (let [{:keys [tokens]} (body-edit "x.\nabc" "x.\nat abc"
                                        [(on :s (tok :s1 0 3)) (on :s (tok :s2 3 6))
                                         (on :w (tok :x 0 1)) (on :w (tok :abc 3 6))])]
        (is (= [6 9] ((juxt :token/begin :token/end) (first (filter #(= :abc (:token/id %)) tokens)))))))))

(deftest a-letter-doubled-where-two-tokens-meet-is-not-pushed-out-of-its-word
  ;; A place between two tokens of one layer that meet costs something, but
  ;; no more than the start of the word, or the letter leaves the word.
  (let [on (fn [layer t] (assoc t :token/layer layer))
        at (fn [tokens id] ((juxt :token/begin :token/end) (first (filter #(= id (:token/id %)) tokens))))]
    (testing "an `a` doubled in `a` + `b` stays inside the word"
      (let [{:keys [tokens]} (body-edit "x ab y" "x aab y"
                                        [(on :w (tok :ab 2 4)) (on :m (tok :m1 2 3)) (on :m (tok :m2 3 4))])]
        (is (= [2 5] (at tokens :ab)))))
    (testing "an `a` doubled in the word `a` before a full stop is not put before the word"
      (let [{:keys [tokens]} (body-edit "x a. y" "x aa. y"
                                        [(on :w (tok :x 0 1)) (on :w (tok :a 2 3)) (on :w (tok :p 3 4))
                                         (on :w (tok :y 5 6))])]
        (is (= [2 3] (at tokens :a)))))
    (testing "nor at the start of a sentence, where the sentence before would take it"
      (let [{:keys [tokens]} (body-edit "tat! a. tat" "tat! aa. tat"
                                        [(on :w (tok :tat 0 3)) (on :w (tok :x 3 4)) (on :w (tok :a 5 6))
                                         (on :w (tok :p 6 7)) (on :w (tok :tat2 8 11))
                                         (on :s (tok :s1 0 5)) (on :s (tok :s2 5 11))])]
        (is (= [5 6] (at tokens :a)))
        (is (= [0 5] (at tokens :s1)))))))

(deftest a-new-word-typed-beside-a-changed-word-stays-out-of-its-token
  ;; A replaced or respelled word keeps its token, and a word typed next to it
  ;; in the same save is a new word, outside that token.
  (doseq [[old new tokens expected]
          [["x cow y" "x a co y" [(tok :x 0 1) (tok :cow 2 5) (tok :y 6 7)]
            #{[:x 0 1] [:cow 4 6] [:y 7 8]}]
           ["x cow y" "x co ab y" [(tok :x 0 1) (tok :cow 2 5) (tok :y 6 7)]
            #{[:x 0 1] [:cow 2 4] [:y 8 9]}]
           ["a tac tat" "a tac bad 𐌰" [(tok :a 0 1) (tok :tac 2 5) (tok :tat 6 9)]
            #{[:a 0 1] [:tac 2 5] [:tat 6 9]}]
           ["ta.! 𐌰" "the big! 𐌰" [(tok :ta 0 3) (tok :p 3 4) (tok :g 5 6)]
            #{[:ta 0 3] [:p 7 8] [:g 9 10]}]
           ["tat ab c" "owl cat ab c" [(tok :tat 0 3) (tok :ab 4 6) (tok :c 7 8)]
            #{[:tat 4 7] [:ab 8 10] [:c 11 12]}]
           ;; a zero-width token at the word's end stays at its end
           ["x cow y" "x co ab y" [(tok :cow 2 5) (tok :z 5 5)] #{[:cow 2 4] [:z 4 4]}]
           ;; a word typed over with two, the space typed inside it
           ["x NY y" "x New York y" [(tok :x 0 1) (tok :ny 2 4) (tok :y 5 6)]
            #{[:x 0 1] [:ny 2 5] [:y 11 12]}]
           ;; a space typed inside a word: the token goes on the part that
           ;; keeps more of it
           ["x cow y" "x c ow y" [(tok :x 0 1) (tok :cow 2 5) (tok :y 6 7)]
            #{[:x 0 1] [:cow 4 6] [:y 7 8]}]
           ;; a word typed before a word is only an insert
           ["x cow y" "x a cow y" [(tok :x 0 1) (tok :cow 2 5) (tok :y 6 7)]
            #{[:x 0 1] [:cow 4 7] [:y 8 9]}]]]
    (let [{:keys [text tokens deleted]} (body-edit old new tokens)]
      (is (= new (:text/body text)))
      (is (= [] deleted))
      (is (= expected (extents tokens)) (str (pr-str old) " -> " (pr-str new)))))
  (testing "the new words never move out of a sentence or away from a marker"
    ;; In front of `cow` is the start of a sentence, and the sentence before
    ;; would take `a ` there.
    (is (= #{[:s1 0 3] [:s2 3 9] [:cow 3 7]}
           (extents (:tokens (body-edit "x. cow y" "x. a co y"
                                        [(tok :s1 0 3) (tok :s2 3 8) (tok :cow 3 6)])))))
    ;; `NY` keeps its `Y` in `York`, and a zero-width token after it marks
    ;; that letter's end, so of the two words that share a letter with `NY`
    ;; the token takes `York`.
    (is (= #{[:ny 6 10] [:z 10 10]}
           (extents (:tokens (body-edit "x NY y" "x New York y" [(tok :ny 2 4) (tok :z 4 4)]))))))
  (testing "a token with a space in it, such as a sentence, still takes the new text whole"
    (let [{:keys [tokens]} (body-edit "The cat.\nA dog.\n" "My pig ate.\nA dog.\n"
                                      [(tok :s1 0 9) (tok :s2 9 16)])]
      (is (= #{[:s1 0 12] [:s2 12 19]} (extents tokens))))))

;; ---------------------------------------------------------------------------
;; A replace that takes whole words and the edge of the next one. Deleting
;; `Yarın ` and capitalizing `köye` is delete `Yarın k`, insert `K`, one
;; replace that no token holds: `köye` lost its first letter and `K` stood
;; outside every word. Cut at the edge of the word it reaches into, it is
;; `Yarın ` deleted and `k` replaced by `K` inside `köye`.

(deftest a-replace-into-the-edge-of-a-word-keeps-the-word-whole
  (let [on (fn [layer t] (assoc t :token/layer layer))
        old "Ali kitabı verdi.\nYarın köye döneceğiz.\n"
        new "Ali kitabı verdi.\nKöye döneceğiz.\n"
        tokens [(on :s (tok :s1 0 18)) (on :s (tok :s2 18 40))
                (on :w (tok :ali 0 3)) (on :w (tok :kitabi 4 10)) (on :w (tok :verdi 11 16))
                (on :w (tok :p1 16 17)) (on :w (tok :yarin 18 23)) (on :w (tok :koye 24 28))
                (on :w (tok :donecegiz 29 38)) (on :w (tok :p2 38 39))
                ;; a morpheme over the whole word, as igt makes them
                (on :m (tok :koye-m 24 28))]
        {:keys [text tokens deleted]} (body-edit old new tokens)]
    (is (= new (:text/body text)))
    (is (= [:yarin] deleted))
    (is (= #{[:s1 0 18] [:s2 18 34] [:ali 0 3] [:kitabi 4 10] [:verdi 11 16] [:p1 16 17]
             [:koye 18 22] [:koye-m 18 22] [:donecegiz 23 32] [:p2 32 33]}
           (extents tokens))))
  (testing "a word typed in place of the deleted ones stays out of the word"
    (let [ops [(ta/replace-op 2 7 "Bugün K")]
          old "x Yarın köye y"
          tokens [(tok :x 0 1) (tok :yarin 2 7) (tok :koye 8 12) (tok :y 13 14)]
          {:keys [text tokens deleted]} (apply-all (ta/fold-whole-words ops old tokens) old tokens)]
      (is (= "x Bugün Köye y" (:text/body text)))
      (is (= [:yarin] deleted))
      (is (= #{[:x 0 1] [:koye 8 12] [:y 13 14]} (extents tokens)))))
  (testing "the last letter of a word respelled and the words after it deleted"
    (let [{:keys [text tokens deleted]} (body-edit "the cat sat on" "the caQ on"
                                                   [(tok :the 0 3) (tok :cat 4 7) (tok :sat 8 11)
                                                    (tok :on 12 14)])]
      (is (= "the caQ on" (:text/body text)))
      (is (= [:sat] deleted))
      (is (= #{[:the 0 3] [:cat 4 7] [:on 8 10]} (extents tokens)))))
  (testing "a marker where the kept word begins stays at its start"
    (let [{:keys [tokens deleted]} (body-edit "x Yarın köye y" "x Köye y"
                                              [(tok :yarin 2 7) (tok :koye 8 12) (tok :z 8 8)])]
      (is (= [:yarin] deleted))
      (is (= #{[:koye 2 6] [:z 2 2]} (extents tokens)))))
  (testing "a replace from inside one word into another is left as it is"
    (let [{:keys [tokens]} (body-edit "x cat dog y" "x cQog y"
                                      [(tok :cat 2 5) (tok :dog 6 9)])]
      (is (= #{[:cat 2 3] [:dog 4 6]} (extents tokens))))))

(deftest words-deleted-before-a-respelled-word-leave-every-other-word-token-on-its-word
  ;; Seeded. Delete one to three words, and respell the first letter of the
  ;; word after them, or the last letter of the word before them. Every token
  ;; left must sit exactly on a word of the new body, one per word. The
  ;; respelled word has two letters at least: one letter respelled is a word
  ;; replaced, and the body cannot tell which of the words it stands for.
  (let [vocab ["the" "cat" "sat" "on" "a" "mat" "at" "tat" "ta" "kai" "kaki" "𐌰𐌱" "é" "köye"]
        long-words (filterv #(< 1 (cp/cp-count %)) vocab)]
    (doseq [seed (range 1 7)]
      (let [rng (java.util.Random. seed)
            pick #(nth % (.nextInt rng (count %)))]
        (dotimes [case-n 150]
          (let [m (inc (.nextInt rng 3))
                j (inc (.nextInt rng 4))
                after? (.nextBoolean rng)
                k (if after? (+ j m) (dec j))
                w (pick long-words)
                words (-> (vec (repeatedly (+ j m 1 (.nextInt rng 3)) #(pick vocab)))
                          (assoc k w))
                n (cp/cp-count w)
                w' (if after?
                     (str "Q" (cp/cp-subs w 1 n))
                     (str (cp/cp-subs w 0 (dec n)) "Q"))
                words' (-> (assoc words k w')
                           (as-> v (into (subvec v 0 j) (subvec v (+ j m)))))
                old (str/join " " words)
                new (str/join " " words')
                before (word-tokens words)
                {:keys [text tokens deleted]} (body-edit old new before)
                want (set (map (juxt :token/begin :token/end) (word-tokens words')))
                got (map (juxt :token/begin :token/end) tokens)]
            (is (= new (:text/body text)))
            (is (= m (count deleted)) (str "seed " seed " case " case-n ": " (pr-str old) " -> " (pr-str new)))
            (is (= want (set got)) (str "seed " seed " case " case-n ": " (pr-str old) " -> " (pr-str new)))
            (is (= (count got) (count (set got))))))))))

(deftest a-sentence-edge-is-not-a-word-edge-to-cut-a-replace-at
  ;; A sentence ends after the whitespace that follows it. Cut there, `\na`
  ;; replaced by `Qx ` put `Qx` in the sentence before and left the word
  ;; token of `a` on the space.
  (let [on (fn [layer t] (assoc t :token/layer layer))
        ws-in (fn [body {:token/keys [begin end]}]
                (boolean (re-find #"\s" (cp/cp-subs body begin end))))]
    (doseq [[old new tokens]
            [["cat mat \na" "cat mat Qx "
              [(on :s (tok :s1 0 9)) (on :s (tok :s2 9 10))
               (on :w (tok :cat 0 3)) (on :w (tok :mat 4 7)) (on :w (tok :a 9 10))]]
             ["Ali geldi.\nYarın" "Ali geldi. Bugün "
              [(on :s (tok :s1 0 11)) (on :s (tok :s2 11 16))
               (on :w (tok :ali 0 3)) (on :w (tok :geldi 4 10)) (on :w (tok :yarin 11 16))]]
             ;; a node standing over its whole sentence, as UMR anchors one
             ["köye\né" "köye x "
              [(on :u (tok :node 0 5)) (on :w (tok :koye 0 4)) (on :w (tok :e 5 6))]]]]
      (let [{:keys [text tokens]} (body-edit old new tokens #{:s})
            body (:text/body text)]
        (is (= new body))
        (is (not-any? #(ws-in body %) (filter #(= :w (:token/layer %)) tokens))
            (str (pr-str old) " -> " (pr-str new) ": " (pr-str (extents tokens))))))))

(deftest a-word-respelled-beside-deleted-words-folds-as-it-does-alone
  ;; Seeded. A word with an analysis (one to three morphemes, split at random)
  ;; has letters at one edge respelled, and the words beside that edge
  ;; deleted, or not. The word and its morphemes must come out the same both
  ;; ways, so the fold rulings (`cow` to `cab` drops `co` + `w`, a change
  ;; inside one morpheme keeps it) hold beside a deletion too. The new
  ;; letters appear in no word, so the diff cannot take them from the
  ;; deleted ones.
  (let [vocab ["the" "cat" "sat" "on" "mat" "kai" "kaki" "𐌰𐌱" "köye" "كتاب" "שלום" "你好" "dog" "tatu"]
        letters ["Q" "X" "Z" "𐍂" "ڤ"]
        tokens-for (fn [words k cuts]
                     (loop [i 0 p 0 out []]
                       (if (= i (count words))
                         out
                         (let [n (cp/cp-count (words i))]
                           (recur (inc i) (+ p n 1)
                                  (cond-> (conj out (assoc (tok (if (= i k) :W i) p (+ p n)) :token/layer :w))
                                    (= i k) (into (map-indexed (fn [j [a b]] (assoc (tok [:m j] (+ p a) (+ p b)) :token/layer :m))
                                                               (partition 2 1 (concat [0] cuts [n]))))))))))
        view (fn [{:keys [text tokens]}]
               (into {} (keep (fn [{:token/keys [id layer begin end]}]
                                (when (or (= :W id) (= :m layer))
                                  [id (cp/cp-subs (:text/body text) begin end)])))
                     tokens))]
    (doseq [seed (range 1 5)]
      (let [rng (java.util.Random. seed)
            pick #(nth % (.nextInt rng (count %)))]
        (dotimes [case-n 200]
          (let [m (inc (.nextInt rng 2))
                before? (.nextBoolean rng)
                k (+ (inc (.nextInt rng 3)) (if before? m 0))
                w (loop [] (let [w (pick vocab)] (if (< 2 (cp/cp-count w)) w (recur))))
                words (assoc (vec (repeatedly (+ k m 2) #(pick vocab))) k w)
                n (cp/cp-count w)
                cuts (sort (distinct (repeatedly (.nextInt rng 3) #(inc (.nextInt rng (dec n))))))
                r (inc (.nextInt rng (dec n)))
                rep (apply str (repeatedly (inc (.nextInt rng 2)) #(pick letters)))
                alone (assoc words k (if before?
                                       (str rep (cp/cp-subs w r n))
                                       (str (cp/cp-subs w 0 (- n r)) rep)))
                beside (if before?
                         (into (subvec alone 0 (- k m)) (subvec alone k))
                         (into (subvec alone 0 (inc k)) (subvec alone (+ k 1 m))))
                old (str/join " " words)
                tokens (tokens-for words k cuts)]
            (is (= (view (body-edit old (str/join " " alone) tokens))
                   (view (body-edit old (str/join " " beside) tokens)))
                (str "seed " seed " case " case-n ": " (pr-str old) " -> " (pr-str (str/join " " beside))
                     ", morphemes cut at " (pr-str cuts)))))))))

(deftest a-word-edge-need-not-be-a-space-to-cut-a-replace-at
  ;; Only a space counted as a word's edge, so a replace reaching into a word
  ;; beside a punctuation mark the tokenizer left out of it, a punctuation
  ;; token (UD), a no-break space or a script written without spaces was not
  ;; cut, and the word lost the letters respelled at its edge.
  (let [on (fn [layer t] (assoc t :token/layer layer))
        words #(filter (comp #{:w} :token/layer) %)]
    (doseq [[old new tokens want]
            [;; igt leaves the comma and the full stop in the gaps
             ["Ali geldi, Veli gitti." "Ali geldI."
              [(on :w (tok :ali 0 3)) (on :w (tok :geldi 4 9)) (on :w (tok :veli 11 15)) (on :w (tok :gitti 16 21))]
              #{[:ali 0 3] [:geldi 4 9]}]
             ["well-known cat" "Known cat"
              [(on :w (tok :well 0 4)) (on :w (tok :known 5 10)) (on :w (tok :cat 11 14))]
              #{[:known 0 5] [:cat 6 9]}]
             ;; UD makes the full stop a token of its own
             ["verdi. Sonra geldi" "verdI geldi"
              [(on :w (tok :verdi 0 5)) (on :w (tok :stop 5 6)) (on :w (tok :sonra 7 12)) (on :w (tok :geldi 13 18))]
              #{[:verdi 0 5] [:geldi 6 11]}]
             ["Yarın köye döneceğiz" "Köye döneceğiz"
              [(on :w (tok :yarin 0 5)) (on :w (tok :koye 6 10)) (on :w (tok :donecegiz 11 20))]
              #{[:koye 0 4] [:donecegiz 5 14]}]
             ["你好世界\n" "大界\n"
              [(on :s (tok :s1 0 5)) (on :w (tok :nihao 0 2)) (on :w (tok :shijie 2 4))]
              #{[:shijie 0 2]}]]]
      (let [{:keys [text tokens]} (body-edit old new tokens #{:s})]
        (is (= new (:text/body text)))
        (is (= want (extents (words tokens))) (str (pr-str old) " -> " (pr-str new)))))))

(deftest a-token-over-several-words-does-not-stop-the-cut
  ;; A UMR node over `köye cat` begins inside the replace of `t köye` by `Ж`
  ;; and goes on past it, but past a space: the replace takes `köye` whole
  ;; and reaches into no word there. Counted as reaching in, it stopped the
  ;; cut at the end of `mat`, which lost its `t`.
  (let [on (fn [layer t] (assoc t :token/layer layer))
        {:keys [text tokens]} (body-edit "mat köye cat\n" "maЖ cat\n"
                                         [(on :s (tok :s1 0 13)) (on :w (tok :mat 0 3)) (on :w (tok :koye 4 8))
                                          (on :w (tok :cat 9 12)) (on :u (tok :node 4 12))]
                                         #{:s})]
    (is (= "maЖ cat\n" (:text/body text)))
    (is (= #{[:mat 0 3] [:cat 4 7]} (extents (filter (comp #{:w} :token/layer) tokens)))))
  (testing "one that ends where the replace ends still marks where a word begins"
    ;; `\né` replaced by ` ЖQ`: the sentence after the line break goes on past
    ;; `é`, and the cut at its start keeps `é`'s token on `ЖQ`.
    (let [on (fn [layer t] (assoc t :token/layer layer))
          {:keys [text tokens]} (body-edit "mat\né tatu\n" "mat ЖQ tatu\n"
                                           [(on :s (tok :s1 0 4)) (on :s (tok :s2 4 11))
                                            (on :w (tok :mat 0 3)) (on :w (tok :e 4 5)) (on :w (tok :tatu 6 10))]
                                           #{:s})]
      (is (= "mat ЖQ tatu\n" (:text/body text)))
      (is (= #{[:mat 0 3] [:e 4 6] [:tatu 7 11]} (extents (filter (comp #{:w} :token/layer) tokens)))))))

(deftest words-deleted-beside-a-respelled-word-with-any-separator
  ;; Seeded, as `words-deleted-before-a-respelled-word-...` but with the words
  ;; apart by a space, a tab, a no-break space, or a punctuation mark left in
  ;; the gap (`, ` or `-`), and with a sentence partition and UMR-like nodes
  ;; over one word or two. Every word token left must sit exactly on a word.
  ;; The respelled word has two letters at least, as there.
  (let [vocab ["the" "cat" "sat" "on" "a" "mat" "kai" "kaki" "𐌰𐌱" "köye" "كتاب" "你好"]
        long-words (filterv #(< 1 (cp/cp-count %)) vocab)
        seps [" " "\t" " " ", " "-"]]
    (doseq [seed (range 1 5)]
      (let [rng (java.util.Random. seed)
            pick #(nth % (.nextInt rng (count %)))]
        (dotimes [case-n 150]
          (let [m (inc (.nextInt rng 3))
                j (inc (.nextInt rng 4))
                after? (.nextBoolean rng)
                k (if after? (+ j m) (dec j))
                n-words (+ j m 1 (.nextInt rng 3))
                words (-> (vec (repeatedly n-words #(pick vocab))) (assoc k (pick long-words)))
                gaps (vec (repeatedly (dec n-words) #(pick seps)))
                w (words k)
                n (cp/cp-count w)
                w' (if after?
                     (str "Q" (cp/cp-subs w 1 n))
                     (str (cp/cp-subs w 0 (dec n)) "Q"))
                ;; deleting words [j, j+m) takes the gap after each of them
                keep? (fn [i] (not (<= j i (dec (+ j m)))))
                build (fn [ws gs]
                        (loop [i 0 p 0 sb (StringBuilder.) out []]
                          (if (= i (count ws))
                            [(str sb "\n") out]
                            (let [x (ws i) e (+ p (cp/cp-count x))
                                  g (if (< i (dec (count ws))) (gs i) "")]
                              (recur (inc i) (+ e (cp/cp-count g)) (.append (.append sb ^String x) ^String g)
                                     (conj out [p e]))))))
                [old spans] (build words gaps)
                kept (filterv keep? (range n-words))
                [new new-spans] (build (mapv #(if (= % k) w' (words %)) kept)
                                       (mapv gaps (butlast kept)))
                on (fn [layer t] (assoc t :token/layer layer))
                tokens (-> [(on :s (tok :s 0 (cp/cp-count old)))]
                           (into (map-indexed (fn [i [b e]] (on :w (tok i b e)))) spans)
                           (into (keep (fn [i] (when (.nextBoolean rng)
                                                 (on :u (tok [:u i] (first (spans i)) (second (spans (inc i))))))))
                                 (range (dec n-words))))
                {:keys [text tokens deleted]} (body-edit old new tokens #{:s})
                got (map (juxt :token/begin :token/end) (filter (comp #{:w} :token/layer) tokens))
                msg (str "seed " seed " case " case-n ": " (pr-str old) " -> " (pr-str new))]
            (is (= new (:text/body text)))
            (is (= (set new-spans) (set got)) msg)
            (is (= (count got) (count (set got))) msg)))))))

(deftest a-space-typed-before-a-marked-word-stays-out-of-it
  ;; A zero-width marker at a word's start kept the text typed in front of
  ;; the word inside it, so its first letter stays after the marker. A space
  ;; typed there went into the word too: `café` to ` xcat` left the word
  ;; token on ` xcat`. Only the space goes out of the word. Text inserted
  ;; where a marker stands goes after it, so the marker is left in front of
  ;; the space. A space typed after the word goes behind a marker at its end.
  (let [on (fn [layer t] (assoc t :token/layer layer))
        spaced? (fn [body {:token/keys [begin end]}] (boolean (re-find #"\s" (cp/cp-subs body begin end))))]
    (doseq [[old new tokens want]
            [["café\n" " xcat\n" [(on :w (tok :w 0 4)) (on :z (tok :z 0 0))] #{[:w 1 5] [:z 0 0]}]
             ["a café b\n" "a  xcat b\n" [(on :w (tok :a 0 1)) (on :w (tok :w 2 6)) (on :z (tok :z 2 2))
                                          (on :w (tok :b 7 8))]
              #{[:a 0 1] [:w 3 7] [:z 2 2] [:b 8 9]}]
             ["a cafe b\n" "a xcafé\t b\n" [(on :w (tok :a 0 1)) (on :w (tok :w 2 6)) (on :z (tok :z 6 6))
                                            (on :w (tok :b 7 8))]
              #{[:a 0 1] [:w 2 7] [:z 7 7] [:b 9 10]}]]]
      (let [{:keys [text tokens]} (body-edit old new tokens)]
        (is (= new (:text/body text)))
        (is (not-any? #(spaced? new %) (filter (comp #{:w} :token/layer) tokens))
            (str (pr-str old) " -> " (pr-str new) ": " (pr-str (extents tokens))))
        (is (= want (extents tokens)) (str (pr-str old) " -> " (pr-str new)))))))

(deftest a-word-typed-after-a-word-with-an-end-marker-stays-out-of-it
  ;; A zero-width marker at a word's end kept every new word typed after a
  ;; respelled word inside it, when the word's last letter came through: the
  ;; split only took a new word reaching to the end of the new text. `sat` to
  ;; `Xat XQ` left the word token on `Xat XQ`. A new word that ends with the
  ;; old last letter takes the token, and the marker stays at its end. `NY`
  ;; to `New York` still gives the token to `York`, which holds the `Y`.
  (let [on (fn [layer t] (assoc t :token/layer layer))]
    (doseq [[old new tokens want]
            [["a sat\n" "a Xat XQ\n" [(on :w (tok :a 0 1)) (on :w (tok :sat 2 5)) (on :z (tok :z 5 5))]
              #{[:a 0 1] [:sat 2 5] [:z 5 5]}]
             ;; the case the oracle found, beside deleted words
             ["b sat\n" "Xat XQ\n" [(on :w (tok :b 0 1)) (on :w (tok :sat 2 5)) (on :z (tok :z 5 5))]
              #{[:sat 0 3] [:z 3 3]}]
             ;; a letter added after the old last one goes into the word, and the marker to its end
             ["a sat\n" "a Xats XQ\n" [(on :w (tok :a 0 1)) (on :w (tok :sat 2 5)) (on :z (tok :z 5 5))]
              #{[:a 0 1] [:sat 2 6] [:z 6 6]}]
             ["x NY y" "x New York y" [(on :w (tok :ny 2 4)) (on :z (tok :z 4 4))]
              #{[:ny 6 10] [:z 10 10]}]]]
      (let [{:keys [text tokens]} (body-edit old new tokens)]
        (is (= new (:text/body text)))
        (is (= want (extents tokens)) (str (pr-str old) " -> " (pr-str new)))))))

(deftest a-word-edge-is-a-space-as-the-apps-tokenizers-read-one
  ;; The apps split words on JavaScript's `\s`. Java also counts the four
  ;; information separators (U+001C to U+001F) as whitespace, and JavaScript
  ;; does not, so to the apps they are letters inside a word, and the cut
  ;; took them for the word's edge and left the respelled letter out.
  (let [us (str (char 0x1F))
        on (fn [layer t] (assoc t :token/layer layer))
        {:keys [text tokens]} (body-edit (str "x a" us "b\n") "Qb\n"
                                         [(on :w (tok :x 0 1)) (on :w (tok :ab 2 5))])]
    (is (= "Qb\n" (:text/body text)))
    (is (= #{[:ab 0 2]} (extents tokens)))))

(deftest a-word-deleted-at-the-edge-of-a-token-over-several-words-takes-its-space-along
  ;; UMR anchors a node aligned to words next to each other on one token over
  ;; them. Deleting the word at either edge could take the space before it
  ;; or the one after it for the same text, both cut the node, and the tie
  ;; stayed where the diff put it, which left the node on `tatu ` or ` tatu`.
  (let [on (fn [layer t] (assoc t :token/layer layer))
        spaced? (fn [body {:token/keys [begin end]}]
                  (let [x (cp/cp-subs body begin end)] (not= x (str/trim x))))]
    (doseq [[old new tokens want]
            [["a tatu the x\n" "a tatu x\n"
              [(on :w (tok :a 0 1)) (on :w (tok :tatu 2 6)) (on :w (tok :the 7 10)) (on :w (tok :x 11 12))
               (on :u (tok :node 2 10))]
              [2 6]]
             ;; a word respelled before, so the delete stands apart
             ["mat tatu the\n" "mXt the\n"
              [(on :w (tok :mat 0 3)) (on :w (tok :tatu 4 8)) (on :w (tok :the 9 12)) (on :u (tok :node 4 12))]
              [4 7]]
             ["שלום on sat the\n" "של𐍂ם sat the\n"
              [(on :w (tok :a 0 4)) (on :w (tok :on 5 7)) (on :w (tok :sat 8 11)) (on :w (tok :the 12 15))
               (on :u (tok :node 5 11))]
              [5 8]]]]
      (let [{:keys [text tokens]} (body-edit old new tokens)
            node (first (filter (comp #{:node} :token/id) tokens))]
        (is (= new (:text/body text)))
        (is (= want [(:token/begin node) (:token/end node)]) (str (pr-str old) " -> " (pr-str new)))
        (is (not-any? #(spaced? new %) tokens) (str (pr-str old) " -> " (pr-str new)))))))

(deftest two-edits-sliding-towards-each-other-do-not-meet
  ;; Each delete cuts a token where it stands and could slide into the run of
  ;; `a` between them, and both would have taken the same letter.
  (let [old "xaaaaay"
        tokens [(tok :t 1 3) (tok :u 4 6)]
        ops (ta/slide-to-tokens [(ta/delete-op 1 1) (ta/delete-op 4 1)] old tokens)
        edits (#'ta/ops->edits ops)]
    (is (every? (fn [[a b]] (< (:end a) (:start b))) (partition 2 1 edits)) (pr-str ops))
    (is (= "xaaay" (:text/body (:text (apply-all ops old tokens)))))))

(deftest many-edits-over-a-long-text-slide-quickly
  ;; One edit per 50 words over 50,000 word tokens. Scanning every token for
  ;; every edit took about 4.5 s here, holding the write lock.
  (let [words (vec (take 50000 (cycle ["the" "cat" "sat" "ta" "tat" "at"])))
        old (str/join " " words)
        new (str/join " " (map-indexed (fn [i w] (if (zero? (mod i 50)) (str w "x") w)) words))
        tokens (word-tokens words)
        ops (ta/diff old new)
        t0 (System/nanoTime)
        slid (ta/slide-to-tokens ops old tokens)
        ms (/ (- (System/nanoTime) t0) 1e6)]
    (is (= 1000 (count ops)))
    (is (= new (:text/body (:text (apply-all slid old [])))))
    (is (< ms 1000) (str ms " ms"))))

;; ---------------------------------------------------------------------------
;; A combining mark typed at a word's end joins the word (ruled 2026-09-27).
;; Some keyboards type an accent as a separate mark after the letter, and the
;; standing rule that text typed after a word stays outside it split the
;; letter from its accent at the token's edge.

(defn- cps
  "A string of the given code points, so the marks read as numbers here."
  [& xs]
  (let [sb (StringBuilder.)]
    (doseq [x xs] (if (string? x) (.append sb ^String x) (.appendCodePoint sb (int x))))
    (str sb)))

(def ^:private acute 0x301)

(deftest a-combining-mark-typed-at-a-words-end-joins-the-word
  (testing "an explicit insert"
    (let [{:keys [text tokens deleted]}
          (ta/apply-text-edit (ta/insert-op 4 (cps acute)) {:text/body "cafe latte"}
                              [(tok :cafe 0 4) (tok :z 4 4) (tok :latte 5 10)])]
      (is (= (cps "cafe" acute " latte") (:text/body text)))
      (is (= [] deleted))
      ;; the zero-width token at the word's end stays at its end, not between
      ;; the letter and its accent
      (is (= #{[:cafe 0 5] [:z 5 5] [:latte 6 11]} (extents tokens)))))
  (testing "only the marks join: what follows them stays outside"
    (let [{:keys [tokens]} (ta/apply-text-edit (ta/insert-op 4 (cps acute 0x323 "!"))
                                               {:text/body "cafe latte"}
                                               [(tok :cafe 0 4) (tok :latte 5 10)])]
      (is (= #{[:cafe 0 6] [:latte 8 13]} (extents tokens)))))
  (testing "a token that begins there moves past the mark"
    (let [{:keys [tokens]} (ta/apply-text-edit (ta/insert-op 4 (cps acute)) {:text/body "cafe."}
                                               [(tok :cafe 0 4) (tok :stop 4 5)])]
      (is (= #{[:cafe 0 5] [:stop 5 6]} (extents tokens)))))
  (testing "spacing (Mc) and enclosing (Me) marks, and an astral one, join too"
    (doseq [[mark body end] [[0x93E (cps 0x915) 1] [0x20DD "a" 1] [0x1D167 "do" 2]]]
      (let [n (cp/cp-count body)
            {:keys [tokens]} (ta/apply-text-edit (ta/insert-op n (cps mark)) {:text/body (str body " x")}
                                                 [(tok :w 0 n) (tok :x (inc n) (+ n 2))])]
        (is (= #{[:w 0 (inc end)] [:x (+ n 2) (+ n 3)]} (extents tokens)) (format "U+%04X" mark)))))
  (testing "a replace whose new text starts with a mark gives the mark to the letter before"
    (let [{:keys [text tokens]} (ta/apply-text-edit (ta/replace-op 1 1 (cps acute "c")) {:text/body "ab"}
                                                    [(tok :a 0 1) (tok :b 1 2)])]
      (is (= (cps "a" acute "c") (:text/body text)))
      (is (= #{[:a 0 2] [:b 2 3]} (extents tokens)))))
  (testing "a letter typed at a word's end still stays outside it"
    (let [{:keys [tokens]} (ta/apply-text-edit (ta/insert-op 3 "s") {:text/body "cat"} [(tok :cat 0 3)])]
      (is (= #{[:cat 0 3]} (extents tokens)))))
  (testing "a mark at the very start of the text has no letter to join"
    (let [{:keys [tokens]} (ta/apply-text-edit (ta/insert-op 0 (cps acute)) {:text/body "ab"}
                                               [(tok :z 0 0) (tok :ab 0 2)])]
      (is (= #{[:z 0 0] [:ab 1 3]} (extents tokens)))))
  (testing "a whole-body update"
    (let [{:keys [text tokens]} (body-edit "cafe latte" (cps "cafe" acute " latte")
                                           [(tok :cafe 0 4) (tok :latte 5 10) (tok :s 0 10)])]
      (is (= (cps "cafe" acute " latte") (:text/body text)))
      (is (= #{[:cafe 0 5] [:latte 6 11] [:s 0 11]} (extents tokens))))
    ;; at the end of the text, with an accent put on the last word
    (let [{:keys [tokens]} (body-edit "cafe" (cps "cafe" acute) [(tok :cafe 0 4)])]
      (is (= #{[:cafe 0 5]} (extents tokens))))))

;; ---------------------------------------------------------------------------
;; A word analyzed into morphemes and replaced outright moves onto the new
;; word, and its morphemes are deleted (ruled 2026-09-27). `cow` (`co` + `w`)
;; replaced by `abc` left the word and `co` on the `c` of `abc` and deleted
;; `w`.

(deftest an-analyzed-word-replaced-outright-moves-and-drops-its-morphemes
  (doseq [[old new tokens expected deleted]
          [["cat cow" "cat abc" [(tok :cat 0 3) (tok :cow 4 7) (tok :co 4 6) (tok :w 6 7)]
            #{[:cat 0 3] [:cow 4 7]} #{:co :w}]
           ;; `ta` to `bad` kept the word on `ba` and the `d` outside it
           ["x ta y" "x bad y" [(tok :ta 2 4) (tok :t 2 3) (tok :a 3 4)]
            #{[:ta 2 5]} #{:t :a}]
           ;; the sentence around it, a zero-width token at its start and the
           ;; other words' morphemes are untouched
           ["the cow sat" "the abc sat"
            [(tok :s 0 11) (tok :the 0 3) (tok :cow 4 7) (tok :sat 8 11) (tok :z 4 4)
             (tok :th 0 2) (tok :e 2 3) (tok :co 4 6) (tok :w 6 7) (tok :sa 8 10) (tok :t 10 11)]
            #{[:s 0 11] [:the 0 3] [:cow 4 7] [:sat 8 11] [:z 4 4]
              [:th 0 2] [:e 2 3] [:sa 8 10] [:t 10 11]}
            #{:co :w}]
           ;; a new word typed beside it stays out of it, as for a word
           ;; nobody analyzed
           ["x cow y" "x abc d y" [(tok :cow 2 5) (tok :co 2 4) (tok :w 4 5)]
            #{[:cow 2 5]} #{:co :w}]]]
    (let [{:keys [text tokens] :as r} (body-edit old new tokens)]
      (is (= new (:text/body text)))
      (is (= deleted (set (:deleted r))) (str (pr-str old) " -> " (pr-str new)))
      (is (= expected (extents tokens)) (str (pr-str old) " -> " (pr-str new))))))

(deftest a-word-whose-parts-each-hold-their-change-keeps-them
  ;; Only a replace that would leave the word or its parts broken is folded
  ;; over them. Otherwise each part keeps its own respelling, as before.
  (testing "a one-word sentence ending in a full stop, both of its words respelled"
    (let [{:keys [tokens deleted]} (body-edit "x\ncat." "x\nbat!"
                                              [(tok :s1 0 2) (tok :s2 2 6) (tok :cat 2 5) (tok :stop 5 6)])]
      (is (= [] deleted))
      (is (= #{[:s1 0 2] [:s2 2 6] [:cat 2 5] [:stop 5 6]} (extents tokens)))))
  (testing "a word respelled at both ends, each end inside one of its morphemes"
    (let [{:keys [tokens deleted]} (body-edit "x cat y" "x bad y"
                                              [(tok :cat 2 5) (tok :ca 2 4) (tok :t 4 5)])]
      (is (= [] deleted))
      (is (= #{[:cat 2 5] [:ca 2 4] [:t 4 5]} (extents tokens))))))

(deftest an-analyzed-word-replaced-leaves-no-part-of-its-analysis
  ;; Every word is analyzed into one or two morphemes. After one word is
  ;; replaced, its token is on the new word, and its morphemes are either all
  ;; gone or still cover the new word from end to end, never a part of it.
  ;; Every other word keeps its word and morpheme tokens where they were.
  (let [vocab ["the" "cat" "cow" "at" "ab" "abc" "tat" "ta" "big" "bad" "𐌰𐌱" "שלום" "ta."]
        cases (atom 0)]
    (doseq [seed (range 1 7)]
      (let [rng (java.util.Random. seed)
            pick #(nth % (.nextInt rng (count %)))]
        (dotimes [_ 200]
          (let [words (vec (repeatedly (+ 2 (.nextInt rng 5)) #(pick vocab)))
                k (.nextInt rng (count words))
                w (pick vocab)]
            (when-not (or (subsequence? (words k) w)
                          (= w (get words (dec k)))
                          (= w (get words (inc k))))
              (swap! cases inc)
              (let [words' (assoc words k w)
                    old (str/join " " words)
                    new (str/join " " words')
                    wt (word-tokens words)
                    ;; morphemes: a cut after the first letter of a word of two or more
                    morphs (mapcat (fn [{:token/keys [id begin end]}]
                                     (if (< 1 (- end begin))
                                       [(tok [id 0] begin (inc begin)) (tok [id 1] (inc begin) end)]
                                       [(tok [id 0] begin end)]))
                                   wt)
                    {:keys [text tokens]} (body-edit old new (concat wt morphs))
                    now (into {} (map (juxt :token/id (juxt :token/begin :token/end))) tokens)
                    new-wt (word-tokens words')
                    msg (str "seed " seed ": " (pr-str old) " -> " (pr-str new))]
                (is (= new (:text/body text)))
                (doseq [i (range (count words))
                        :let [[b e] ((juxt :token/begin :token/end) (new-wt i))]]
                  (is (= [b e] (now i)) msg)
                  (if (= i k)
                    (let [parts (sort (keep #(now [i %]) [0 1]))]
                      (is (or (empty? parts)
                              (and (= b (ffirst parts)) (= e (second (last parts)))
                                   (every? (fn [[[_ e1] [b2 _]]] (= e1 b2)) (partition 2 1 parts))))
                          (str msg " parts " (pr-str parts))))
                    (let [delta (- b (:token/begin (wt i)))]
                      (doseq [m (filter #(= i (first (:token/id %))) morphs)]
                        (is (= [(+ delta (:token/begin m)) (+ delta (:token/end m))] (now (:token/id m)))
                            msg)))))))))))
    (is (< 600 @cases))))

;; ---------------------------------------------------------------------------
;; The slide knows which layers are partitions (ruled 2026-09-27). A letter
;; inserted where two sentences of a partition meet goes into the sentence
;; that ends there, so a place there is not free for that layer.

(deftest the-slide-counts-an-insert-at-a-partition-boundary-as-growing-the-sentence-before
  (let [old "tat! a. tat big"
        new "tot! aa. tat big"
        tokens (map #(assoc % :token/layer :w)
                    [(tok :tat 0 3) (tok :x 3 4) (tok :a 5 6) (tok :p 6 7) (tok :tat2 8 11) (tok :big 12 15)])
        sentences [(assoc (tok :s1 0 5) :token/layer :s) (assoc (tok :s2 5 15) :token/layer :s)]
        all (concat tokens sentences)
        ops (ta/diff old new)]
    (testing "editscript puts the doubled `a` before the word, in the same save as another edit"
      (is (= 5 (:index (peek ops)))))
    (testing "told that the sentences are a partition, the slide puts it after"
      (let [{:keys [text tokens]} (body-edit old new all #{:s})
            at (into {} (map (juxt :token/id (juxt :token/begin :token/end))) tokens)]
        (is (= new (:text/body text)))
        (is (= [5 6] (at :a)))
        ;; the second sentence still starts at the word, so the partition
        ;; gives the first nothing of it
        (is (= [5 16] (at :s2)))))
    (testing "a layer that is not a partition leaves the choice as it was"
      (is (= (ta/slide-to-tokens ops old all) (ta/slide-to-tokens ops old all #{}))))
    (testing "a word typed at the start of a sentence stays out of the word after it"
      (let [s [(assoc (tok :s1 0 3) :token/layer :s) (assoc (tok :s2 3 6) :token/layer :s)
               (assoc (tok :x 0 1) :token/layer :w) (assoc (tok :abc 3 6) :token/layer :w)]
            {:keys [tokens]} (body-edit "x.\nabc" "x.\nat abc" s #{:s})]
        (is (= [6 9] ((juxt :token/begin :token/end) (first (filter #(= :abc (:token/id %)) tokens)))))))))

(deftest a-marker-at-a-words-start-stays-with-the-word-when-a-word-is-typed-before-it
  ;; Inside a sentence of a partition every place costs the sentence the
  ;; same, so what decides is the zero-width token at `cow`'s start: text
  ;; inserted where it stands would come between it and `cow`.
  (let [tokens [(assoc (tok :s 0 7) :token/layer :s) (assoc (tok :big 0 3) :token/layer :w)
                (assoc (tok :cow 4 7) :token/layer :w) (assoc (tok :z 4 4) :token/layer :z)]
        {:keys [tokens]} (body-edit "big cow" "big big cow" tokens #{:s})]
    (is (= #{[:s 0 11] [:big 0 3] [:cow 8 11] [:z 8 8]} (extents tokens))))
  (testing "a zero-width token between a word and a full stop glued to it is left alone"
    (let [tokens [(tok :c 6 7) (tok :stop 7 8) (tok :z 7 7)]
          {:keys [tokens]} (body-edit "a big c, x" "a big cc, x" tokens)]
      (is (= #{[:c 6 7] [:stop 8 9] [:z 7 7]} (extents tokens))))))

(deftest an-analyzed-word-with-a-new-word-typed-before-it-at-a-sentence-start-is-not-folded
  ;; The fold would keep `at co` together, since the sentence before would
  ;; take `at `, so the edits stay as they are: the word and `co` on `co`.
  (let [tokens [(assoc (tok :s1 0 3) :token/layer :s) (assoc (tok :s2 3 8) :token/layer :s)
                (assoc (tok :cow 3 6) :token/layer :w)
                (assoc (tok :co 3 5) :token/layer :m) (assoc (tok :w 5 6) :token/layer :m)]
        {:keys [text tokens deleted]} (body-edit "x. cow y" "x. at co y" tokens #{:s})]
    (is (= "x. at co y" (:text/body text)))
    (is (= [:w] deleted))
    (is (= #{[:s1 0 3] [:s2 6 10] [:cow 6 8] [:co 6 8]} (extents tokens)))))

(deftest an-analyzed-word-replaced-by-one-that-shares-its-first-letter-drops-its-morphemes
  ;; The shared first letter is trimmed off the diff, so the edits reach only
  ;; one end of the word. Applied as they are, `cow` (`co` + `w`) to `cab`
  ;; left `co` on the `c`, deleted `w`, and put `ab` in no morpheme.
  (doseq [[old new tokens expected deleted]
          [["cat cow" "cat cab" [(tok :cat 0 3) (tok :cow 4 7) (tok :co 4 6) (tok :w 6 7)]
            #{[:cat 0 3] [:cow 4 7]} #{:co :w}]
           ;; the last letters replaced, precomposed é included
           ["x caf\u00E9 y" "x cab y" [(tok :cafe 2 6) (tok :caf 2 5) (tok :e 5 6)]
            #{[:cafe 2 5]} #{:caf :e}]
           ;; the first letters replaced, the last one kept
           ["x cow y" "x baw y" [(tok :cow 2 5) (tok :c 2 3) (tok :ow 3 5)]
            #{[:cow 2 5]} #{:c :ow}]]]
    (let [{:keys [text tokens] :as r} (body-edit old new tokens)]
      (is (= new (:text/body text)))
      (is (= deleted (set (:deleted r))) (str (pr-str old) " -> " (pr-str new)))
      (is (= expected (extents tokens)) (str (pr-str old) " -> " (pr-str new)))))
  (testing "an edit that leaves every letter of the word in a morpheme keeps them"
    (doseq [[new expected gone]
            [;; a morpheme deleted whole
             ["cat co" #{[:cow 4 6] [:co 4 6]} [:w]]
             ;; a letter respelled inside a morpheme
             ["cat caw" #{[:cow 4 7] [:co 4 6] [:w 6 7]} []]
             ;; letters typed at the word's end stay outside it
             ["cat cows" #{[:cow 4 7] [:co 4 6] [:w 6 7]} []]
             ;; a letter typed where two morphemes meet takes nothing out
             ["cat coxw" #{[:cow 4 8] [:co 4 6] [:w 7 8]} []]]]
      (let [{:keys [tokens deleted]} (body-edit "cat cow" new [(tok :cow 4 7) (tok :co 4 6) (tok :w 6 7)])]
        (is (= gone (vec deleted)) new)
        (is (= expected (extents tokens)) new)))))

(deftest a-word-typed-before-a-word-that-starts-with-its-letter-leaves-the-marker-on-the-word
  ;; `a ` typed before `abc` and ` a` typed after `tot` give the same text.
  ;; The first leaves the zero-width token at `abc`'s start in front of the
  ;; new `a`, so the second is taken, though the letter after the marker is
  ;; the same in both.
  (let [tokens [(assoc (tok :tot 0 3) :token/layer :w) (assoc (tok :abc 4 7) :token/layer :w)
                (assoc (tok :z 4 4) :token/layer :z)]
        {:keys [tokens]} (body-edit "tot abc" "tot a abc" tokens)]
    (is (= #{[:tot 0 3] [:abc 6 9] [:z 6 6]} (extents tokens))))
  (testing "at the start of the text, a word typed in front stays out of the word after it"
    (let [tokens [(assoc (tok :s 0 3) :token/layer :s) (assoc (tok :tot 0 3) :token/layer :w)
                  (assoc (tok :z 0 0) :token/layer :z)]
          {:keys [tokens]} (body-edit "tot" "tat tot" tokens #{:s})]
      (is (= [4 7] ((juxt :token/begin :token/end) (first (filter #(= :tot (:token/id %)) tokens))))))))

;; ---------------------------------------------------------------------------
;; apply-text-edits applies ops that stand in order in one pass. It must give
;; what applying them one at a time gives, 400s included.

(def ^:private edit-alphabet ["a" "b" " " "é" (cps acute) (cps 0x10330) (cps 0x93E) "\n" "c"])

(defn- random-edit-case
  "A body, tokens over it (some zero-width) and ops of one of three kinds:
  edits in order made from old-body positions, ops anywhere in turn (some
  out of bounds or malformed), and what a whole-body update makes."
  [^java.util.Random r]
  (let [rstr (fn [n] (apply str (repeatedly n #(nth edit-alphabet (.nextInt r (count edit-alphabet))))))
        body (rstr (.nextInt r 40))
        n (cp/cp-count body)
        tokens (vec (for [i (range (.nextInt r 20))]
                      (let [b (.nextInt r (inc n))
                            e (if (< (.nextDouble r) 0.25) b (+ b (.nextInt r (inc (- n b)))))]
                        (tok i b e))))
        ops (case (.nextInt r 3)
              0 (loop [p 0 out []]
                  (if (or (>= p n) (< (.nextDouble r) 0.2))
                    (#'ta/edits->ops (cond-> out
                                       (< (.nextDouble r) 0.3) (conj {:kind :insert :at n :value (rstr (inc (.nextInt r 3)))})))
                    (let [s (+ p (.nextInt r (inc (min 4 (- n p)))))
                          len (.nextInt r (inc (min 4 (- n s))))
                          v (rstr (.nextInt r 4))
                          e (case (.nextInt r 3)
                              0 {:kind :insert :at s :value (if (= "" v) "a" v)}
                              1 {:kind :delete :start s :end (+ s len)}
                              2 {:kind :replace :start s :end (+ s len) :value v})]
                      (recur (or (:end e) (:at e)) (conj out e)))))
              1 (loop [len n i (.nextInt r 6) out []]
                  (if (zero? i)
                    out
                    (let [idx (.nextInt r (inc len))
                          l (.nextInt r (inc (- len idx)))
                          v (rstr (.nextInt r 4))
                          op (case (.nextInt r 4)
                               0 {:type :insert :index idx :value v}
                               1 {:type "delete" :index idx :value l}
                               2 {:type :replace :index idx :length l :value v}
                               3 (if (.nextBoolean r)
                                   {:type :delete :index idx :value (+ l 1 (- len idx))}
                                   {:type :bogus :index idx}))
                          d (case (:type op) :insert (cp/cp-count v) "delete" (- l) :replace (- (cp/cp-count v) l) 0)]
                      (recur (+ len d) (dec i) (conj out op)))))
              2 (let [new (rstr (.nextInt r 40))]
                  (-> (ta/diff body new)
                      (ta/slide-to-tokens body tokens)
                      (ta/normalize-deletes body tokens)
                      (ta/pair-replacements body tokens)
                      (ta/fold-whole-words body tokens))))]
    [body tokens ops]))

(defn- edit-outcome [f ops body tokens]
  (try (let [{:keys [text tokens deleted]} (f ops {:text/body body} tokens)]
         [:ok text (set tokens) (set deleted)])
       (catch clojure.lang.ExceptionInfo e [:refused (ex-message e) (ex-data e)])))

(deftest applying-edits-in-one-pass-gives-what-applying-them-in-turn-does
  (testing "a delete that closes the gap after a token, then a mark typed where the token now ends"
    (let [body (cps "ab cd" 0x10330 "e")
          tokens [(tok :ab 0 2) (tok :z 6 6)]
          ops [(ta/delete-op 2 4) (ta/insert-op 2 (cps acute))]]
      (is (= (edit-outcome #'ta/apply-text-edits-in-turn ops body tokens)
             (edit-outcome ta/apply-text-edits ops body tokens)))
      (is (= #{[:ab 0 3] [:z 3 3]} (extents (:tokens (ta/apply-text-edits ops {:text/body body} tokens)))))))
  (doseq [seed (range 1 11)]
    (let [r (java.util.Random. seed)]
      (dotimes [case-n 1000]
        (let [[body tokens ops] (random-edit-case r)]
          (is (= (edit-outcome #'ta/apply-text-edits-in-turn ops body tokens)
                 (edit-outcome ta/apply-text-edits ops body tokens))
              (str "seed " seed " case " case-n ": " (pr-str body) " " (pr-str ops))))))))

(deftest many-edits-over-a-long-text-apply-quickly
  ;; One edit per 50 words over 50,000 word tokens and 2,500 sentences.
  ;; Applying each op over the whole text and every token took 11.7 s here,
  ;; holding the write lock.
  (let [words (vec (take 50000 (cycle ["the" "cat" "sat" "ta" "tat" "at"])))
        old (str/join " " words)
        new (str/join " " (map-indexed (fn [i w] (if (zero? (mod i 50)) (str w "x") w)) words))
        tokens (word-tokens words)
        sentences (map-indexed (fn [i [b e]] (tok [:s i] b e))
                               (partition 2 1 (concat (take-nth 20 (map :token/begin tokens)) [(count old)])))
        all (into tokens sentences)
        ops (ta/diff old new)
        t0 (System/nanoTime)
        {:keys [text tokens deleted]} (ta/apply-text-edits ops {:text/body old} all)
        ms (/ (- (System/nanoTime) t0) 1e6)]
    (is (= 1000 (count ops)))
    (is (= new (:text/body text)))
    (is (= [] deleted))
    (is (= 52500 (count tokens)))
    (is (< ms 1000) (str ms " ms"))))
