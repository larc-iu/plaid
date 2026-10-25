(ns plaid.algos.text
  "What a change to a text's body does to the text and to the tokens over
  it. The work is in the namespaces under this one, and this one keeps the
  public names its callers use (see `export`)."
  (:require [plaid.algos.text.align]
            [plaid.algos.text.chars]
            [plaid.algos.text.diff]
            [plaid.algos.text.ops]
            [plaid.algos.text.plain]
            [plaid.algos.text.read]
            [plaid.algos.text.tokenize]))

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
        plaid.algos.text.plain/layer-of
        plaid.algos.text.align/align-to-words
        plaid.algos.text.read/slide-to-tokens
        plaid.algos.text.read/normalize-deletes
        plaid.algos.text.read/plain-body-gaps
        plaid.algos.text.read/plain-edit-gaps
        plaid.algos.text.ops/delete-op
        plaid.algos.text.ops/insert-op
        plaid.algos.text.ops/replace-op
        plaid.algos.text.ops/edit-ops-body
        plaid.algos.text.ops/apply-text-edits
        plaid.algos.text.ops/compose-edits
        plaid.algos.text.ops/gap-ops
        plaid.algos.text.tokenize/typed-ranges
        plaid.algos.text.tokenize/new-words)
