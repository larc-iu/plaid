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
            [plaid.sql.vocab-item :as vocab-item]
            [plaid.sql.document :as document]
            [plaid.sql.text :as text])
  (:import [org.sqlite SQLiteConnection Function]
           [java.lang.reflect Method]
           [java.util.regex Pattern]
           [java.util.concurrent ConcurrentHashMap]))

;; --- REGEXP UDF (SQLite-specific) -----------------------------------------
;; SQLite ships no REGEXP operator; Xerial lets us register one per connection.
;; We register it on each query connection (in `run-bounded`) so the query
;; language's regex value-matching works. Postgres has native `~`/`~*`, so this
;; whole block is SQLite-only — the portability seam is `regex-pred` in
;; compile.clj, the single place that emits the predicate.
;;
;; org.sqlite.Function's arg/result accessors are `protected`; a Clojure proxy
;; body can't reach a protected supermethod, so we go through reflection with
;; setAccessible (verified working on the Xerial driver in use).
(def ^:private ^Method m-value-text
  (doto (.getDeclaredMethod Function "value_text" (into-array Class [Integer/TYPE]))
    (.setAccessible true)))
(def ^:private ^Method m-result-int
  (doto (.getDeclaredMethod Function "result" (into-array Class [Integer/TYPE]))
    (.setAccessible true)))

(def ^:private ^ConcurrentHashMap pattern-cache (ConcurrentHashMap.))
(def ^:private pattern-cache-max 256)

(defn- cached-pattern ^Pattern [^String p]
  (or (.get pattern-cache p)
      (let [compiled (Pattern/compile p)]
        ;; bounded: stop caching past the cap (patterns past it still compile,
        ;; just uncached) so adversarial distinct patterns can't grow it forever
        (when (< (.size pattern-cache) pattern-cache-max)
          (.putIfAbsent pattern-cache p compiled))
        compiled)))

(defn- interruptible-cs
  "Wrap `s` in a CharSequence whose `charAt` aborts (throws) once the running
  thread is interrupted. This is the ONLY reliable kill for a catastrophic-
  backtracking regex: SQLite's `interrupt()` can't stop a thread spinning inside
  Java `Pattern.find()` (it never returns to the SQLite VM), so the watchdog also
  interrupts the worker thread and the matcher notices here. `isInterrupted`
  doesn't clear the flag; checking per-charAt is a cheap volatile read."
  ^CharSequence [^String s]
  (let [t (Thread/currentThread)]
    (reify CharSequence
      (length [_] (.length s))
      (charAt [_ i]
        (when (.isInterrupted t)
          (throw (RuntimeException. "regex interrupted (query time limit)")))
        (.charAt s i))
      (subSequence [_ a b] (.subSequence s a b))
      (^String toString [_] s))))

(defn- regexp-function
  "A REGEXP(pattern, value) UDF: 1 if `value` contains a match for the Java
  regex `pattern`, else 0. Compiled patterns are cached. Patterns are validated
  for syntax at query-validation time, so compile here won't see a bad one. The
  value is wrapped in an interruptible CharSequence so a runaway pattern can be
  aborted by the query watchdog (ReDoS guard)."
  []
  (proxy [Function] []
    (xFunc []
      (let [pat (.invoke m-value-text this (object-array [(int 0)]))
            s   (.invoke m-value-text this (object-array [(int 1)]))
            hit (if (and pat s (.find (.matcher (cached-pattern pat) (interruptible-cs s)))) 1 0)]
        (.invoke m-result-int this (object-array [(int hit)]))))))

(defn- register-regexp! [^SQLiteConnection sqlite]
  (Function/create sqlite "REGEXP" (regexp-function)))

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
  {:span span/get :token token/get :relation relation/get :vocab vocab-item/get
   :document document/get :text text/get})

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
    (let [sqlite (.unwrap conn SQLiteConnection)
          ndb (.getDatabase sqlite)
          _ (register-regexp! sqlite)            ; make REGEXP() available for this query
          done (atom false)
          worker (promise)
          fut (future (deliver worker (Thread/currentThread))
                      (try (f conn)
                           ;; clear any interrupt before this pooled thread is
                           ;; reused (the watchdog may have set it)
                           (finally (reset! done true) (Thread/interrupted))))
          watchdog (future (Thread/sleep *query-timeout-ms*)
                           (when-not @done
                             ;; abort SQLite's VM AND interrupt the worker thread,
                             ;; so a runaway Java regex (which SQLite's interrupt
                             ;; can't reach) is killed via interruptible-cs too.
                             (.interrupt ndb)
                             (.interrupt ^Thread @worker)))]
      (try
        @fut
        (catch java.util.concurrent.ExecutionException e
          (let [cause (.getCause e)]
            (if (and cause (re-find #"(?i)interrupt" (str (.getMessage cause))))
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
  "Row-returning HoneySQL for the compiled branches under `limit`, with an
  optional ORDER BY applied OUTSIDE any UNION (the sort columns are projected
  into each branch as `__ord_N`, so a single ORDER BY at the top sorts the whole
  compound)."
  [hqs limit order]
  (let [base (if (= 1 (count hqs))
               (first hqs)
               {:select [:*] :from [[{:union hqs} :_q]]})]
    (cond-> (assoc base :limit limit)
      (seq order) (assoc :order-by order))))

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

(def ^:private agg-group-cap
  "Max group rows an aggregate query returns. Groups are not matches, so this is
  NOT the 100/1000 match cap — it's a generous backstop; past it `:truncated` is
  set. The 30s watchdog still bounds runtime."
  100000)

(defn- aggregate-query
  "Wrap the (union of) distinct-match branches in a GROUP BY per `plan`, under
  `limit` group rows. Returns {:hq <honeysql> :read-kws [...] :labels [...]}: the
  SQL aliases aggregates to safe `__c_N` keys; `labels` are the human column
  names for the result envelope."
  [hqs plan limit]
  (let [inner (if (= 1 (count hqs)) (first hqs) {:union hqs})
        group-cols (:group-cols plan)
        agg-selects (map-indexed
                     (fn [j {:keys [op col]}]
                       [(if (= op :count) :%count.* [op col]) (keyword (str "__c_" j))])
                     (:aggs plan))
        read-kws (into (vec group-cols) (map second agg-selects))
        labels (into (vec (:group-labels plan)) (map :label (:aggs plan)))
        hq (cond-> {:select (into (vec group-cols) agg-selects)
                    :from [[inner :_agg]]
                    :limit limit}
             (seq group-cols) (assoc :group-by (vec group-cols)))]
    {:hq hq :read-kws read-kws :labels labels}))

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
    (cond
      (ast/aggregate? head)
      (let [plan (qc/aggregate-plan (first hqs))
            lim (min (or (:limit head) agg-group-cap) agg-group-cap)
            {:keys [hq read-kws labels]} (aggregate-query hqs plan (inc lim))
            rows (run-bounded db (fn [conn] (psc/q conn hq)))
            truncated? (> (count rows) lim)
            rows (vec (take lim rows))]
        {:return :aggregate
         :columns labels
         :results (mapv (fn [r] (mapv #(get r %) read-kws)) rows)
         :count (count rows)
         :truncated truncated?})

      (= return-type :count)
      (let [n (:n (run-bounded db (fn [conn] (psc/q1 conn (count-query hqs)))))]
        {:return :count
         :count (min n count-cap)
         :truncated (> n count-cap)})

      :else
      (let [lim (effective-limit (:limit head))
            order (qc/order-directive (first hqs))
            ;; fetch one extra row to detect truncation, then trim
            rows (run-bounded db (fn [conn] (psc/q conn (assemble hqs (inc lim) order))))
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
