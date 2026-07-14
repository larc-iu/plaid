(ns hooks.plaid.sql
  (:require [clj-kondo.hooks-api :as api]))

(defn bind-first
  "Analyze Plaid's transaction macros as a let binding for the generated tx
  symbol, followed by evaluation of the macro inputs and body."
  [{:keys [node]}]
  (let [[_ binding-node & body] (:children node)
        [tx-node & input-nodes] (:children binding-node)]
    {:node (api/list-node
            (list* (api/token-node 'let)
                   (api/vector-node [tx-node (api/token-node nil)])
                   (concat input-nodes body)))}))
