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
    :count               — a scalar count of distinct matches (ignores :limit;
                           exact up to `count-cap`, then reports `:truncated`).

  Guardrails: id/entity results default to `default-limit` rows when no `:limit`
  is given and are hard-capped at `hard-cap`; the envelope carries `:truncated`
  when the (effective) limit was reached. `:count` is capped at `count-cap`.
  Every query's SQL execution is bounded by `*query-timeout-ms*` (408 on overrun).

  Errors propagate as `ex-info` with a `:code` (400 author error / 500 compiler
  bug) for the REST layer to map to an HTTP status."
  (:require [next.jdbc :as jdbc]
            [plaid.query.ast :as ast]
            [plaid.sql.common :as psc]
            [plaid.sql.query.compile :as qc]
            [plaid.sql.query.resolve :as qr]
            [plaid.sql.span :as span]
            [plaid.sql.token :as token]
            [plaid.sql.relation :as relation]
            [plaid.sql.vocab-item :as vocab-item])
  (:import [org.sqlite SQLiteConnection]))

(def ^:private default-limit
  "Rows returned when the query specifies no :limit."
  100)

(def ^:private hard-cap
  "Maximum rows ever returned for an :ids/:entities query; an explicit :limit
  above this is clamped down."
  1000)

(def ^:private count-cap
  "Upper bound on the work a :count query will do. The count is computed over an
  inner subquery capped at this many rows, so a pathological cross-product count
  (e.g. a bare :precedes* over a huge layer) stops early instead of materializing
  millions of pairs. A count at the cap is reported as `count-cap` with
  `:truncated true`; below it the count is exact."
  100000)

(def ^:private kind->get
  "Per-kind single-entity reader — the SAME fns the REST GET endpoints use, so
  hydrated entities are byte-for-byte the public wire shape."
  {:span span/get :token token/get :relation relation/get :vocab vocab-item/get})

(def ^:dynamic *query-timeout-ms*
  "Wall-clock ceiling for a single query's SQL execution. A query past this is
  aborted (SQLite `interrupt()`) and reported as a 408. SQLite ignores JDBC
  `setQueryTimeout` for CPU-bound work, so we use a watchdog + connection
  interrupt, which IS reliable. Dynamic so tests/operators can rebind it."
  30000)

(defn- run-bounded
  "Run `(f conn)` on a dedicated pooled connection, aborting via SQLite's
  `interrupt()` if it overruns `query-timeout-ms`. Returns `(f conn)`'s value, or
  throws a 408 `ex-info` on timeout. Any other SQL error propagates as its cause."
  [db f]
  (with-open [conn (jdbc/get-connection db)]
    (let [ndb (.getDatabase (.unwrap conn SQLiteConnection))
          done (atom false)
          fut (future (try (f conn) (finally (reset! done true))))
          watchdog (future (Thread/sleep *query-timeout-ms*)
                           (when-not @done (.interrupt ndb)))]
      (try
        @fut
        (catch java.util.concurrent.ExecutionException e
          (let [cause (.getCause e)]
            (if (and (instance? org.sqlite.SQLiteException cause)
                     (re-find #"interrupt" (str (.getMessage cause))))
              (throw (ex-info (str "Query exceeded the " (quot *query-timeout-ms* 1000)
                                   "s time limit — narrow it with more selective clauses or a tighter :scope.")
                              {:code 408 :query-error/stage :exec}))
              (throw cause))))
        (finally (future-cancel watchdog))))))

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
  "COUNT(*) over the (distinct) union of branches, capped: the inner subquery is
  limited to `count-cap + 1` rows so the count short-circuits instead of walking
  an unbounded cross-product. Exact below the cap; `> count-cap` signals it was
  hit."
  [hqs]
  (let [base (if (= 1 (count hqs)) (first hqs) {:union hqs})
        capped {:select [:*] :from [[base :_u]] :limit (inc count-cap)}]
    {:select [[:%count.* :n]]
     :from [[capped :_c]]}))

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
                    ;; layer-kind vars have no entity reader (yet) — return the id
                    (let [e (if-let [g (kind->get kind)] (g db id) {:id id})]
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
      (let [n (:n (run-bounded db (fn [conn] (psc/q1 conn (count-query hqs)))))]
        {:return :count
         :count (min n count-cap)
         :truncated (> n count-cap)})
      (let [lim (effective-limit (:limit head))
            ;; fetch one extra row to detect truncation, then trim
            rows (run-bounded db (fn [conn] (psc/q conn (assemble hqs (inc lim)))))
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
