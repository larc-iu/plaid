(ns plaid.algos.text
  "What a change to a text's body does to the text and to the tokens over
  it. The work is in the namespaces under this one, and this one keeps the
  public names its callers use (see `export`)."
  (:require [plaid.algos.text.chars :refer [in-ranges? punct-classes space?]]
            [plaid.algos.text.diff]
            [plaid.algos.text.ops]
            [plaid.algos.text.plain]
            [plaid.algos.text.read]
            [plaid.util.codepoint :as cp]))

(defmacro ^:private export
  "Each of `syms`, a fully qualified public var of a namespace under this
  one, defined here under its own name with its doc and arglists."
  [& syms]
  `(do ~@(for [s syms
               :let [m (meta (resolve s))]]
           `(def ~(vary-meta (symbol (name s)) assoc :doc (:doc m) :arglists (list 'quote (:arglists m)))
              ~s))))

(export plaid.algos.text.chars/ignored-rule
        plaid.algos.text.diff/diff
        plaid.algos.text.plain/follow-sentences
        plaid.algos.text.plain/apply-plain-gaps
        plaid.algos.text.plain/layer-roles
        plaid.algos.text.read/align-to-words
        plaid.algos.text.read/slide-to-tokens
        plaid.algos.text.read/normalize-deletes
        plaid.algos.text.read/body-diff-gaps
        plaid.algos.text.read/plain-body-gaps
        plaid.algos.text.read/plain-body-read
        plaid.algos.text.read/plain-edit-gaps
        plaid.algos.text.ops/delete-op
        plaid.algos.text.ops/insert-op
        plaid.algos.text.ops/replace-op
        plaid.algos.text.ops/edit-ops-body
        plaid.algos.text.ops/apply-text-edits
        plaid.algos.text.ops/compose-edits
        plaid.algos.text.ops/gap-ops)

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
