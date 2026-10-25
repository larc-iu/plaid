(ns plaid.algos.text-helpers
  "The text save's two inputs as the tests call them: a whole-body save
  and an edit from the caret, each taken as gaps and applied by the plain
  rule."
  (:require [plaid.algos.text :as ta]))

(defn plain-body
  "`apply-plain-gaps` for a whole-body save of `old` as `new`, the change
  taken as `plain-body-gaps` takes it."
  ([old new tokens partitioning word-layers] (plain-body old new tokens partitioning word-layers nil))
  ([old new tokens partitioning word-layers opts]
   (let [roles (assoc opts :partitioning partitioning :deciders word-layers)]
     (ta/apply-plain-gaps old tokens (ta/plain-body-gaps old new tokens roles) roles))))

(defn plain-edits
  "`apply-plain-gaps` for an edit of `old` by `ops` from the caret (running
  coordinates, see `compose-edits`), the change taken as `plain-edit-gaps`
  takes it."
  ([old tokens ops partitioning word-layers] (plain-edits old tokens ops partitioning word-layers nil))
  ([old tokens ops partitioning word-layers opts]
   (let [roles (assoc opts :partitioning partitioning :deciders word-layers)]
     (ta/apply-plain-gaps old tokens (ta/plain-edit-gaps old ops) roles))))
