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
