(ns plaid.algos.text.tokenize
  "Words for the text a save types, cut as igt's built-in tokenizer cuts
  them (see `new-words`)."
  (:require [plaid.algos.text.chars :refer [in-ranges? punct-classes space?]]
            [plaid.util.codepoint :as cp]))

;; ---------------------------------------------------------------------------
;; Tokenize new text
;;
;; A save naming a word layer (`tokenize-layer` on the text routes) gets
;; words for the text it types, after the old tokens are placed, so no new
;; word lands where an old one now stands. The cut is igt's built-in
;; tokenizer's (plaid-igt `tokenizationUtils.js`, which the Tokenize tab runs):
;; a word is a run of code points that are neither whitespace nor a break
;; character under the layer's ignored-tokens rule.

(defn typed-ranges
  "Where in the body `gaps` (old-body order, never touching, see
  `compose-edits`) make their values stand, as `[begin end]` code points of
  the new body."
  [gaps]
  (loop [gaps gaps shift 0 out []]
    (if-let [{:keys [start end value]} (first gaps)]
      (let [n (cp/cp-count value)
            b (+ start shift)]
        (recur (rest gaps) (+ shift (- n (- end start))) (cond-> out (pos? n) (conj [b (+ b n)]))))
      out)))

(defn new-words
  "The words \"Tokenize new text\" makes on layer `layer` for a save that made
  `body` and typed `typed` (`[begin end]` ranges of it), with `tokens` (each
  `{:token/layer :token/begin :token/end}`) standing on it after the save:
  each stretch no token of `layer` covers, cut at every token begin of the
  `partitions` layers (the sentences), is cut into words at whitespace and
  at the code points `rule`, the layer's ignored-tokens rule (see
  `ignored-rule`), breaks at. A word is made when it holds a typed code point,
  is not one the rule ignores, and holds no letter of a script written
  without spaces between words (Han, kana, Thai and the like), whose words
  are the user's to cut. Returns `[{:token/layer :token/begin :token/end}]`
  in order."
  [^String body typed tokens layer partitions rule]
  (let [^ints o (.toArray (.codePoints body))
        n (alength o)
        covered (boolean-array n)
        typed? (boolean-array n)
        cut (boolean-array (inc n))
        partitions (set partitions)]
    (doseq [[b e] typed, x (range (max 0 b) (min n e))] (aset typed? x true))
    (doseq [{:token/keys [begin end] l :token/layer} tokens]
      (cond
        (= l layer) (doseq [x (range (max 0 begin) (min n end))] (aset covered x true))
        (partitions l) (when (< 0 begin n) (aset cut begin true))))
    (let [{:keys [break? ignored-word?]} rule
          stop? (fn [x] (or (aget covered x) (space? (aget o x)) (break? (aget o x))))]
      (loop [x 0 out []]
        (cond
          (>= x n) out
          (stop? x) (recur (inc x) out)
          :else
          (let [y (loop [y (inc x)] (if (and (< y n) (not (stop? y)) (not (aget cut y))) (recur (inc y)) y))
                cps (map #(aget o %) (range x y))]
            (recur y (cond-> out
                       (and (some #(aget typed? %) (range x y))
                            (not (ignored-word? cps))
                            (not-any? #(in-ranges? (punct-classes "spaceless") %) cps))
                       (conj {:token/layer layer :token/begin x :token/end y})))))))))
