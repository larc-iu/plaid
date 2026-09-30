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
  deletes, align each changed stretch by words, pair the deletes with their
  inserts, fold a word replaced outright, apply, and move token edges off
  spaces they did not stand on.
  `partitioning` is the set of layers that are partitions."
  ([old new tokens] (body-edit old new tokens #{}))
  ([old new tokens partitioning]
   (-> (ta/diff old new)
       (ta/slide-to-tokens old tokens partitioning)
       (ta/normalize-deletes old tokens)
       (ta/align-to-words old tokens)
       (ta/pair-replacements old tokens)
       (ta/fold-whole-words old tokens)
       (apply-all old tokens)
       (as-> r (ta/keep-edges-off-spaces old tokens r partitioning))))
  ;; `word-layers` is the set of layers that hold words
  ([old new tokens partitioning word-layers]
   (-> (ta/diff old new)
       (ta/slide-to-tokens old tokens partitioning)
       (ta/normalize-deletes old tokens)
       (ta/align-to-words old tokens word-layers)
       (ta/pair-replacements old tokens)
       (ta/fold-whole-words old tokens word-layers)
       (apply-all old tokens)
       (as-> r (ta/keep-edges-off-spaces old tokens r partitioning)))))

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
  (testing "a replace from inside one word into another makes one word, on the one sharing more letters"
    (let [{:keys [tokens deleted]} (body-edit "x cat dog y" "x cQog y"
                                              [(tok :cat 2 5) (tok :dog 6 9)])]
      (is (= [:cat] deleted))
      (is (= #{[:dog 2 6]} (extents tokens))))))

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
  (testing "in a script without spaces, only a token of a word layer holds morphemes"
    ;; A sentence with no line break after it, or a UMR node over neighbouring
    ;; words, has no space in it, and two words meeting inside it read as two
    ;; morphemes of one word. The replace was not cut and the word respelled
    ;; at its start lost its new letter. The layers say which is a word: one
    ;; that forbids overlap, is not a partition and has a parent, which
    ;; update-body works out.
    (let [on (fn [layer t] (assoc t :token/layer layer))]
      (doseq [[old new tokens want]
              [["tatuabשלוםthe" "Zbשלוםthe"
                [(on :s (tok :s1 0 13)) (on :w (tok :tatu 0 4)) (on :w (tok :ab 4 6))
                 (on :w (tok :shalom 6 10)) (on :w (tok :the 10 13))]
                #{[:ab 0 2] [:shalom 2 6] [:the 6 9]}]
               ["你好世界" "大界"
                [(on :s (tok :s1 0 4)) (on :w (tok :nihao 0 2)) (on :w (tok :shijie 2 4))]
                #{[:shijie 0 2]}]
               ["你好世界再见\n" "大界再见\n"
                [(on :s (tok :s1 0 7)) (on :w (tok :nihao 0 2)) (on :w (tok :shijie 2 4))
                 (on :w (tok :zaijian 4 6)) (on :u (tok :node 0 4))]
                #{[:shijie 0 2] [:zaijian 2 4]}]
               ;; cut at the node's end, `mat` is replaced by a space alone,
               ;; and a word is not kept on a space
               ["你好。cafématYarın" "你好。QX Yarın"
                [(on :s (tok :s1 0 15)) (on :w (tok :nihao 0 2)) (on :w (tok :cafe 3 7))
                 (on :w (tok :mat 7 10)) (on :w (tok :yarin 10 15)) (on :u (tok :node 0 7))]
                #{[:nihao 0 2] [:cafe 3 5] [:yarin 6 11]}]
               ;; a morpheme edge inside a word stays uncut
               ["你好世界\n" "大界\n"
                [(on :s (tok :s1 0 5)) (on :w (tok :nihao 0 2)) (on :w (tok :shijie 2 4))
                 (on :m (tok :shi 2 3)) (on :m (tok :jie 3 4))]
                #{[:shijie 0 2]}]]]
        (let [{:keys [text tokens]} (body-edit old new tokens #{:s} #{:w})]
          (is (= new (:text/body text)))
          (is (= want (extents (filter (comp #{:w} :token/layer) tokens))) (str (pr-str old) " -> " (pr-str new)))))))
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

(deftest a-token-is-left-on-no-space-a-delete-gave-it
  ;; Deleting the words between two UMR nodes over several words, one ending
  ;; on them and one beginning on them, has no place that keeps both off the
  ;; space between: taking the space before moves the second node's start
  ;; onto it, taking the one after moves the first node's end. The same
  ;; when the separators either side differ, when a respelled word stands
  ;; beside, or when a deleted word's marker holds the delete in place.
  (let [on (fn [layer t] (assoc t :token/layer layer))
        w (fn [id b e] (on :w (tok id b e)))]
    (doseq [[old new tokens want]
            [["mat\ttat\tcat" "mat\tcat"
              [(w :mat 0 3) (w :tat 4 7) (w :cat 8 11)
               (on :u (tok :n1 0 7)) (on :u (tok :n2 4 11))]
              {:n1 "mat" :n2 "cat"}]
             ["a\tköye kai ab\ta" "a\ta"
              [(w :a 0 1) (w :köye 2 6) (w :kai 7 10) (w :ab 11 13) (w :a2 14 15)
               (on :u (tok :n1 0 6)) (on :u (tok :n2 11 15))]
              {:n1 "a" :n2 "a"}]
             ;; two different separators either side of the deleted word
             ["ab  sat\tcat" "ab  cat"
              [(w :ab 0 2) (w :sat 4 7) (w :cat 8 11) (on :u (tok :n1 0 7))]
              {:n1 "ab"}]
             ;; a word respelled beside the deleted ones
             ["tat Yarın mat on" "tڤZ on"
              [(w :tat 0 3) (w :yarin 4 9) (w :mat 10 13) (w :on 14 16) (on :u (tok :n1 10 16))]
              {:n1 "on"}]
             ;; a marker at the deleted word's end, which a delete through it
             ;; would take
             ["köye cat كتاب" "köye كتاب"
              [(w :köye 0 4) (w :cat 5 8) (w :kitab 9 13) (on :z (tok :z 8 8)) (on :u (tok :n1 5 13))]
              {:n1 "كتاب"}]]]
      (let [{:keys [text tokens]} (body-edit old new tokens)
            body (:text/body text)
            read (into {} (map (fn [{:token/keys [id begin end]}] [id (cp/cp-subs body begin end)])) tokens)]
        (is (= new body))
        (is (= want (select-keys read (keys want))) (str (pr-str old) " -> " (pr-str new)))))))

(deftest a-token-is-moved-off-a-space-only-when-it-did-not-stand-on-one
  (let [old "ab cd ef"
        on (fn [layer t] (assoc t :token/layer layer))
        ;; as if `cd` were deleted and every token left where it is below
        result {:text {:text/body "ab  ef"}
                :tokens [(on :s (tok :s 0 6)) (on :u (tok :n 2 6)) (on :u (tok :blank 2 4))
                         (on :u (tok :spaced 2 6))]}
        tokens [(on :s (tok :s 0 8)) (on :u (tok :n 3 8)) (on :u (tok :blank 3 5))
                (on :u (tok :spaced 2 8))]]
    (is (= {:s [0 6] :n [4 6] :blank [2 4] :spaced [2 6]}
           (into {} (map (juxt :token/id (juxt :token/begin :token/end)))
                 (:tokens (ta/keep-edges-off-spaces old tokens result #{:s})))))))

(deftest a-token-over-its-whole-sentence-keeps-the-sentence-edge-a-space-is-on
  ;; A UMR node aligned to no word stands over the whole of its sentence.
  ;; Deleting the sentence's last word so that a space ends it, or its first
  ;; word so that a space begins it, leaves the sentence on that space, and
  ;; the node stays over the whole sentence with it rather than coming off
  ;; it (the app would put it back over the sentence on the next open).
  (let [on (fn [layer t] (assoc t :token/layer layer))
        w (fn [id b e] (on :w (tok id b e)))]
    (doseq [[old new tokens]
            [["a b.\nThe cat dog" "a b.\nThe cat "
              [(on :s (tok :s1 0 5)) (on :s (tok :s2 5 16)) (w :the 5 8) (w :cat 9 12) (w :dog 13 16)
               (on :u (tok :n 5 16))]]
             ["a b.\ncat dog.\n" "a b.\n dog.\n"
              [(on :s (tok :s1 0 5)) (on :s (tok :s2 5 14)) (w :cat 5 8) (w :dog 9 13)
               (on :u (tok :n 5 14))]]
             ["cat dog" "cat "
              [(on :s (tok :s1 0 7)) (w :cat 0 3) (w :dog 4 7) (on :u (tok :n 0 7))]]]]
      (let [{:keys [text tokens]} (body-edit old new tokens #{:s})
            at (into {} (map (juxt :token/id (juxt :token/begin :token/end))) tokens)]
        (is (= new (:text/body text)))
        (is (= (at :s2 (at :s1)) (at :n)) (str (pr-str old) " -> " (pr-str new)))))))

(deftest a-word-deleted-between-words-without-spaces-leaves-the-next-one-whole
  ;; Without spaces, deleting a word whose first letter is also the next
  ;; one's could stand where it cuts the next word and takes its first
  ;; morpheme whole, which disturbs as many tokens as deleting the word
  ;; itself does (that one changes the letter before the next word and its
  ;; morpheme). The place that cuts fewer wins.
  (let [on (fn [layer t] (assoc t :token/layer layer))
        w (fn [id b e] (on :w (tok id b e)))
        m (fn [id b e] (on :m (tok id b e)))]
    (doseq [[old new tokens want]
            [["tatuthe\n" "the\n"
              [(on :s (tok :s 0 8)) (w :tatu 0 4) (w :the 4 7) (m :t 4 5) (m :he 5 7)]
              {:the "the" :t "t" :he "he"}]
             ["aab\n" "ab\n"
              [(on :s (tok :s 0 4)) (w :a 0 1) (w :ab 1 3) (m :a1 1 2) (m :b 2 3)]
              {:ab "ab" :a1 "a" :b "b"}]
             ["caféathekakiab\n" "caféab\n"
              [(on :s (tok :s 0 15)) (w :café 0 4) (w :a 4 5) (w :the 5 8) (w :kaki 8 12) (w :ab 12 14)
               (m :a1 12 13) (m :b 13 14)]
              {:café "café" :ab "ab" :a1 "a" :b "b"}]]]
      (let [{:keys [text tokens]} (body-edit old new tokens #{:s})
            body (:text/body text)
            read (into {} (map (fn [{:token/keys [id begin end]}] [id (cp/cp-subs body begin end)])) tokens)]
        (is (= new body))
        (is (= want (select-keys read (keys want))) (str (pr-str old) " -> " (pr-str new)))))))

(deftest a-word-respelled-beside-deleted-words-keeps-its-letters-from-itself
  ;; The diff may keep a respelled word's letters from a deleted word beside
  ;; it, or from another place in the word: `tat the` to `tZe` kept the `t`
  ;; of `tat` and the `e` of `the`, which left a token on each. Each word left
  ;; is to be one token on its new spelling.
  (let [on (fn [layer t] (assoc t :token/layer layer))
        w (fn [id b e] (on :w (tok id b e)))
        m (fn [id b e] (on :m (tok id b e)))]
    (doseq [[old new tokens want gone either]
            [;; one replace reaching into both words: the one sharing more
             ;; letters with the new word takes it
             ["cat tat the\n" "cat tZe\n"
              [(on :s (tok :s 0 12)) (w :cat 0 3) (w :tat 4 7) (m :t 4 5) (m :at 5 7) (w :the 8 11)
               (on :u (tok :node 4 7))]
              {:cat "cat" :the "tZe"} #{:tat :t :at :node}]
             ["sat mat köye" "sQt köye"
              [(w :sat 0 3) (w :mat 4 7) (w :köye 8 12)]
              {:sat "sQt" :köye "köye"} #{:mat}]
             ;; letters typed before a word, and some of its own deleted
             ["on kaki é\n" "on QЖki\n"
              [(on :s (tok :s 0 10)) (w :on 0 2) (w :kaki 3 7) (m :ka 3 5) (m :k 5 6) (m :i 6 7) (w :é 8 9)]
              {:on "on" :kaki "QЖki"} #{:é}]
             ;; the kept `t` is the last of `tat`, not its first
             ["كتاب tat on mat" "كتاب Zڤt mat"
              [(w :kitab 0 4) (w :tat 5 8) (m :t 5 6) (m :at 6 8) (w :on 9 11) (w :mat 12 15)]
              {:kitab "كتاب" :tat "Zڤt" :mat "mat"} #{:on}]
             ;; a delete beside another that moved away may take its place
             ["köye tat\nkaki 你好 你好 tat the\n" "köye tat\nkaki 你好 thXQ\n"
              [(on :s (tok :s0 0 9)) (on :s (tok :s1 9 28)) (w :köye 0 4) (w :tat 5 8) (w :kaki 9 13)
               (w :nihao 14 16) (w :nihao2 17 19) (m :ni 17 18) (m :hao 18 19) (w :tat2 20 23) (w :the 24 27)
               (on :u (tok :n1 17 19)) (on :u (tok :n2 24 27)) (on :u (tok :n3 17 27))]
              ;; which `你好` is left the text cannot say
              {:the "thXQ"} #{:tat2} #{:nihao :nihao2}]
              ;; and before letters typed at a word's end: the kept `t` is the
              ;; first of `tat`, not its last
             ["kaki köye é كتاب tat\n" "kaki köye ڤ tڤ𐍂\n"
              [(on :s (tok :s 0 21)) (w :kaki 0 4) (w :köye 5 9) (w :é 10 11) (on :z (tok :z 11 11))
               (w :kitab 12 16) (on :z (tok :z2 12 12)) (w :tat 17 20) (m :ta 17 19) (m :t 19 20)
               (on :u (tok :node 12 20))]
              {:kaki "kaki" :köye "köye" :é "ڤ" :tat "tڤ𐍂"} #{:kitab}]]]
      (let [{:keys [text tokens]} (body-edit old new tokens #{:s} #{:w})
            body (:text/body text)
            read (into {} (map (fn [{:token/keys [id begin end]}] [id (cp/cp-subs body begin end)])) tokens)]
        (is (= new body))
        (is (= want (select-keys read (keys want))) (str (pr-str old) " -> " (pr-str new)))
        (is (not-any? gone (keys read)) (str (pr-str old) " -> " (pr-str new) " " (pr-str read)))
        (when either
          (is (= ["你好"] (vals (select-keys read either))) (pr-str read)))))))

(deftest a-word-respelled-beside-a-deleted-word-keeps-its-edge-letter-from-itself
  ;; The respelled word's letter beside the deleted words is also in a
  ;; deleted word, and the diff kept it from there: `sat tat` to `tX` kept
  ;; the `t` of `sat`, which left `sat` on `t` and `X` in no word. Each
  ;; changed stretch is aligned word by word instead.
  (let [on (fn [layer t] (assoc t :token/layer layer))
        w (fn [id b e] (on :w (tok id b e)))]
    (doseq [[old new tokens want gone at]
            [["كتاب sat tat\n" "كتاب tX\n"
              [(on :s (tok :s 0 13)) (w :kitab 0 4) (w :sat 5 8) (w :tat 9 12)]
              {:kitab "كتاب" :tat "tX"} #{:sat}]
             ["the a ab" "the aX"
              [(w :the 0 3) (w :a 4 5) (w :ab 6 8)]
              {:the "the" :ab "aX"} #{:a}]
             ;; the marker at the start of `ab` stays at the start of `aXQ`
             ["שלום kai ab tat\n" "שלום aXQ tat\n"
              [(on :s (tok :s 0 16)) (w :shalom 0 4) (w :kai 5 8) (w :ab 9 11) (on :z (tok :z 9 9))
               (w :tat 12 15)]
              {:ab "aXQ" :tat "tat"} #{:kai} {:z 5}]
             ;; the new word is one, so `é` goes and `café` takes it
             ["café é köye on" "caЖé köye on"
              [(w :café 0 4) (w :é 5 6) (w :köye 7 11) (w :on 12 14)]
              {:café "caЖé" :köye "köye"} #{:é}]
             ;; without spaces: no word is kept by the middle of its letters
             ["thesattatutheYarın" "taЖtheYarın"
              [(w :the 0 3) (w :sat 3 6) (w :tatu 6 10) (w :the2 10 13) (w :yarin 13 18)]
              {:tatu "taЖ" :the2 "the" :yarin "Yarın"} #{:the :sat}]
             ["atheYarıntatu\n" "atatЖ\n"
              [(on :s (tok :s 0 14)) (w :a 0 1) (w :the 1 4) (w :yarin 4 9) (w :tatu 9 13)]
              {:a "a" :tatu "tatЖ"} #{:the :yarin}]]]
      (let [{:keys [text tokens]} (body-edit old new tokens #{:s} #{:w})
            body (:text/body text)
            read (into {} (map (fn [{:token/keys [id begin end]}] [id (cp/cp-subs body begin end)])) tokens)
            begins (into {} (map (juxt :token/id :token/begin)) tokens)]
        (is (= new body))
        (is (= want (select-keys read (keys want))) (str (pr-str old) " -> " (pr-str new) " " (pr-str read)))
        (is (not-any? gone (keys read)) (str (pr-str old) " -> " (pr-str new) " " (pr-str read)))
        (when at
          (is (= at (select-keys begins (keys at))) (pr-str begins)))))))

(deftest word-alignment-leaves-the-diff-where-it-is-as-good
  ;; A respelling inside a word, a word typed, and a word deleted are left as
  ;; the diff gave them, and so is a stretch the text leaves open: `ab` twice
  ;; in a script without spaces, one of them deleted.
  (let [w (fn [id b e] (assoc (tok id b e) :token/layer :w))]
    (doseq [[old new tokens]
            [["cat dog" "cat dXg" [(w :cat 0 3) (w :dog 4 7)]]
             ["cat dog" "cat new dog" [(w :cat 0 3) (w :dog 4 7)]]
             ["the cat cow" "the cow" [(w :the 0 3) (w :cat 4 7) (w :cow 8 11)]]
             ["ababacafé" "abaڤڤ" [(w :ab 0 2) (w :ab2 2 4) (w :a 4 5) (w :café 5 9)]]]]
      (let [ops (-> (ta/diff old new)
                    (ta/slide-to-tokens old tokens)
                    (ta/normalize-deletes old tokens))]
        (is (identical? ops (ta/align-to-words ops old tokens #{:w})) (str (pr-str old) " -> " (pr-str new)))))))

(deftest word-alignment-types-no-line-break-inside-a-kept-word
  ;; A word typed at the end of one line and the first word of the next
  ;; respelled, in one save. Deleting the line break and typing "oo\nw"
  ;; between the `t` and the `hen` of `then` is as short, and deletes no
  ;; letter of `then`, but it put `then` and its morpheme over "too\nwhen"
  ;; and moved the sentence break in front of "too".
  (let [on (fn [layer t] (assoc t :token/layer layer))
        w (fn [id b e] (on :w (tok id b e)))]
    (doseq [[old new tokens want]
            [["I saw it\nthen we left\n" "I saw it too\nwhen we left\n"
              [(on :s (tok :s1 0 9)) (on :s (tok :s2 9 22))
               (w :i 0 1) (w :saw 2 5) (w :it 6 8) (w :then 9 13) (w :we 14 16) (w :left 17 21)
               (on :m (tok :th 9 11)) (on :m (tok :en 11 13))]
              {:s1 "I saw it too\n" :s2 "when we left\n" :then "when" :th "wh" :en "en" :it "it"}]
             ["the dog\ntold me\n" "the dog to\nsold me\n"
              [(on :s (tok :s1 0 8)) (on :s (tok :s2 8 16))
               (w :the 0 3) (w :dog 4 7) (w :told 8 12) (w :me 13 15)]
              {:s1 "the dog to\n" :s2 "sold me\n" :told "sold" :dog "dog"}]]]
      (let [{:keys [text tokens]} (body-edit old new tokens #{:s} #{:w :m})
            body (:text/body text)
            read (into {} (map (fn [{:token/keys [id begin end]}] [id (cp/cp-subs body begin end)])) tokens)]
        (is (= new body))
        (is (= want (select-keys read (keys want))) (str (pr-str old) " -> " (pr-str new) " " (pr-str read)))))))

(deftest word-alignment-leaves-no-letter-typed-before-punctuation-outside-a-word
  ;; Words deleted and the next word respelled at its end, before the
  ;; punctuation after it. Keeping `a` and typing `e` after it is as short as
  ;; the diff, which kept the `a` of `cat` and left `ae` on its token, but the
  ;; `e` then stood between `a` and `!` in no word's token.
  (let [w (fn [id b e] (assoc (tok id b e) :token/layer :w))]
    (doseq [[old new tokens]
            [["cat é a! ab." "ae! ab." [(w :cat 0 3) (w :é 4 5) (w :a 6 7) (w :ab 9 11)]]
             ["sat é a,\ncafé the." "aX,\ncafé the." [(w :sat 0 3) (w :é 4 5) (w :a 6 7) (w :café 9 13) (w :the 14 17)]]
             ["so tea a! ok" "so ae! ok" [(w :so 0 2) (w :tea 3 6) (w :a 7 8) (w :ok 10 12)]]]]
      (let [{:keys [text tokens]} (body-edit old new tokens #{} #{:w})
            body (:text/body text)
            held (fn [i] (some (fn [{:token/keys [begin end]}] (<= begin i (dec end))) tokens))
            letters (filter #(Character/isLetter (int (.codePointAt ^String body (.offsetByCodePoints ^String body 0 (int %)))))
                            (range (cp/cp-count body)))]
        (is (= new body))
        (is (every? held letters)
            (str (pr-str old) " -> " (pr-str new) " "
                 (pr-str (map (fn [{:token/keys [id begin end]}] [id (cp/cp-subs body begin end)]) tokens))))))))

(deftest word-alignment-leaves-no-letter-typed-between-two-words-without-a-space-outside-a-word
  ;; In a script without spaces, a word respelled beside a deleted one. The
  ;; diff kept a letter from the respelled word's middle, and the fold put
  ;; the word on its new spelling. Keeping it by its first letter instead
  ;; (fewer words kept by their middle alone) is as short, but typed the
  ;; other new letters between two words, where no token takes them: `kai`
  ;; was left on `k` of `aek` and `ae` in no word.
  (let [w (fn [id b e] (assoc (tok id b e) :token/layer :w))]
    (doseq [[old new tokens]
            [["thekaitatdogcafé" "theaekdogcafé"
              [(w :the 0 3) (w :kai 3 6) (w :tat 6 9) (w :dog 9 12) (w :café 12 16)]]
             ["caféYarınaكتابa\n" "caféYarınاaka\n"
              [(w :café 0 4) (w :Yarın 4 9) (w :a 9 10) (w :kitab 10 14) (w :a2 14 15)]]]]
      (let [{:keys [text tokens]} (body-edit old new tokens #{} #{:w})
            body (:text/body text)
            held (fn [i] (some (fn [{:token/keys [begin end]}] (<= begin i (dec end))) tokens))
            letters (filter #(Character/isLetter (int (.codePointAt ^String body (.offsetByCodePoints ^String body 0 (int %)))))
                            (range (cp/cp-count body)))]
        (is (= new body))
        (is (every? held letters)
            (str (pr-str old) " -> " (pr-str new) " "
                 (pr-str (map (fn [{:token/keys [id begin end]}] [id (cp/cp-subs body begin end)]) tokens))))))))

(deftest word-alignment-takes-a-combining-mark-typed-after-a-word-as-that-words
  ;; In a script without spaces, a word deleted and the next one respelled
  ;; with a combining mark after its last letter (`ña` to `ä`, written `a`
  ;; and U+0308). The mark joins the letter before it, so it is no letter
  ;; typed between two words, and the alignment keeping `ña`'s `a` stands:
  ;; counted as one, it left the diff's reading, which kept `kaki` by its
  ;; middle `a` and took the `a` of `áb` for it, so `áb` read a lone accent
  ;; and `b`.
  (let [w (fn [id b e] (assoc (tok id b e) :token/layer :w))
        m (fn [id b e] (assoc (tok id b e) :token/layer :m))
        old "caf\u00e9kakin\u0303aa\u0301b\n\ud800\udf30kai\n"
        new "caf\u00e9a\u0308a\u0301b\nkai\n"
        tokens [(w :cafe 0 4) (w :kaki 4 8) (w :na 8 11) (w :ab 11 14) (w :goth 15 16) (w :kai 16 19)
                (m :na-1 8 10) (m :na-2 10 11)]
        {:keys [text tokens]} (body-edit old new tokens #{} #{:w})
        body (:text/body text)
        read (into {} (map (fn [{:token/keys [id begin end]}] [id (cp/cp-subs body begin end)])) tokens)]
    (is (= new body))
    (is (= {:cafe "caf\u00e9" :na "a\u0308" :ab "a\u0301b" :kai "kai" :na-2 "a\u0308"} read))))

(deftest word-alignment-of-one-long-stretch-is-quick
  ;; A body replaced outright (select all and paste, or a diff that gave up)
  ;; is one delete over every word. It is longer than the aligner looks, so
  ;; the ops come back as they are, and finding its window must not compare
  ;; every word token with every other: with 10,000 words that took
  ;; seconds under the write lock.
  (let [n 10000
        old (str/join " " (repeat n "abc"))
        tokens (mapv (fn [i] (assoc (tok i (* 4 i) (+ 3 (* 4 i))) :token/layer :w)) (range n))
        ops [(ta/delete-op 0 (cp/cp-count old)) (ta/insert-op 0 "xyz")]
        t0 (System/nanoTime)
        out (ta/align-to-words ops old tokens #{:w})
        ms (/ (- (System/nanoTime) t0) 1e6)]
    (is (= ops out))
    (is (< ms 1500) (str "took " ms " ms"))))

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

;; ---------------------------------------------------------------------------
;; A save that changes every word of a long text. Editscript gave up after
;; 1,000 ms and returned the new text whole, and the save then deleted every
;; token, with its spans, relations and vocabulary links: from about 2,000
;; words when every word changed, sooner on a busy server.

(defn- long-text
  "`n` words in sentences of 15, each sentence ending in a period and `sep`,
  and the same text with `f` applied to every word. Tokens: a sentence over
  each sentence and its `sep` (a partition), a word, two morphemes (the first
  letter and the rest), and the period. Returns the old and new bodies, the
  tokens, and what each token should read in the new body."
  [n sep f]
  (let [vocab ["the" "cat" "sat" "on" "a" "mat" "with" "tat" "kaki" "dog"
               "told" "me" "then" "we" "left" "at" "noon" "ab" "é" "to"]
        ob (StringBuilder.) nb (StringBuilder.)
        len (fn [^StringBuilder sb] (cp/cp-count (str sb)))]
    (loop [i 0 s-start [0 0] toks [] expect {}]
      (if (= i n)
        {:old (str ob) :new (str nb) :tokens toks :expect expect}
        (let [w (nth vocab (mod (* 7 i) (count vocab)))
              w' (f w)
              ob0 (len ob)
              _ (do (.append ob ^String w) (.append nb ^String w'))
              k (cp/cp-count w) k' (cp/cp-count w')
              toks (-> toks
                       (conj (assoc (tok [:w i] ob0 (+ ob0 k)) :token/layer :w))
                       (conj (assoc (tok [:m i 0] ob0 (inc ob0)) :token/layer :m))
                       (cond-> (< 1 k) (conj (assoc (tok [:m i 1] (inc ob0) (+ ob0 k)) :token/layer :m))))
              expect (-> expect
                         (assoc [:w i] w' [:m i 0] (cp/cp-subs w' 0 1))
                         (cond-> (< 1 k) (assoc [:m i 1] (cp/cp-subs w' 1 k'))))
              end? (or (= 14 (mod i 15)) (= i (dec n)))]
          (if end?
            (let [p (len ob) p' (len nb)
                  _ (do (.append ob ".") (.append ob ^String sep)
                        (.append nb ".") (.append nb ^String sep))
                  s (quot i 15)
                  [sb sb'] s-start]
              (recur (inc i) [(len ob) (len nb)]
                     (-> toks
                         (conj (assoc (tok [:p s] p (inc p)) :token/layer :p))
                         (conj (assoc (tok [:s s] sb (len ob)) :token/layer :s)))
                     (assoc expect [:p s] "." [:s s] (subs (str nb) (.offsetByCodePoints (str nb) 0 sb') (.length nb)))))
            (do (.append ob " ") (.append nb " ")
                (recur (inc i) s-start toks expect))))))))

(defn- slow-clock
  "A clock for editscript that moves 10 s at every look, as a loaded server's
  might between two looks."
  []
  (let [t (atom 0)]
    (fn ^long [] (swap! t + 10000))))

(deftest a-save-changing-every-word-of-a-long-text-keeps-every-token
  (doseq [sep ["\n" " "]]
    (testing (str "sentences separated by " (pr-str sep))
      (let [{:keys [old new tokens expect]} (long-text 3000 sep str/capitalize)
            {:keys [text tokens deleted]}
            (with-redefs [editscript.util.common/current-time (slow-clock)]
              (body-edit old new tokens #{:s} #{:w :m}))
            body (:text/body text)]
        (is (= new body))
        (is (= [] deleted))
        (is (= (count expect) (count tokens)))
        (is (= [] (for [{:token/keys [id begin end]} tokens
                        :let [reads (cp/cp-subs body begin end)]
                        :when (not= (expect id) reads)]
                    [id (expect id) reads])))))))

(deftest the-diff-never-depends-on-the-clock
  ;; The same save with editscript's clock moving 10 s at every look gives the
  ;; same ops as with the real clock, and never a delete over the whole body.
  (doseq [[old new] [["the cat sat" "the cats sat"]
                     ["I saw it\nthen we left\n" "I saw it too\nwhen we left\n"]
                     (let [{:keys [old new]} (long-text 600 "\n" str/capitalize)] [old new])
                     (let [{:keys [old new]} (long-text 600 " " str/capitalize)] [old new])]]
    (let [ops (ta/diff old new)
          slow (with-redefs [editscript.util.common/current-time (slow-clock)] (ta/diff old new))]
      (is (= ops slow))
      (is (= new (:text/body (:text (apply-all ops old [])))))
      (is (not-any? #(and (= :delete (:type %)) (= (cp/cp-count old) (:value %))) ops)))))

(deftest a-long-diff-reconstructs-the-new-body
  ;; Past `hunk-limit` a stretch is split by lines, then words, then diffed
  ;; by characters with a bounded search. Whatever it splits, the ops must
  ;; give the new body back, astral letters included.
  (let [r (java.util.Random. 11)
        alphabet ["a" "b" "t" " " " " "\n" "é" "𐍂" "\t" "的"]
        rstr (fn [n] (apply str (repeatedly n #(nth alphabet (.nextInt r (count alphabet))))))
        mutate (fn [s] (apply str (mapcat (fn [c] (case (.nextInt r 12) 0 [] 1 [(str c) (rstr 2)] 2 [(rstr 1)] [(str c)]))
                                          (map #(String. (Character/toChars (int %))) (.toArray (.codePoints ^String s))))))]
    (doseq [limit [0 4 30 1000]]
      (with-redefs [ta/hunk-limit limit]
        (dotimes [i 400]
          (let [old (rstr (.nextInt r 200))
                new (if (even? i) (mutate old) (rstr (.nextInt r 200)))
                ops (ta/diff old new)]
            (is (= new (:text/body (:text (apply-all ops old [])))) (str limit " " (pr-str old) " -> " (pr-str new)))))))))

(deftest the-banded-alignment-keeps-a-common-subsequence
  ;; The last resort when the line or word diff would search too long. With a
  ;; band as narrow as it gets, what it keeps must still be equal elements in
  ;; order, and with room enough it keeps a longest common subsequence.
  (let [r (java.util.Random. 5)
        lcs (fn [a b]
              (let [m (count b)]
                (last (reduce (fn [prev x]
                                (reduce (fn [row j]
                                          (conj row (if (= x (nth b (dec j)))
                                                      (inc (nth prev (dec j)))
                                                      (max (nth prev j) (peek row)))))
                                        [0] (range 1 (inc m))))
                              (vec (repeat (inc m) 0)) a))))]
    (dotimes [_ 300]
      (let [a (vec (repeatedly (inc (.nextInt r 40)) #(.nextInt r 3)))
            b (vec (repeatedly (inc (.nextInt r 40)) #(.nextInt r 3)))]
        (doseq [cells [1 200000]]
          (with-redefs [ta/band-cells cells]
            (let [[ma mb] (map vec (#'ta/band-matches (int-array a) (int-array b)))]
              (is (= (count ma) (count mb)))
              (is (every? true? (map #(= (a %1) (b %2)) ma mb)))
              (is (apply < -1 ma))
              (is (apply < -1 mb))
              (when (= cells 200000)
                (is (= (lcs a b) (count ma)) (pr-str a b))))))))))

(deftest a-line-retyped-almost-whole-keeps-the-text-it-was-given
  ;; A line retyped almost whole. A replace joining two words took letters
  ;; the next edit took too, and the fold then threw (the save answered 500)
  ;; or gave a text nobody typed (`for banister` came out `forUnveistbr`,
  ;; and the save stored it). The diff of a long text rewritten throughout
  ;; reaches this now, where it used to give up and replace the whole body.
  (doseq [[old new tokens]
          [["Promoter brewers unbranded it she caddies venomous is palliates his he.\n"
            "Was as footprint wrongfully sage debates by hillbilly, printings of and.\n"
            [(assoc (tok :addies 35 41) :token/layer :m)
             (assoc (tok :veno 42 46) :token/layer :m)
             (assoc (tok :segment 0 71) :token/layer :a)]]
           ["Unveiling sensitize the gawks at, in he as.\n"
            "That for banister admire on for her adv guaranty on of mambos statute was.\n"
            (into [(assoc (tok :s 0 44) :token/layer :s)
                   (assoc (tok :node 10 19) :token/layer :u)]
                  (for [[layer extents] {:w [[0 9] [10 19] [20 23] [24 29] [30 32] [34 36] [37 39] [40 42]]
                                         :m [[0 4] [4 9] [10 15] [15 19] [20 23] [24 26] [26 29]
                                             [30 32] [34 36] [37 39] [40 42]]}
                        [b e] extents]
                    (assoc (tok [layer b] b e) :token/layer layer)))]]]
    (is (= new (:text/body (:text (body-edit old new tokens #{:s} #{:w :m})))) (pr-str old))))

;; ---------------------------------------------------------------------------
;; normalize-deletes counts the tokens cut near each pair of deletes, where it
;; counted every token. This is the version that counted every token, to pin
;; that the two choose alike.

(defn- normalize-deletes-counting-every-token [ops old tokens]
  (let [edits (#'ta/ops->edits ops)
        near (#'ta/tokens-near tokens (count edits))
        cut-count (fn [ranges]
                    (count (filter (fn [{:token/keys [begin end]}]
                                     (and (< begin end)
                                          (some (fn [[s e]]
                                                  (and (< s end) (> e begin)
                                                       (not (and (<= s begin) (<= end e)))))
                                                ranges)))
                                   tokens)))
        ranges-of (fn [edits] (keep #(when (= (:kind %) :delete) [(:start %) (:end %)]) edits))
        cp-sub (fn [s e] (cp/cp-subs old s e))
        step (fn [edits]
               (let [v (vec edits)]
                 (loop [i 0]
                   (when (< (inc i) (count v))
                     (let [a (v i) b (v (inc i))]
                       (if (and (= (:kind a) :delete) (= (:kind b) :delete) (< (:end a) (:start b)))
                         (let [m (- (:start b) (:end a))
                               k (cp-sub (:end a) (:start b))
                               candidates (cond-> []
                                            (and (<= m (- (:end b) (:start b)))
                                                 (= k (cp-sub (- (:end b) m) (:end b))))
                                            (conj {:kind :delete :start (:start a) :end (- (:end b) m)})
                                            (and (<= m (- (:end a) (:start a)))
                                                 (= k (cp-sub (:start a) (+ (:start a) m))))
                                            (conj {:kind :delete :start (+ (:start a) m) :end (:end b)}))
                               before (cut-count (ranges-of v))
                               best (->> candidates
                                         (map (fn [c] [(cut-count (ranges-of (assoc v i c (inc i) nil))) c]))
                                         (filter (fn [[n _]] (< n before)))
                                         (sort-by first)
                                         first)]
                           (if best
                             (into (subvec v 0 i) (into [(second best)] (subvec v (+ i 2))))
                             (recur (inc i))))
                         (recur (inc i))))))))]
    (loop [edits edits merged? false]
      (if-let [next (step edits)]
        (recur (vec (remove nil? next)) true)
        (let [joined (#'ta/join-at-token-edges (.toArray (.codePoints ^String old)) near (vec edits))]
          (if (or merged? (not= joined edits)) (#'ta/edits->ops joined) ops))))))

(deftest normalize-deletes-counting-near-tokens-chooses-as-counting-all
  ;; Short words from few letters, so a kept run often repeats the edge of a
  ;; delete beside it, with words, morphemes, zero-width markers and tokens
  ;; over several words, and more than 16 edits often enough that the
  ;; tokens are looked up by position.
  (let [r (java.util.Random. 17)
        words ["a" "t" "at" "ta" "tat" "att" "aa" "é" "𐍂a"]
        seps [" " " " "" "\n"]
        diverged (atom [])]
    (dotimes [case-n 3000]
      (let [n (+ 2 (.nextInt r 30))
            ws (vec (repeatedly n #(nth words (.nextInt r (count words)))))
            body-of (fn [ws] (apply str (interleave ws (repeatedly #(nth seps (.nextInt r (count seps)))))))
            old (body-of ws)
            len (cp/cp-count old)
            tokens (vec (for [i (range (.nextInt r 40))]
                          (let [b (.nextInt r (inc len))
                                e (if (< (.nextDouble r) 0.15) b (min len (+ b (.nextInt r 6))))]
                            (tok i b e))))
            new (body-of (vec (keep #(case (.nextInt r 4) 0 nil 1 (str % (nth words (.nextInt r (count words)))) %) ws)))
            ops (ta/slide-to-tokens (ta/diff old new) old tokens)]
        (when (not= (normalize-deletes-counting-every-token ops old tokens)
                    (ta/normalize-deletes ops old tokens))
          (swap! diverged conj [case-n old new]))))
    (is (= [] (take 5 @diverged)))))

(deftest the-text-ops-make-is-the-text-applying-them-makes
  ;; `fold-whole-words` checks that its ops make the text the ops it was
  ;; given make, through a gap buffer rather than applying them in turn.
  (doseq [seed (range 1 6)]
    (let [r (java.util.Random. seed)]
      (dotimes [case-n 1000]
        (let [[body tokens ops] (random-edit-case r)
              applied (try (:text/body (:text (ta/apply-text-edits ops {:text/body body} tokens)))
                           (catch clojure.lang.ExceptionInfo _ nil))]
          (is (= applied (#'ta/ops-body ops body))
              (str "seed " seed " case " case-n ": " (pr-str body) " " (pr-str ops))))))))

;; ---------------------------------------------------------------------------
;; pair-replacements looks tokens up by position, where it scanned every
;; token for every stretch. This is the version that scanned them, to pin
;; that the two pair alike.

(defn- pair-replacements-scanning-every-token [ops old tokens]
  (let [old-width #'ta/old-width
        new-text #'ta/new-text
        op-end #'ta/op-end
        holds-with-room? (fn [s e]
                           (boolean (some (fn [{:token/keys [begin end]}]
                                            (and (< begin end) (<= begin s) (<= e end)
                                                 (or (< begin s) (< e end))))
                                          tokens)))
        whole (cp/cp-count old)
        pinned (into #{}
                     (comp (filter #(= (:token/begin %) (:token/end %)))
                           (map :token/begin))
                     tokens)
        kind-of (fn [run] (set (map :type run)))
        flush (fn [out run start]
                (let [width (reduce + (map old-width run))
                      kinds (kind-of run)]
                  (if (and (contains? kinds :delete)
                           (contains? kinds :insert)
                           (not (and (zero? start) (= width whole))))
                    (conj out (ta/replace-op (:index (first run))
                                             width
                                             (apply str (keep new-text run))))
                    (into out (remove #(= :keep (:type %)) run)))))]
    (loop [ops ops run [] at nil start 0 width 0 shift 0 out []]
      (if-let [op (first ops)]
        (let [old-index (- (:index op) shift)
              shift' (case (:type op)
                       :insert (+ shift (cp/cp-count (:value op)))
                       :delete (- shift (:value op))
                       shift)
              taken (old-width op)
              apart? (and (= :delete (:type op))
                          (some #(= :delete (:type %)) run)
                          (contains? pinned old-index))
              touching? (and (seq run) (= (:index op) at) (not apart?))
              gap-start (+ start width)
              reach (+ old-index (old-width op))
              over-kept? (and (seq run)
                              (not touching?)
                              (not apart?)
                              (< gap-start old-index)
                              (= #{(if (= :delete (:type op)) :insert :delete)}
                                 (kind-of run))
                              (holds-with-room? start reach)
                              (not (#'ta/token-inside? tokens start reach)))]
          (cond
            touching?
            (recur (rest ops) (conj run op) (op-end op) start (+ width taken) shift' out)

            over-kept?
            (let [kept {:type :keep :value (cp/cp-subs old gap-start old-index)}]
              (recur (rest ops) (conj run kept op) (op-end op) start
                     (+ width (old-width kept) taken) shift' out))

            :else
            (recur (rest ops) [op] (op-end op) old-index taken shift'
                   (flush out run start))))
        (flush out run start)))))

(deftest pair-replacements-looking-tokens-up-pairs-as-scanning-them
  ;; Few letters, so the diff keeps letters between a delete and an insert,
  ;; with words, morphemes, tokens over several words and zero-width
  ;; markers, and enough edits that the tokens are looked up by position.
  (let [r (java.util.Random. 23)
        words ["a" "t" "at" "ta" "tat" "att" "aa" "é" "𐍂a" "tata"]
        seps [" " " " "" "\n"]
        diverged (atom [])]
    (dotimes [case-n 3000]
      (let [n (+ 2 (.nextInt r 30))
            ws (vec (repeatedly n #(nth words (.nextInt r (count words)))))
            body-of (fn [ws] (apply str (interleave ws (repeatedly #(nth seps (.nextInt r (count seps)))))))
            old (body-of ws)
            len (cp/cp-count old)
            tokens (vec (for [i (range (.nextInt r 40))]
                          (let [b (.nextInt r (inc len))
                                e (if (< (.nextDouble r) 0.15) b (min len (+ b (.nextInt r 8))))]
                            (tok i b e))))
            new (body-of (vec (keep #(case (.nextInt r 4) 0 nil 1 (nth words (.nextInt r (count words))) %) ws)))
            ops (-> (ta/diff old new)
                    (ta/slide-to-tokens old tokens)
                    (ta/normalize-deletes old tokens))]
        (when (not= (pair-replacements-scanning-every-token ops old tokens)
                    (ta/pair-replacements ops old tokens))
          (swap! diverged conj [case-n old new]))))
    (is (= [] (take 5 @diverged)))))

(deftest word-alignment-of-an-edit-with-no-word-token-near
  ;; A text whose word tokens stop before a later line, or a layer of words
  ;; over none of the letters edited: finding the edges between words threw
  ;; when no word token was within reach of the edit, and the save answered
  ;; 500.
  (doseq [[old new tokens]
          [["the cat sat on the mat and then some more words here to be far away"
            "the cat sat on the mat and then some more words here to be far awXy"
            [(assoc (tok 1 0 3) :token/layer :w)]]
           ["the cat sat" "the cXt sat" [(assoc (tok 1 0 11) :token/layer :s)]]]]
    (let [ops (ta/align-to-words (ta/diff old new) old tokens #{:w})]
      (is (= new (:text/body (:text (apply-all ops old []))))))))

(deftest a-replace-joining-two-words-beside-another-edit-keeps-the-text
  ;; In a script without spaces, a replace over the edge of two words joins
  ;; them, and the word it keeps takes the other's letters up to its far
  ;; edge. When the edit beside it takes some of those letters too, the two
  ;; overlapped, and judging whether the fold broke the word applied them
  ;; together and threw: the save answered 500 on a text of 12 letters.
  (doseq [[old new extents]
          [["tatukaiYarın" "tatuata"
            {:s [[0 12]] :w [[0 4] [4 7] [7 12]] :m [[4 6] [6 7] [7 8] [8 9] [9 12]]}]
           ["cafétatكتاب\ndog𐌰𐌱𐌲\nYarınköyecat\n" "caاaكتاب\ndog𐌰𐌱𐌲\nYarınköyecat\n"
            {:s [[0 12] [12 19] [19 32]]
             :w [[0 4] [4 7] [7 11] [12 15] [15 18] [19 24] [24 28] [28 31]]
             :m [[0 1] [1 4] [4 6] [6 7] [15 17] [17 18]]
             :u [[0 4] [12 15]]}]]]
    (let [tokens (vec (for [[layer es] extents [b e] es]
                        (assoc (tok [layer b e] b e) :token/layer layer)))]
      (is (= new (:text/body (:text (body-edit old new tokens #{:s} #{:w :m})))) (pr-str old)))))

(deftest the-fold-judges-every-edit-without-falling-back
  ;; Words with and without spaces between them, each with two morphemes,
  ;; some deleted and some respelled with letters the text already has, so
  ;; the diff often replaces across the edge of two words and deletes
  ;; letters beside it. The fold must judge those edits itself: when a join
  ;; took letters the edit beside it took too, it threw or made another
  ;; text, and the fold was dropped for the whole text.
  (let [vocab ["tatu" "kai" "Yarın" "köye" "cat" "tat" "kaki" "ab" "é" "كتاب"]
        letters ["a" "t" "e" "k" "ا"]
        r (java.util.Random. 11)
        failed (atom [])]
    (dotimes [case-n 3000]
      (let [n (+ 3 (.nextInt r 8))
            sep (nth ["" "" " " "\n"] (.nextInt r 4))
            words (vec (repeatedly n #(nth vocab (.nextInt r (count vocab)))))
            old (str/join sep words)
            spans (loop [i 0 b 0 out []]
                    (if (= i n)
                      out
                      (let [e (+ b (cp/cp-count (words i)))]
                        (recur (inc i) (+ e (cp/cp-count sep)) (conj out [b e])))))
            tokens (into [(assoc (tok :s 0 (cp/cp-count old)) :token/layer :s)]
                         (mapcat (fn [[b e]]
                                   (let [k (+ b 1 (.nextInt r (max 1 (- e b 1))))]
                                     (cond-> [(assoc (tok [:w b] b e) :token/layer :w)]
                                       (< k e) (conj (assoc (tok [:m b] b k) :token/layer :m)
                                                     (assoc (tok [:m k] k e) :token/layer :m))))))
                         spans)
            new (str/join sep (keep (fn [w]
                                      (case (.nextInt r 4)
                                        0 nil
                                        1 (apply str (repeatedly (inc (.nextInt r 3))
                                                                 #(nth letters (.nextInt r (count letters)))))
                                        w))
                                    words))
            ops (-> (ta/diff old new)
                    (ta/slide-to-tokens old tokens #{:s})
                    (ta/normalize-deletes old tokens)
                    (ta/align-to-words old tokens #{:w :m})
                    (ta/pair-replacements old tokens))
            folded (try (#'ta/fold-whole-words* ops old tokens #(#{:w :m} (:token/layer %)) (constantly false))
                        (catch Throwable e e))]
        (when-not (and (sequential? folded)
                       (= new (#'ta/ops-body folded old)))
          (swap! failed conj [case-n old new]))))
    (is (= [] (take 5 @failed)))))

(defn- extents-of [tokens layer]
  (sort (keep #(when (= layer (:token/layer %)) [(:token/begin %) (:token/end %)]) tokens)))

(deftest a-join-takes-in-the-edits-beside-it-in-the-letters-it-types-back
  ;; `kai tatu שלום` to `ket` is `ai ta` replaced by `e` and `u שלום`
  ;; deleted. The replace joins `kai` and `tatu`, and keeping `tatu` it
  ;; typed back `ka` in front of it while the delete took its `u`: the join
  ;; judged `tatu` by letters that were gone, and put `ket` on `tatu` and
  ;; its morphemes. Taking the delete's `u` into the join, `kai` shares
  ;; more with `ket` and takes it, and `tatu` goes with `שלום`.
  (let [old "kaki dog kai tatu שלום\n"
        new "kaki dog ket\n"
        extents {:s [[0 23]]
                 :w [[0 4] [5 8] [9 12] [13 17] [18 22]]
                 :m [[13 16] [16 17] [18 19] [19 21] [21 22]]}
        tokens (vec (for [[layer es] extents [b e] es]
                      (assoc (tok [layer b e] b e) :token/layer layer)))
        {:keys [text tokens]} (body-edit old new tokens #{:s} #{:w :m})
        by-id (into {} (map (juxt :token/id identity)) tokens)]
    (is (= new (:text/body text)))
    (is (= [[0 4] [5 8] [9 12]] (extents-of tokens :w)))
    (is (= [9 12] ((juxt :token/begin :token/end) (by-id [:w 9 12]))))
    (is (= [] (extents-of tokens :m)))))

(deftest a-join-beside-another-edit-leaves-the-other-words-to-fold
  ;; A join overlapping the edit beside it could not be judged, and the
  ;; fold then left every edit in the text as it came: `cow`, analyzed
  ;; `co` + `w` and replaced by `abc` two lines on, kept the word and `co`
  ;; on the `c` of `abc`. Now the join takes that edit in, and `cow` folds.
  (let [old "tatukaiYarın\nthe dog\ncow dog\n"
        new "tatuata\nthe dog\nabc dog\n"
        extents {:s [[0 13] [13 21] [21 29]]
                 :w [[0 4] [4 7] [7 12] [13 16] [17 20] [21 24] [25 28]]
                 :m [[4 6] [6 7] [7 8] [8 9] [9 12] [21 23] [23 24]]}
        tokens (vec (for [[layer es] extents [b e] es]
                      (assoc (tok [layer b e] b e) :token/layer layer)))
        {:keys [text tokens]} (body-edit old new tokens #{:s} #{:w :m})
        by-id (into {} (map (juxt :token/id identity)) tokens)]
    (is (= new (:text/body text)))
    (is (= [16 19] ((juxt :token/begin :token/end) (by-id [:w 21 24]))))
    (is (nil? (by-id [:m 21 23])))
    (is (nil? (by-id [:m 23 24])))))

;; ---------------------------------------------------------------------------
;; The fold finds the places between two morphemes of a word, and the tokens
;; holding an edit inside a run without whitespace, from an index built once
;; per run. It walked the run and its tokens for every edit, and in a script
;; without spaces a run is a whole line: a line of 30,000 letters retyped
;; held the write lock for 80 s. These are the walks, to pin that the index
;; finds the same.

(defn- run-around [^ints o sep? p q]
  [(loop [k p] (if (and (pos? k) (not (sep? (aget o (dec k))))) (recur (dec k)) k))
   (loop [k q] (if (and (< k (alength o)) (not (sep? (aget o k)))) (recur (inc k)) k))])

(defn- inside-word-walking [^ints o near word? p]
  (let [width? (fn [{:token/keys [begin end]}] (< begin end))
        [B E] (run-around o #'ta/space? p p)
        ts (filter width? (near B E))
        in (fn [S] (filter (fn [{:token/keys [begin end]}]
                             (and (<= (:token/begin S) begin) (<= end (:token/end S))
                                  (not= [begin end] [(:token/begin S) (:token/end S)])))
                           ts))]
    (boolean (some (fn [{:token/keys [begin end] :as S}]
                     (and (word? S) (<= B begin) (< begin p end) (<= end E)
                          (some #(= p (:token/end %)) (in S))
                          (some #(= p (:token/begin %)) (in S))))
                   ts))))

(defn- holders-walking [^ints o near keep? p q]
  (let [[B E] (run-around o #(Character/isWhitespace (int %)) p q)]
    (->> (near B E)
         (filter (fn [{tb :token/begin te :token/end :as t}]
                   (and (< tb te) (<= B tb p) (<= q te E) (keep? t))))
         (sort-by :token/begin))))

(deftest the-fold-finds-word-edges-and-holders-as-walking-the-run-does
  (let [r (java.util.Random. 29)
        words ["a" "t" "at" "tat" "é" "𐍂a" "你好" "كتاب"]
        seps ["" "" "" " " "\n" "\u00a0"]]
    (dotimes [case-n 400]
      (let [n (+ 2 (.nextInt r 60))
            body (apply str (repeatedly n #(str (nth words (.nextInt r (count words)))
                                                (nth seps (.nextInt r (count seps))))))
            o (.toArray (.codePoints ^String body))
            len (alength o)
            tokens (vec (for [i (range (.nextInt r 120))]
                          (let [b (.nextInt r (inc len))
                                e (min len (+ b (case (.nextInt r 4) 0 0 1 (.nextInt r 3) 2 (.nextInt r 8) (.nextInt r 90))))]
                            (assoc (tok i b e) :token/layer (nth [:w :m :s] (.nextInt r 3))))))
            near (#'ta/tokens-near tokens (if (even? case-n) 1 100))
            word? #(#{:w :m} (:token/layer %))
            keep? #(and (word? %) (not= [0 len] [(:token/begin %) (:token/end %)]))
            inside? (#'ta/inside-word-fn o near word?)
            holders (#'ta/holders-fn near (#'ta/run-bounds o #(Character/isWhitespace (int %))) keep?)]
        (doseq [p (range (inc len))]
          (is (= (inside-word-walking o near word? p) (boolean (inside? p)))
              (str case-n " " (pr-str body) " at " p)))
        (dotimes [_ 30]
          (let [p (.nextInt r (inc len))
                q (min len (+ p (.nextInt r 4)))]
            (is (= (holders-walking o near keep? p q) (holders p q))
                (str case-n " " (pr-str body) " [" p " " q "]"))))))))

(deftest many-edits-with-one-out-of-order-apply-quickly
  ;; The same edits with one op standing before where the last left off, as
  ;; the fold of a line retyped almost whole gave one among 7,000. The whole
  ;; list was applied op by op over every token then: a minute of the write
  ;; lock. Now each run of ops in order is applied in one pass.
  (let [words (vec (take 50000 (cycle ["the" "cat" "sat" "ta" "tat" "at"])))
        old (str/join " " words)
        tokens (word-tokens words)
        ops (ta/diff old (str/join " " (map-indexed (fn [i w] (if (zero? (mod i 50)) (str w "x") w)) words)))
        ;; an insert back at the start of the text after the 500th op
        ops (into (conj (subvec ops 0 500) (ta/insert-op 0 "Q")) (map #(update % :index inc) (subvec ops 500)))
        t0 (System/nanoTime)
        result (ta/apply-text-edits ops {:text/body old} tokens)
        ms (/ (- (System/nanoTime) t0) 1e6)]
    (is (= (edit-outcome #'ta/apply-text-edits-in-turn ops old tokens)
           (edit-outcome ta/apply-text-edits ops old tokens)))
    (is (= 50000 (count (:tokens result))))
    (is (< ms 1000) (str ms " ms"))))

(deftest a-long-line-without-spaces-folds-quickly
  ;; 10,000 words of a script without spaces on one line, each a word token
  ;; with two morphemes, and one word in ten retyped. The fold walked the
  ;; whole line and its tokens for every edit: 26 s under the write lock.
  (let [vocab ["你好" "世界" "我们" "中国" "文字" "今日は" "東京" "ありがとう"]
        r (java.util.Random. 3)
        words (vec (repeatedly 10000 #(nth vocab (.nextInt r (count vocab)))))
        old (apply str words)
        new (apply str (map-indexed (fn [i w] (if (zero? (mod i 10)) (nth vocab (mod (inc i) (count vocab))) w)) words))
        tokens (into []
                     (mapcat (fn [[i b e]]
                               [(assoc (tok [:w i] b e) :token/layer :w)
                                (assoc (tok [:m i 0] b (inc b)) :token/layer :m)
                                (assoc (tok [:m i 1] (inc b) e) :token/layer :m)]))
                     (loop [i 0 b 0 out []]
                       (if (= i (count words))
                         out
                         (let [e (+ b (cp/cp-count (words i)))] (recur (inc i) e (conj out [i b e]))))))
        ops (-> (ta/diff old new)
                (ta/slide-to-tokens old tokens #{})
                (ta/normalize-deletes old tokens)
                (ta/align-to-words old tokens #{:w :m})
                (ta/pair-replacements old tokens))
        t0 (System/nanoTime)
        folded (ta/fold-whole-words ops old tokens #{:w :m})
        ms (/ (- (System/nanoTime) t0) 1e6)]
    (is (= new (:text/body (:text (apply-all folded old tokens)))))
    (is (< ms 1500) (str ms " ms"))))

(deftest a-space-deleted-in-a-long-changed-stretch-keeps-both-words
  ;; A line of 120 words, one save that types a space in the second word and
  ;; in the last but one and deletes the space between two words in the
  ;; middle. The stretch between the first and last change is past
  ;; `hunk-limit`, so it is diffed by words, and the word diff kept the space
  ;; after the first of the two words: the second came out deleted and typed
  ;; again after the first, and its token went with everything on it.
  (let [w (fn [i] (str "w" (Integer/toString i 36) "q"))
        words (mapv w (range 120))
        old (str/join " " words)
        split (fn [s] (str (subs s 0 2) " " (subs s 2)))
        new (-> (str/join " " (map-indexed (fn [i s] (if (#{1 118} i) (split s) s)) words))
                (str/replace (str (w 60) " " (w 61)) (str (w 60) (w 61)))
                (str/replace (str (w 80) " " (w 81)) (str (subs (w 80) 0 3) (subs (w 81) 1))))
        starts (vec (reductions + 0 (map #(inc (count %)) words)))
        tokens (mapv (fn [i] (tok i (starts i) (+ (starts i) (count (words i))))) (range 120))
        at (fn [s] (cp/cp-count (subs new 0 (str/index-of new s))))
        {:keys [text tokens]} (body-edit old new tokens)
        by-id (into {} (map (juxt :token/id identity)) tokens)
        read (fn [i] (when-let [{:token/keys [begin end]} (by-id i)] [begin end]))]
    (is (= new (:text/body text)))
    (is (= [(at (w 60)) (+ (at (w 60)) 4)] (read 60)))
    (is (= [(+ (at (w 60)) 4) (+ (at (w 60)) 8)] (read 61)))
    (testing "a join losing letters leaves one token on the new word"
      (let [j (str (subs (w 80) 0 3) (subs (w 81) 1))]
        (is (= 1 (count (filter #(and (by-id %) (< (:token/begin (by-id %)) (+ (at j) 6)) (> (:token/end (by-id %)) (at j))) [80 81]))))
        (is (some #(= [(at j) (+ (at j) 6)] (read %)) [80 81]))))))
