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
  Every query answers within `*query-timeout-ms*` of its arrival: its wait for a
  turn in the heavy-query queue (503 when none comes), its wait for a pooled
  connection and its SQL run all count against that one deadline (408 on overrun).

  Errors propagate as `ex-info` with a `:code` (400 author error / 500 compiler
  bug) for the REST layer to map to an HTTP status."
  (:require [next.jdbc :as jdbc]
            [plaid.query.ast :as ast]
            [plaid.query.clauses :as clauses]
            [plaid.sql.common :as psc]
            [plaid.sql.query.compile :as qc]
            [plaid.sql.query.resolve :as qr]
            [plaid.sql.span :as span]
            [plaid.sql.token :as token]
            [plaid.sql.relation :as relation]
            [plaid.sql.vocab-item :as vocab-item]
            [plaid.sql.vocab-link :as vocab-link]
            [plaid.sql.document :as document]
            [plaid.sql.text :as text]
            [plaid.util.canonical :as canonical])
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
      (let [compiled (clauses/compile-regex p)]
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

(def ^:private ^Method m-value-type
  (doto (.getDeclaredMethod Function "value_type" (into-array Class [Integer/TYPE]))
    (.setAccessible true)))
(def ^:private ^Method m-result-text
  (doto (.getDeclaredMethod Function "result" (into-array Class [String]))
    (.setAccessible true)))
(def ^:private ^Method m-result-null
  (doto (.getDeclaredMethod Function "result" (into-array Class []))
    (.setAccessible true)))

(defn- composed-pattern
  "`p` in NFC, compiled, or nil when it already is NFC (the pattern as typed
  then says it all) or when composing it makes it something Java cannot
  compile (a letter after a backslash taking a mark: `\\e` and U+0301)."
  [^String p]
  (let [n (canonical/nfc p)]
    (when-not (identical? n p)
      (try (cached-pattern n) (catch Exception _ nil)))))

(defn- regexp-function
  "A REGEXP(pattern, value) UDF: 1 if `value` contains a match for the Java
  regex `pattern`, else 0. A value matches as stored, or in NFC with the
  pattern in NFC, so text matches whatever is canonically equivalent to it:
  `pʰá` typed composed finds it stored decomposed (a + U+0301), and the
  reverse, while every match the stored text gives is kept (a combining mark
  searched for on its own still finds it in a value stored decomposed).
  Compiled patterns are cached. Patterns are validated for syntax at
  query-validation time, so compile here won't see a bad one. The value is
  wrapped in an interruptible CharSequence so a runaway pattern can be
  aborted by the query watchdog (ReDoS guard)."
  []
  (proxy [Function] []
    (xFunc []
      (let [^String pat (.invoke m-value-text this (object-array [(int 0)]))
            ^String s   (.invoke m-value-text this (object-array [(int 1)]))
            found? (fn [^java.util.regex.Pattern p ^String v] (.find (.matcher p (interruptible-cs v))))
            hit (if (and pat s
                         (or (found? (cached-pattern pat) s)
                             (let [ns (canonical/nfc s)
                                   np (composed-pattern pat)]
                               (cond
                                 np (found? np ns)
                                 (identical? ns s) false
                                 :else (found? (cached-pattern pat) ns)))))
                  1 0)]
        (.invoke m-result-int this (object-array [(int hit)]))))))

(def ^:private sqlite-null 5)

(defn- nfc-function
  "A PLAID_NFC(value) UDF: the value's text in Unicode NFC, NULL for NULL. An
  equality with a text that has another canonically equivalent spelling
  compares the stored value through it (`plaid.sql.query.compile`)."
  []
  (proxy [Function] []
    (xFunc []
      (if (= sqlite-null (.invoke m-value-type this (object-array [(int 0)])))
        (.invoke m-result-null this (object-array []))
        (.invoke m-result-text this (object-array [(canonical/nfc (.invoke m-value-text this (object-array [(int 0)])))]))))))

(defn- register-regexp! [^SQLiteConnection sqlite]
  (Function/create sqlite "REGEXP" (regexp-function))
  (Function/create sqlite "PLAID_NFC" (nfc-function)))

(def ^:private default-limit
  "Rows returned when the query specifies no :limit."
  1000)

(def ^:private hard-cap
  "Maximum rows ever returned for an :ids/:entities query; an explicit :limit
  above this is clamped down. Generous by design (trusted callers); note that an
  :entities result this large is slow — hydration is one fetch per distinct
  entity. Matches the :count / aggregate-group caps."
  100000)

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
   :document document/get :text text/get :link vocab-link/get})

(def ^:dynamic *query-timeout-ms*
  "Wall-clock ceiling for a single query, from its arrival: the wait for a
  heavy-query turn, the wait for a pooled connection and the SQL run together.
  A query past it is aborted (SQLite `interrupt()`) and reported as a 408. The
  clients wait a little longer than this (35 s), so the 408 reaches them.
  SQLite ignores JDBC `setQueryTimeout` for CPU-bound work, so we use a
  watchdog + connection interrupt, which IS reliable. Dynamic so
  tests/operators can rebind it."
  30000)

(def ^:dynamic *in-transaction-query-timeout-ms*
  "The ceiling for a query run on a transaction's connection (a query inside
  a batch), in place of `*query-timeout-ms*`. The transaction holds the
  database's write lock for as long as the query runs, and every other write
  waits for that lock only up to busy_timeout (5 s) before it is refused
  with a 503. Dynamic so tests can rebind it."
  2000)

(def ^:dynamic ^:private *in-transaction?* false)

(defn- deadline-from-now [] (+ (System/currentTimeMillis) *query-timeout-ms*))

(defn- ms-left [deadline] (max 0 (- deadline (System/currentTimeMillis))))

(defn- time-limit-error []
  (ex-info (if *in-transaction?*
             (str "A query inside a batch has " (quot *query-timeout-ms* 1000)
                  "s, and this one took longer. Send it on its own, or narrow it.")
             (str "Query exceeded the " (quot *query-timeout-ms* 1000)
                  "s time limit — narrow it with more selective clauses or a tighter :scope."))
           {:code 408 :query-error/stage :exec}))

(defn- connection-by
  "A pooled connection, or a 408 when none comes before `deadline`. A
  connection that comes after it is closed again, back to the pool."
  [db deadline]
  (let [p (future (jdbc/get-connection db))
        conn (try (deref p (ms-left deadline) ::late)
                  (catch java.util.concurrent.ExecutionException e (throw (or (.getCause e) e))))]
    (when (= conn ::late)
      (future (try (.close ^java.sql.Connection @p) (catch Throwable _)))
      (throw (time-limit-error)))
    conn))

(defn- run-on-connection
  "Run `(f conn)` on `conn`, aborting via SQLite's `interrupt()` if it is
  still running at `deadline`. See `run-bounded`."
  [^java.sql.Connection conn f deadline]
  (let [sqlite (.unwrap conn SQLiteConnection)
        ndb (.getDatabase sqlite)
        _ (register-regexp! sqlite)            ; make REGEXP() and PLAID_NFC() available for this query
        done (atom false)
        worker (promise)
        fut (future (deliver worker (Thread/currentThread))
                    (try (f conn)
                         ;; clear any interrupt before this pooled thread is
                         ;; reused (the watchdog may have set it)
                         (finally (reset! done true) (Thread/interrupted))))
        watchdog (future (Thread/sleep (ms-left deadline))
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
            (throw (time-limit-error))
            (throw cause))))
      (finally (future-cancel watchdog)))))

(defn- run-bounded
  "Run `(f conn)` on a dedicated pooled connection, aborting via SQLite's
  `interrupt()` if it is still running at `deadline` (by default
  `*query-timeout-ms*` from now). Returns `(f conn)`'s value, or throws a 408
  `ex-info` on timeout. Any other SQL error propagates as its cause.

  A `db` that is already a connection (a query inside a batch, whose
  transaction it is) is used as it is and left open, so the query reads what
  the batch's earlier operations wrote, as any read in a batch does."
  ([db f] (run-bounded db f (deadline-from-now)))
  ([db f deadline]
   (if (instance? java.sql.Connection db)
     (run-on-connection db f deadline)
     (with-open [conn (connection-by db deadline)]
       (run-on-connection conn f deadline)))))

;; --- The heavy-query queue ------------------------------------------------
;; A counting query (an aggregate, or `return count`) walks everything its
;; scope matches: igt's project-wide suggestion counts take 4 to 8 s each on a
;; corpus of 374k words, and each holds one of the pool's connections for its
;; whole run. Four people opening a document at once started twelve of them,
;; and a 5 ms request for a project's name waited 11.6 s for a connection. So
;; at most `heavy-query-permits` run at once and the rest wait their turn
;; here, BEFORE taking a connection, which leaves the rest of the pool to
;; ordinary reads and saves. The queued ones finish no later than they would
;; have: twelve CPU-bound scans of one SQLite file do not run faster side by
;; side.

(def ^:private heavy-query-permits 3)

(defonce ^:private ^java.util.concurrent.Semaphore heavy-queries
  ;; fair, so a query waits behind the ones that arrived before it
  (java.util.concurrent.Semaphore. heavy-query-permits true))

(def ^:dynamic *heavy-query-wait-ms*
  "The longest a counting query waits for its turn before the server gives up
  on it with a 503. The wait counts against the query's own deadline
  (`*query-timeout-ms*`), so it is never longer than what is left of that.
  Dynamic so tests can shorten it."
  30000)

(defn- run-heavy
  "`run-bounded`, after waiting for one of the `heavy-query-permits`. A query
  that does not get one within `*heavy-query-wait-ms*`, or before its
  `deadline`, is refused with 503. The clients do not retry a query's 503: the
  queue is full, and the person is told the server is busy."
  ([db f] (run-heavy db f (deadline-from-now)))
  ([db f deadline]
   (cond
     ;; On a transaction's connection the query takes no pooled connection,
     ;; and only one transaction writes at a time. Waiting for a turn here
     ;; would hold the write lock for the wait.
     (instance? java.sql.Connection db)
     (run-bounded db f deadline)

     (.tryAcquire heavy-queries (long (min *heavy-query-wait-ms* (ms-left deadline)))
                  java.util.concurrent.TimeUnit/MILLISECONDS)
     (try
       (run-bounded db f deadline)
       (finally (.release heavy-queries)))

     :else
     (throw (ex-info "The server is busy with other large queries. Try again in a moment."
                     {:code 503 :query-error/stage :queue})))))

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
        ;; a key that depends only on another group key is read once per group
        ;; here, and does not take part in the grouping
        deferred (:deferred-group plan)
        group-selects (mapv (fn [c] (if-let [e (get deferred c)] [e c] c)) group-cols)
        grouping (vec (remove #(contains? deferred %) group-cols))
        agg-selects (map-indexed
                     (fn [j {:keys [op col]}]
                       [(if (= op :count) :%count.* [op col]) (keyword (str "__c_" j))])
                     (:aggs plan))
        read-kws (into (vec group-cols) (map second agg-selects))
        labels (into (vec (:group-labels plan)) (map :label (:aggs plan)))
        hq (cond-> {:select (into group-selects agg-selects)
                    :from [[inner qc/aggregate-alias]]
                    :limit limit}
             (seq grouping) (assoc :group-by grouping))]
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

(declare run-query)

(defn run
  "Execute a query. `raw` is the (JSON- or EDN-dialect) request body. See
  `run-query` for the result envelope.

  On a transaction's connection (a query inside a batch) the query is held to
  `*in-transaction-query-timeout-ms*`, since the transaction holds the write
  lock while it runs, and the batch it overruns is refused with the 408."
  [db user-id raw]
  (if (instance? java.sql.Connection db)
    (binding [*in-transaction?* true
              *query-timeout-ms* (min *query-timeout-ms* *in-transaction-query-timeout-ms*)]
      (run-query db user-id raw))
    (run-query db user-id raw)))

(defn- run-query
  "Execute a query. `raw` is the (JSON- or EDN-dialect) request body. Returns a
  result envelope:
    {:return :ids|:entities  :columns [...] :results [[...] ...] :count N
     :truncated bool}
  or, for `:return :count`,  {:return :count :count N}."
  [db user-id raw]
  (let [deadline (deadline-from-now)
        branches (ast/expand raw)
        head (first branches)
        find-vars (:find head)
        return-type (:return head)
        cols (find-cols find-vars)
        col-kws (mapv keyword cols)
        ;; exec owns the limit policy: compile every branch without its own
        ;; :limit, then apply the effective limit once at assembly.
        hqs (mapv (fn [b] (qc/compile-query (qr/resolve-query db user-id (dissoc b :limit)))) branches)]
    (cond
      (clauses/aggregate? head)
      (let [plan (qc/aggregate-plan (first hqs))
            lim (min (or (:limit head) agg-group-cap) agg-group-cap)
            {:keys [hq read-kws labels]} (aggregate-query hqs plan (inc lim))
            rows (run-heavy db (fn [conn] (psc/q conn hq)) deadline)
            truncated? (> (count rows) lim)
            rows (vec (take lim rows))]
        {:return :aggregate
         :columns labels
         :results (mapv (fn [r] (mapv #(get r %) read-kws)) rows)
         :count (count rows)
         :truncated truncated?})

      (= return-type :count)
      (let [n (:n (run-heavy db (fn [conn] (psc/q1 conn (count-query hqs))) deadline))]
        {:return :count
         :count (min n count-cap)
         :truncated (> n count-cap)})

      :else
      (let [lim (effective-limit (:limit head))
            order (qc/order-directive (first hqs))
            ;; fetch one extra row to detect truncation, then trim
            rows (run-bounded db (fn [conn]
                                   (psc/q conn
                                          (assemble hqs (inc lim) order)
                                          {:uuid-cols (set col-kws)}))
                              deadline)
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
