(ns plaid.algos.text-test
  "Unit tests for plaid.algos.text.

  Task #71 regression: zero-width token (begin == end == p) handling must be
  symmetric between :insert and :delete:
    - :insert at p keeps a zero-width token at p pinned at p.
    - :delete with a range whose endpoint equals p (either side) does NOT
      delete a zero-width token at p — only a range that *strictly* contains
      p does."
  (:require [clojure.test :refer [deftest is testing]]
            [plaid.algos.text :as ta]))

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

  (testing "zero-width tokens keep delete/insert pinning rules"
    ;; Same outcome as delete [1,3) then insert at 1: the delete shifts the
    ;; range-end token to 1, and an insert AT a zero-width token's position
    ;; pins it there — so both boundary tokens end up before the replacement.
    (let [text {:text/body "abcd"}
          tokens [(tok :at-start 1 1) (tok :inside 2 2) (tok :at-end 3 3)]
          {:keys [tokens deleted]}
          (ta/apply-text-edit (ta/replace-op 1 2 "XYZ") text tokens)
          via-ops (ta/apply-text-edits [(ta/delete-op 1 2) (ta/insert-op 1 "XYZ")] text
                                       [(tok :at-start 1 1) (tok :inside 2 2) (tok :at-end 3 3)])]
      (is (= [:inside] deleted))
      (is (= #{[:at-start 1 1] [:at-end 1 1]}
             (set (map (juxt :token/id :token/begin :token/end) tokens))))
      (is (= (set tokens) (set (:tokens via-ops)))))))

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
