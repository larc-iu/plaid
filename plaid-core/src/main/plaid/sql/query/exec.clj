(ns plaid.sql.query.exec
  "Orchestration + result shaping for the query language. `run` is the single
  entry point used by both the REST handler and the REPL: it threads a raw
  request body through parse -> validate -> resolve(db,user) -> compile -> SQL,
  and shapes the rows into a result envelope.

  A query may desugar (via `:seq` bounded quantifiers) to several branch ASTs
  sharing the same `:find`; each compiles independently and the branches are
  combined with SQL `UNION` (set semantics).

  Return shapes (`:return`):
    :ids       (default) — each result cell is an entity id.
    :entities            — each cell is the full REST-shape entity map (the SAME
                           shape GET endpoints return, so the clients' generic
                           recursive case-transformers convert it for free).
    :count               — a scalar count of distinct matches (ignores :limit).

  Guardrails: id/entity results default to `default-limit` rows when no `:limit`
  is given and are hard-capped at `hard-cap`; the envelope carries `:truncated`
  when the (effective) limit was reached. `:count` is exact and uncapped.

  Errors propagate as `ex-info` with a `:code` (400 author error / 500 compiler
  bug) for the REST layer to map to an HTTP status."
  (:require [plaid.query.ast :as ast]
            [plaid.sql.common :as psc]
            [plaid.sql.query.compile :as qc]
            [plaid.sql.query.resolve :as qr]
            [plaid.sql.span :as span]
            [plaid.sql.token :as token]
            [plaid.sql.relation :as relation]
            [plaid.sql.vocab-item :as vocab-item]))

(def ^:private default-limit
  "Rows returned when the query specifies no :limit."
  100)

(def ^:private hard-cap
  "Maximum rows ever returned for an :ids/:entities query; an explicit :limit
  above this is clamped down."
  1000)

(def ^:private kind->get
  "Per-kind single-entity reader — the SAME fns the REST GET endpoints use, so
  hydrated entities are byte-for-byte the public wire shape."
  {:span span/get :token token/get :relation relation/get :vocab vocab-item/get})

(defn- find-cols
  "Column names for the result envelope: `:find` var names without the `?`."
  [find-vars]
  (mapv #(subs (name %) 1) find-vars))

(defn- effective-limit [user-limit]
  (min (or user-limit default-limit) hard-cap))

(defn- assemble
  "Row-returning HoneySQL for the compiled branches under `limit`."
  [hqs limit]
  (if (= 1 (count hqs))
    (assoc (first hqs) :limit limit)
    {:select [:*] :from [[{:union hqs} :_q]] :limit limit}))

(defn- count-query
  "COUNT(*) over the (distinct) union of branches — the exact number of distinct
  matches, no row limit."
  [hqs]
  {:select [[:%count.* :n]]
   :from [[(if (= 1 (count hqs)) (first hqs) {:union hqs}) :_c]]})

(defn- hydrate
  "Replace each id cell in `id-results` with its full REST-shape entity map.
  Each distinct (kind, id) is fetched once (cached), reusing the kind's public
  `get` fn so the wire shape is identical to the REST GET response."
  [db find-vars branch id-results]
  (let [kinds (::ast/var-kinds branch)
        find-kinds (mapv kinds find-vars)
        cache (atom {})
        fetch (fn [kind id]
                (let [k [kind id]]
                  (if (contains? @cache k)
                    (@cache k)
                    (let [e ((kind->get kind) db id)]
                      (swap! cache assoc k e)
                      e))))]
    (mapv (fn [row] (mapv fetch find-kinds row)) id-results)))

(defn run
  "Execute a query. `raw` is the (JSON- or EDN-dialect) request body. Returns a
  result envelope:
    {:return :ids|:entities  :columns [...] :results [[...] ...] :count N
     :truncated bool}
  or, for `:return :count`,  {:return :count :count N}."
  [db user-id raw]
  (let [branches (ast/expand raw)
        head (first branches)
        find-vars (:find head)
        return-type (:return head)
        cols (find-cols find-vars)
        col-kws (mapv keyword cols)
        ;; exec owns the limit policy: compile every branch without its own
        ;; :limit, then apply the effective limit once at assembly.
        hqs (mapv (fn [b] (qc/compile-query (qr/resolve-query db user-id (dissoc b :limit)))) branches)]
    (if (= return-type :count)
      {:return :count
       :count (:n (psc/q1 db (count-query hqs)))}
      (let [lim (effective-limit (:limit head))
            ;; fetch one extra row to detect truncation, then trim
            rows (psc/q db (assemble hqs (inc lim)))
            truncated? (> (count rows) lim)
            rows (vec (take lim rows))
            id-results (mapv (fn [row] (mapv #(get row %) col-kws)) rows)
            results (if (= return-type :entities)
                      (hydrate db find-vars head id-results)
                      id-results)]
        {:return return-type
         :columns cols
         :results results
         :count (count results)
         :truncated truncated?}))))
