(ns plaid.history.core
  "XTDB v2 history replica — read-only time-travel store fed by an in-process
  tailer from the OLTP `audit_writes` table.

  Anti-features (DO NOT add):
  - No arbitrary search / filter / aggregation
  - No write API exposed beyond the tailer
  - No bulk export / cross-document joins
  - No historical-ACL reads (permissions are checked against current OLTP state)
  - No XTQL / SQL passthrough to REST clients
  - No span-at-ts / token-at-ts (only document-scoped reads)

  Time travel uses XTDB v2's bitemporal `:system-time` axis. The tailer
  writes each audit row at `:system-time = op.ts`, so a query with
  `{:snapshot-time ts}` returns the state as it was committed at `ts`.

  Error-type taxonomy (ex-info `:type` keys across the history namespaces,
  and how the REST layer maps each):
    :history/not-caught-up   — read ts is past the tailer cursor.   → 425
    :history/stalled         — tailer halted on a bad row.          → 503
    :history/read-timeout    — history read exceeded its deadline.     → 503
    :history/invalid-timestamp — a ts coercer hit nil/garbage. On the apply
                              path the tailer loop catches it (→ stall);
                              on the read path it falls through to the
                              503 default in `wrap-route-as-of`.
    (history disabled / node not started are returned directly as 503 by
     `wrap-route-as-of` without an ex-info.)
    :replayer/malformed-row    — an audit row the replayer can't
                                 translate (carries :op-id + :seq so the
                                 stall record names the offending row).
    :tailer/cursor-not-advanced — XTDB silently dropped the apply tx.
    :tailer/op-too-large        — one op's audit rows exceed the batch cap.
    :tailer/pruned-audit-log    — cold rebuild refused: the audit log was
                                  pruned (see audit_retention), so replay
                                  would produce partial documents.
    :tailer/not-enabled         — resume! called with history disabled.
  The `:replayer/*` and `:tailer/*` types are caught by the tailer loop
  (→ stall), never surfaced to REST callers directly."
  (:require [clojure.core.async :as async]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [mount.core :refer [defstate]]
            [plaid.server.config :refer [config]]
            [plaid.sql.common :as psc]
            [taoensso.timbre :as log]
            [xtdb.api :as xt]
            [xtdb.node :as xtn])
  (:import (java.time Instant)))

;; ============================================================
;; Config
;; ============================================================

(def ^:private default-config
  {:enabled? false
   :storage-path "data/history-storage"
   :log-path "data/history-log"
   :cold-replay-on-empty? true
   ;; `:poll-interval-ms` is the tailer's heartbeat — the upper bound
   ;; on apply latency when the commit-side nudge is unavailable
   ;; (REPL writes, schema/admin paths that bypass submit-operation*,
   ;; or any future producer that forgets the nudge). The nudge from
   ;; `submit-operation*` drives normal operation, so the heartbeat
   ;; can be loose; 5s trades a small worst-case staleness for
   ;; significantly less idle wakeup overhead than the prior 1s.
   :tailer {:poll-interval-ms 5000
            :batch-size 500
            :max-lag-warn-ms 60000
            :max-disk-warn-mb 5000}})

(defn history-config
  "Resolve the merged :plaid.history/config map, applying defaults for any
   keys the operator didn't set."
  []
  (let [user-cfg (get config :plaid.history/config {})
        ;; Shallow merge for top-level, then deep-merge the :tailer submap.
        merged (merge default-config user-cfg)]
    (assoc merged :tailer (merge (:tailer default-config)
                                 (:tailer user-cfg)))))

(defn enabled?
  "True if the operator has opted into the history replica."
  []
  (boolean (:enabled? (history-config))))

;; ============================================================
;; Commit-nudge channel
;; ============================================================
;;
;; Lives at the namespace level (defonce, not defstate) so producers
;; — notably `plaid.sql.operation/submit-operation*` — can publish
;; without ordering against mount lifecycle. The tailer consumes from
;; here in its alts! loop.

(defonce nudge-chan
  ;; dropping-buffer 1: this channel is a wakeup signal, not work
  ;; content. Under burst load multiple commits coalesce into a single
  ;; pending nudge — the tailer will drain audit_writes anyway, no
  ;; benefit to queuing N wakeups for N commits.
  (async/chan (async/dropping-buffer 1)))

(defn nudge!
  "Wake the tailer immediately rather than waiting for the next heartbeat
   interval. Non-blocking; safe to call from any thread including inside
   a SQL tx. No-op when history is disabled."
  []
  (when (enabled?)
    (async/put! nudge-chan :nudge)))

;; ============================================================
;; Node lifecycle
;; ============================================================

(defn- ensure-dirs! [{:keys [storage-path log-path]}]
  ;; XTDB wants these to already exist as directories on node start;
  ;; create them (mkdirs is a no-op if they're already there).
  (.mkdirs (io/file storage-path))
  (.mkdirs (io/file log-path)))

(defn- start-xtdb-node
  "Start an in-process XTDB v2 node with persistent local storage.

   pgwire + Flight SQL servers are left at their defaults — XTDB v2.2's
   `xt/submit-tx` and `xt/q` route through a JDBC connection, and disabling
   pgwire breaks them. Both bind to random localhost ports; the followup
   to pin them (or move history to a separate process) is tracked in the
   plan's open questions."
  [{:keys [storage-path log-path] :as cfg}]
  (ensure-dirs! cfg)
  (xtn/start-node
   {:storage [:local {:path storage-path}]
    :log [:local {:path log-path}]}))

(defstate node
  :start (let [cfg (history-config)]
           (if (:enabled? cfg)
             (do
               (log/info "Starting history XTDB node:" (select-keys cfg [:storage-path :log-path]))
               (start-xtdb-node cfg))
             (do
               (log/info "history disabled (:plaid.history/config :enabled? = false); skipping XTDB node")
               nil)))
  :stop (when node
          (log/info "Closing history XTDB node")
          (.close ^java.lang.AutoCloseable node)))

;; ============================================================
;; Cursor (persisted as an :history/meta doc)
;; ============================================================
;;
;; The cursor lives inside XTDB itself so its advance is atomic with the
;; corresponding op apply (one xt/submit-tx writes both). On startup, if
;; absent, the tailer seeds it to the epoch and replays from the start
;; of audit_writes (see plaid.history.tailer).

(def cursor-id :cursor)

;; ------------------------------------------------------------------
;; Stale-cached-plan retry
;;
;; XTDB caches prepared query plans, baking in a RESULT TYPE per projected
;; column. An :history/* table's projected types evolve as data lands — a column
;; that was nil-stripped (e.g. `stall-reason`) first appears, cold-start columns
;; populate, an annotation gives `value` a new type — and a cached plan is then
;; invalidated with a `:prepared-query-out-of-date` conflict ("cached plan must
;; not change result type"). That is XTDB's signal to re-prepare: simply re-run
;; and it re-plans against the current schema. Without this, `cursor-read` (and
;; the document reads) can throw on the first schema shift — the root of an
;; intermittent history test failure AND a latent production hazard on the first
;; real tailer stall or a column's first type change.

(defn- prepared-query-out-of-date?
  "True if `e` (or any cause) is XTDB's stale-cached-plan conflict."
  [e]
  (boolean
   (loop [e e]
     (when e
       (or (= :prepared-query-out-of-date (:xtdb.error/code (ex-data e)))
           (some-> (ex-message e) (str/includes? "cached plan must not change result type"))
           (recur (.getCause e)))))))

(defn plan-retrying
  "Run XTDB read thunk `f`, retrying up to `max-retries` times on the
   `:prepared-query-out-of-date` conflict (re-running re-prepares the plan).
   Any other throwable propagates unchanged."
  [max-retries f]
  (loop [attempt 0]
    (let [result (try {:value (f)}
                      (catch Exception e
                        (if (and (< attempt max-retries) (prepared-query-out-of-date? e))
                          (do (log/debug "history cached plan out of date — re-planning (attempt"
                                         (inc attempt) "of" max-retries ")")
                              ::retry)
                          (throw e))))]
      (if (= result ::retry)
        (recur (inc attempt))
        (:value result)))))

(defn cursor-read
  "Read the history tailer's cursor. Returns nil if no cursor has been
   written yet (cold-start case)."
  [node]
  (plan-retrying 3
                 (fn []
                   (first
                    (xt/q node
                          '(-> (from :history/meta [{:xt/id id}
                                                    last-op-ts last-op-id last-seq
                                                    tailer-status stall-reason])
                               (where (= id :cursor))))))))

(defn cursor->tx-op
  "Build a `[:put-docs :history/meta {:xt/id :cursor ...}]` tx-op carrying
   the supplied cursor fields. Pass to xt/submit-tx in the same vector
   as the op's other tx-ops so the cursor advance is atomic with the
   apply."
  [{:keys [last-op-ts last-op-id last-seq tailer-status stall-reason]
    :or {tailer-status :running stall-reason nil}}]
  [:put-docs :history/meta
   {:xt/id cursor-id
    :last-op-ts last-op-ts
    :last-op-id last-op-id
    :last-seq last-seq
    :tailer-status tailer-status
    :stall-reason stall-reason}])

(declare ->instant ->date)

;; ------------------------------------------------------------------
;; System-time discipline for cursor-only writes
;;
;; The node's system-time axis IS the history: a tx submitted without an
;; explicit :system-time commits at wall-clock now, jumping the head past
;; every not-yet-applied backlog op. The tailer's monotonic guard then
;; force-advances the whole backlog onto a wall-clock millisecond ramp —
;; as-of reads inside that window silently return the wrong state (200s
;; and 404s instead of 425s). That corruption was produced by the
;; RECOVERY procedure itself (set-stalled!/set-running!/resume!), so
;; every cursor-only write below pins :system-time to the current head
;; instead (XTDB accepts equal explicit system-time; only strictly-older
;; is rejected).
;;
;; The head must be read from authoritative state: query-visible
;; (indexed) state lags the durable log at node startup, and XTDB's
;; validator compares a submitted :system-time against the LOG head — a
;; watermark derived from the lagging index gets rejected as
;; strictly-older (the startup self-stall bug). `index-lag` /
;; `await-index-caught-up!` exist so every head consumer waits for
;; processed == submitted first.

(defn index-lag
  "How far the node's indexer is behind its durable log, per `xt/status`.
   Returns {:submitted N :processed N :caught-up? bool}. A fresh node with
   no txs reports caught-up."
  [node]
  (let [st (xt/status node)
        sub (some-> st :latest-submitted-msg-ids (clojure.core/get "xtdb") first long)
        proc (some-> st :latest-processed-msg-ids (clojure.core/get "xtdb") first long)]
    {:submitted sub
     :processed proc
     :caught-up? (or (nil? sub) (and (some? proc) (>= proc sub)))}))

(defn head-system-time
  "System-time of the node's latest completed (indexed) tx, as an Instant.
   Nil on a node with no completed txs. Only authoritative as the node's
   true head when the indexer is caught up to the durable log — call
   `await-index-caught-up!` first."
  ^Instant [node]
  (some-> (xt/status node)
          :latest-completed-txs
          (clojure.core/get "xtdb")
          first
          :system-time
          ->instant))

(defn await-index-caught-up!
  "Block until the node's indexer has processed every durable-log entry
   (processed msg-id >= submitted msg-id). Returns true when caught up.
   With :timeout-ms, throws :history/index-catch-up-timeout on expiry;
   without, waits indefinitely. Logs progress every ~10s so a long
   startup log replay is visible rather than a silent hang."
  ([node] (await-index-caught-up! node {}))
  ([node {:keys [timeout-ms poll-ms] :or {poll-ms 100}}]
   (let [deadline (when timeout-ms (+ (System/currentTimeMillis) timeout-ms))
         started (System/currentTimeMillis)]
     (loop [last-logged started]
       (let [{:keys [submitted processed caught-up?]} (index-lag node)]
         (cond
           caught-up? true

           (and deadline (>= (System/currentTimeMillis) deadline))
           (throw (ex-info (str "history node indexer did not catch up to its log within "
                                timeout-ms "ms (processed=" processed
                                ", submitted=" submitted ")")
                           {:type :history/index-catch-up-timeout
                            :submitted submitted
                            :processed processed
                            :timeout-ms timeout-ms}))

           :else
           (let [now (System/currentTimeMillis)
                 log? (>= (- now last-logged) 10000)]
             (when log?
               (log/info "history node index catching up to durable log:"
                         {:processed processed :submitted submitted
                          :waited-ms (- now started)}))
             (async/<!! (async/timeout poll-ms))
             (recur (if log? now last-logged)))))))))

(defn cursor-write-tx-opts
  "Tx opts for a cursor-only (operator/bookkeeping) write: :system-time
   pinned to the current head so the write never advances the node's
   system-time axis past unapplied backlog ops. Waits (bounded) for the
   indexer first so the head is authoritative; EPOCH on a node with no
   txs yet (any later op ts only moves forward from there).

   The head is passed as an EXACT Instant, never through ->date:
   java.util.Date is millisecond-precision, and a head written at wall
   clock carries microseconds (any tx committed without an explicit
   :system-time — e.g. legacy cursor writes from before this fn
   existed). Truncating such a head to the millisecond floor made the
   'equal' write strictly OLDER than the head and XTDB rejected it —
   observed live as a startup pre-pass failure ('specified system-time
   older than current tx' with head ...792983Z vs submitted ...792Z).
   XTDB accepts Instant for :system-time, and equal-at-µs is accepted
   (REPL-verified)."
  [node]
  (await-index-caught-up! node {:timeout-ms 60000})
  {:system-time (or (head-system-time node) Instant/EPOCH)})

(defn set-stalled!
  "Halt the tailer by writing :tailer-status :stalled into the cursor doc.
   Called by the tailer when it hits a malformed audit row; operator
   resumes via plaid.history.tailer/resume! once the upstream bug is fixed."
  [node {:keys [op-id seq reason]}]
  (let [cur (or (cursor-read node) {})
        next-cur (assoc cur
                        :tailer-status :stalled
                        :stall-reason (str reason
                                           " (at op-id=" op-id ", seq=" seq ")"))]
    (xt/execute-tx node [(cursor->tx-op next-cur)] (cursor-write-tx-opts node))
    next-cur))

(defn set-running!
  "Clear the stall flag on the cursor (operator-driven via REPL)."
  [node]
  (let [cur (or (cursor-read node) {})
        next-cur (assoc cur :tailer-status :running :stall-reason nil)]
    (xt/execute-tx node [(cursor->tx-op next-cur)] (cursor-write-tx-opts node))
    next-cur))

;; ============================================================
;; Misc helpers
;; ============================================================

;; ============================================================
;; Timestamp coercion (shared)
;; ============================================================
;;
;; The replayer and tailer both shuttle op timestamps between three
;; representations: ISO strings (from SQLite `operations.ts`),
;; java.util.Date (XTDB `:system-time` arg), and java.time.Instant
;; (comparisons). XTDB also round-trips a written Date back as a
;; ZonedDateTime. These three coercers are the ONE place that handles
;; the full matrix — previously duplicated as replayer/coerce-op-ts +
;; op-ts->iso and tailer/ts->date + ts->instant.

(defn ^Instant ->instant
  "Coerce a value to java.time.Instant. Accepts Instant, ISO-8601 string,
   java.util.Date, or java.time.ZonedDateTime. ZonedDateTime appears when
   XTDB v2 round-trips a `java.util.Date` we wrote to a column —
   `cursor-instant` (in history.document) calls this on `:last-op-ts`, so a
   future replayer/tailer change that stores Date there must not break the
   staleness guard."
  [x]
  (cond
    (instance? Instant x) x
    (string? x) (Instant/parse x)
    (instance? java.util.Date x) (.toInstant ^java.util.Date x)
    (instance? java.time.ZonedDateTime x) (.toInstant ^java.time.ZonedDateTime x)
    ;; Typed (not bare) so a nil/garbage ts produces a named, mappable
    ;; failure instead of an opaque "Cannot coerce" that the tailer's
    ;; catch-all turns into an unidentifiable stall. :history/invalid-timestamp
    ;; is caught by the tailer loop (→ stall) and mapped to 503 on the read
    ;; path — see this ns's error-taxonomy docstring.
    :else (throw (ex-info (str "Cannot coerce to Instant: "
                               (if (nil? x) "nil" (.getName (class x))))
                          {:type :history/invalid-timestamp :value x}))))

(defn ^java.util.Date ->date
  "Coerce any supported ts representation to java.util.Date (XTDB
   `:system-time` wants a Date)."
  [x]
  (java.util.Date/from (->instant x)))

(defn ^String ->iso-string
  "Coerce any supported ts representation to a canonical fixed-width
   ISO-8601 string (the 9-digit form `now-iso`/`instant->iso` produce).

   Strings are re-parsed and reformatted, NOT passed through: passthrough
   trusted that every string was already canonical width, but that's an
   unenforced cross-table assumption. Normalizing here guarantees a
   non-canonical-width value can never reach the cursor's `:last-op-ts`
   and silently break the lexicographic keyset against `operations.ts`
   (which would skip or re-apply rows). The parse/format cost is trivial
   — this runs on cursor writes and staleness checks, not a hot loop."
  [x]
  (psc/instant->iso (->instant x)))

(defn disk-bytes
  "Sum of file sizes under the history storage + log paths (best-effort).
   Used by the /health endpoint to surface disk usage."
  []
  (let [{:keys [storage-path log-path]} (history-config)]
    (->> [storage-path log-path]
         (mapcat (fn [p] (when-let [d (io/file p)]
                           (file-seq d))))
         (filter #(.isFile ^java.io.File %))
         (map #(.length ^java.io.File %))
         (reduce + 0))))

;; ============================================================
;; Lag accounting (shared)
;; ============================================================
;;
;; The tailer's status snapshot and the /health endpoint both need to
;; know how far behind the history is. These live HERE (one copy) rather
;; than duplicated in plaid.history.tailer + plaid.server.middleware, so a
;; schema change (rename a column, add a lex key) can't make the two
;; surfaces silently disagree.

(defn- cursor-gt-where
  "HoneySQL WHERE selecting audit_writes ⋈ operations rows whose
  `(o.ts, o.id)` tuple is strictly greater than the cursor. Two-clause
  form because HoneySQL has no portable row-tuple comparison."
  [cursor-ts cursor-op-id]
  [:or
   [:> :o.ts cursor-ts]
   [:and [:= :o.ts cursor-ts] [:> :o.id cursor-op-id]]])

(defn lag-rows
  "Count audit_writes rows past the cursor — i.e. not yet replicated to
  history. A nil cursor (cold start) means everything is unreplicated."
  [ds cursor-ts cursor-op-id]
  (-> (if (or (nil? cursor-ts) (nil? cursor-op-id))
        (psc/q1 ds {:select [[[:count :*] :n]] :from [:audit_writes]})
        (psc/q1 ds {:select [[[:count :*] :n]]
                    :from [[:audit_writes :aw]]
                    :join [[:operations :o] [:= :aw.op_id :o.id]]
                    :where (cursor-gt-where cursor-ts cursor-op-id)}))
      :n
      (or 0)))

(defn max-unreplicated-op-ts
  "ISO-8601 string of the latest `operations.ts` past the cursor — the
  OLTP high-water mark the tailer hasn't consumed. nil when caught up or
  the audit log is empty. Distinct from cursor age: this is the TRUE lag
  (op-ts gap), zero when caught up regardless of how long the OLTP has
  been idle."
  [ds cursor-ts cursor-op-id]
  (:max_ts
   (if (or (nil? cursor-ts) (nil? cursor-op-id))
     (psc/q1 ds {:select [[[:max :ts] :max_ts]] :from [:operations]})
     (psc/q1 ds {:select [[[:max :o.ts] :max_ts]]
                 :from [[:audit_writes :aw]]
                 :join [[:operations :o] [:= :aw.op_id :o.id]]
                 :where (cursor-gt-where cursor-ts cursor-op-id)}))))
