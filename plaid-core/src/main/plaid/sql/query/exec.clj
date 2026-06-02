(ns plaid.sql.query.exec
  "Orchestration + result shaping for the query language. `run` is the single
  entry point used by both the REST handler and the REPL: it threads a raw
  request body through parse -> validate -> resolve(db,user) -> compile -> SQL,
  and shapes the rows into a column/result-tuple envelope.

  v0 returns `:ids` only: each result row is a tuple of entity ids in `:find`
  order. Errors propagate as `ex-info` with a `:code` (400 author error / 500
  compiler bug) for the REST layer to map to an HTTP status.

  A query may desugar (via `:seq` bounded quantifiers) to several branch ASTs
  sharing the same `:find`; each compiles independently and the branches are
  combined with SQL `UNION` (set semantics). A `:limit` is applied once, around
  the union, so no branch truncates the global result early."
  (:require [plaid.query.ast :as ast]
            [plaid.sql.common :as psc]
            [plaid.sql.query.compile :as qc]
            [plaid.sql.query.resolve :as qr]))

(defn- find-cols
  "Column names for the result envelope: `:find` var names without the `?`."
  [find-vars]
  (mapv #(subs (name %) 1) find-vars))

(defn run
  "Execute a query. `raw` is the (JSON- or EDN-dialect) request body. Returns
    {:columns [\"s1\" \"s2\"] :results [[id id] ...] :count N}
  with ids as entity ids (UUIDs; the REST layer JSON-encodes them to strings)."
  [db user-id raw]
  (let [branches (ast/expand raw)
        find-vars (:find (first branches))
        cols (find-cols find-vars)
        col-kws (mapv keyword cols)
        multi? (> (count branches) 1)
        limit (:limit (first branches))
        ;; For a union, strip per-branch :limit so no branch truncates early;
        ;; the limit is re-applied once around the union below.
        compile1 (fn [b] (qc/compile-query (qr/resolve-query db user-id (cond-> b multi? (dissoc :limit)))))
        hqs (mapv compile1 branches)
        hq (cond
             (not multi?) (first hqs)
             limit        {:select [:*] :from [[{:union hqs} :_q]] :limit limit}
             :else        {:union hqs})
        rows (psc/q db hq)
        results (mapv (fn [row] (mapv #(get row %) col-kws)) rows)]
    {:columns cols
     :results results
     :count (count results)}))
