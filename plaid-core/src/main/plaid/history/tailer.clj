(ns plaid.history.tailer
  "Background ETL loop that drains `audit_writes` from the OLTP SQLite
  datasource and applies the operations to the XTDB v2 history node via
  `plaid.history.replayer/apply-op!`.

  Mount lifecycle:
    :start — when `(history/enabled?)` is true, spawns a `core.async` go-
             loop that consumes `plaid.history.core/nudge-chan` (woken
             from `submit-operation*` on commit) and falls back to a
             heartbeat timeout of `:poll-interval-ms` as a safety net.
             When history is disabled, :start is a no-op (the var holds nil).
    :stop  — signals the loop via `stop-chan` and waits for it to
             complete its current iteration.

  Monotonic-system-time contract:
  XTDB v2.2.0-beta1 silently drops `xt/submit-tx` calls whose
  `:system-time` is earlier than the latest tx already in the node.
  The tailer enforces non-decreasing :system-time across submit-tx
  calls in two ways:
    1. Before applying an op, compute the latest `:xt/system-from`
       across `:history/meta` rows. If `op.ts < latest + 1ms`, advance
       the apply's effective system-time to `latest + 1ms` and warn.
       Real OLTP write order should never trigger this — operations
       are stamped server-side and `ts` is monotonic for ordinary
       traffic — but clock skew or retroactive backfill could.
    2. After the submit, verify the cursor doc actually advanced
       (XTDB returns `{:tx-id n}` even for dropped writes; we can't
       trust the return). If the cursor didn't move, we stall.

  Batch-trailing-op trick:
  We `LIMIT batch-size + 1` and drop the trailing op-group if it's the
  same op_id as the very last row, so we never apply a partial op
  whose remaining rows would land in the next batch.

  Stall semantics:
  A STRUCTURAL throw (malformed/uncoercible audit row, op-too-large,
  cursor-not-advanced) sets `:tailer-status :stalled` on the cursor doc
  and stops the loop. The thread exits cleanly (it doesn't spin).
  Operators resume via `(resume!)` — optionally with
  `:skip-current-row? true` to write a synthetic cursor advance past
  the offending row.

  A TRANSIENT throw — a SQLITE_BUSY / locked error from the audit-log
  read under contention — does NOT stall. It can only come from the
  read side (`fetch-batch`); the apply path writes to the XTDB history
  node, never SQLite, so the cursor hasn't moved and nothing partial
  landed. The loop logs a warning, backs off one poll interval, and
  retries the same cursor. `busy_timeout` on the shared pool absorbs
  ordinary contention; this handles the rare case where it outlasts the
  timeout. See `transient-db-error?`."
  (:require [clojure.core.async :as async]
            [honey.sql :as sql]
            [mount.core :refer [defstate]]
            [next.jdbc :as jdbc]
            [next.jdbc.result-set :as rs]
            [plaid.history.core :as history]
            [plaid.history.replayer :as replayer]
            [plaid.server.sql :refer [datasource]]
            [plaid.sql.common :as psc]
            [taoensso.timbre :as log]
            [xtdb.api :as xt])
  (:import (java.time Instant)
           (java.util Date)))

;; ============================================================
;; Loop control
;; ============================================================
;;
;; All three vars are reset on :stop so a subsequent :start gets a
;; clean slate (mount restart in tests; production REPL workflows).

(defonce ^:private stop-chan (atom nil))
(defonce ^:private done-chan (atom nil))
(defonce ^:private last-status (atom {:running? false :cursor nil :lag-rows 0}))

;; Replay-progress counter: total rows applied since this loop instance
;; started. The cold-replay milestone log fires every 50k applied rows
;; (and once when the lag-rows count first reaches zero from non-zero).
;; Reset on :stop / new run-loop! so a restart re-emits the cold-replay
;; cadence for a fresh catch-up.
(defonce ^:private rows-applied-since-start (atom 0))
(defonce ^:private was-lagging? (atom false))
(def ^:private cold-replay-log-stride
  "How often to log a progress milestone during long replay. The design
  doc promised 50000; matched here so the docs/behavior agree."
  50000)
(defonce ^:private last-progress-logged-at (atom 0))

;; Warn-rate-limit: `:max-lag-warn-ms` / `:max-disk-warn-mb` checks
;; can fire on every poll once tripped, so each one is gated by a
;; "last warned" timestamp atom that throttles to once per minute.
;; The atoms are loop-instance-scoped (cleared on :stop) so a restart
;; that retrips the threshold logs again immediately rather than
;; waiting out the prior loop's cooldown.
(def ^:private warn-cooldown-ms 60000)
(defonce ^:private last-lag-warn-at (atom 0))
(defonce ^:private last-disk-warn-at (atom 0))
;; Disk-bytes is more expensive to compute (file-seq + .length per file)
;; than the lag check, so skip it most polls and only sample once per
;; `disk-check-stride` heartbeat iterations.
;;
;; 12 polls = ~60s at the default 5000ms heartbeat — frequent enough that
;; a runaway storage-growth incident is noticed within a minute, but rare
;; enough that the file-seq walk doesn't dominate idle CPU on a
;; multi-GB store. The warn itself is further rate-limited (one per
;; minute), so a higher stride would just delay first detection without
;; reducing log volume.
(def ^:private disk-check-stride 12)
(defonce ^:private poll-counter (atom 0))

(def ^:private epoch-iso
  "Cold-start lower bound. The where clause becomes `(o.ts >= epoch)`,
  so we drain every row in audit_writes."
  "1970-01-01T00:00:00Z")

;; ============================================================
;; SQL helpers
;; ============================================================

(def ^:private select-cols
  "Columns we pull on the batch query. `:aw.*` carries everything the
  replayer needs from audit_writes (id, op_id, seq, target_table,
  target_id, change_type, pre_image, post_image, ts). Operations
  columns are explicitly aliased — `:ts` would otherwise clash with
  audit_writes.ts under JDBC's unqualified-keys reader, and we need
  BOTH (audit_writes.ts for downstream parity, operations.ts as the
  cursor / system-time)."
  [:aw.* [:o.ts :op_ts]
   [:o.id :op_id_full] [:o.user_id :op_user_id]
   [:o.op_type :op_type]
   [:o.project_id :op_project_id] [:o.document_id :op_document_id]
   [:o.description :op_description] [:o.batch_id :op_batch_id]])

(defn- fetch-batch
  "Run the keyset-paged JOIN query and return a vector of audit rows
  enriched with op columns. Each row is a column-keyed map (JDBC
  unqualified-keys builder).

  `cursor-ts` / `cursor-op-id` form a lex tuple — rows with
  `(op.ts, op.id) > cursor` come back. On cold start (`cursor-op-id`
  nil) we use the simpler `o.ts >= epoch` form so the first row in
  the table is included.

  Asks for `batch-size + 1` rows so a partial op-group can be
  truncated at the call site (see `drop-trailing-partial`). When
  `batch-size` is nil the query is unbounded — used by
  `fetch-batch-with-grow` as the last-resort attempt for an op whose
  audit rows exceed any finite batch ceiling."
  [ds cursor-ts cursor-op-id batch-size]
  (let [where (if (or (nil? cursor-op-id) (= cursor-ts epoch-iso))
                [:>= :o.ts cursor-ts]
                [:or
                 [:> :o.ts cursor-ts]
                 [:and [:= :o.ts cursor-ts] [:> :o.id cursor-op-id]]])
        q (cond-> {:select select-cols
                   :from [[:audit_writes :aw]]
                   :join [[:operations :o] [:= :aw.op_id :o.id]]
                   :where where
                   :order-by [:o.ts :o.id :aw.seq]}
            batch-size (assoc :limit (inc batch-size)))
        sql-vec (sql/format q)]
    (jdbc/execute! ds sql-vec {:builder-fn rs/as-unqualified-maps})))

(defn- drop-trailing-partial
  "If the batch came back at `(inc batch-size)` rows AND its trailing
  op-group sits at the boundary, drop the entire trailing group so we
  never apply a partial op. The remaining rows will come back on the
  next iteration alongside the rest of their op."
  [rows batch-size]
  (if (<= (count rows) batch-size)
    rows
    (let [last-op-id (:op_id (last rows))]
      (vec (take-while #(not= (:op_id %) last-op-id) rows)))))

(def fetch-grow-multipliers
  "Successive LIMIT multipliers applied when a single op exceeds the
  configured batch-size. We escalate rather than going unbounded
  immediately because the common case (no oversized op) keeps the cheap
  path; only when `drop-trailing-partial` collapses to zero do we pay a
  wider scan. `bulk-create` of tens of thousands of tokens/spans would
  trip this on the first attempt.

  The last entry (1024) is a sanity cap — at the default batch-size of
  500 that's 512000 rows, more than enough for any plausible single op.
  An unbounded LIMIT here would pull the entire pending audit tail into
  the JVM heap on a pathological 10M-row write (e.g. a runaway client),
  silently OOM-ing the tailer thread. Past the cap we stall and let an
  operator decide rather than risk the heap.

  Public (not ^:private) so the cap-hit branch can be exercised in tests
  via with-redefs; production code uses it only through this ns."
  [4 16 1024])

(defn- fetch-batch-with-grow
  "Wrap `fetch-batch` + `drop-trailing-partial` so that an op whose audit
  rows exceed `batch-size` doesn't stall the tailer. When the trimmed
  batch is empty AND the raw batch hit the (inc batch-size) ceiling, the
  whole window belongs to one op — re-fetch from the same cursor with a
  larger LIMIT until the op fits. After the final multiplier still
  returns zero rows, throw `:tailer/op-too-large` so the run-loop stalls
  rather than escalate to an unbounded scan (heap-OOM risk)."
  [ds cursor-ts cursor-op-id batch-size]
  (let [raw (fetch-batch ds cursor-ts cursor-op-id batch-size)
        rows (drop-trailing-partial raw batch-size)]
    (if (or (seq rows) (<= (count raw) batch-size))
      rows
      (loop [mults fetch-grow-multipliers]
        (if-let [m (first mults)]
          (let [bigger (* batch-size (long m))
                raw2 (fetch-batch ds cursor-ts cursor-op-id bigger)
                rows2 (drop-trailing-partial raw2 bigger)]
            (if (seq rows2)
              rows2
              (recur (next mults))))
          ;; All multipliers exhausted: a single op's audit rows exceed
          ;; even the cap. Stall the tailer so an operator can inspect
          ;; rather than load arbitrarily many rows into the heap.
          (throw (ex-info "history tailer audit batch exceeded fetch cap (single op too large)"
                          {:type :tailer/op-too-large
                           :cursor-ts cursor-ts
                           :cursor-op-id cursor-op-id
                           :batch-size batch-size
                           :max-multiplier (last fetch-grow-multipliers)})))))))

(defn- op-record-from-row
  "Project an audit-row into the `op-record` shape `apply-op!` wants
  (`:op/id`, `:op/ts`, `:op/op-type`). All rows in a group share the
  same op, so we read off the first one."
  [row]
  {:op/id (:op_id_full row)
   :op/ts (:op_ts row)
   :op/op-type (some-> (:op_type row) keyword)})

;; ============================================================
;; Monotonic-system-time guard
;; ============================================================

(defn- latest-system-from
  "Return the most recent `:xt/system-from` across `:history/meta` rows
  (the cursor doc is the only meta entry today). Nil on a fresh node.

  We probe `:history/meta` rather than every entity table because the
  cursor is written on every apply-op! AND on every operator-driven
  cursor advance (`set-stalled!`, `set-running!`, `resume! :skip…?`)
  — it's the canonical high-water-mark on the history's system-time
  axis."
  ^Instant [node]
  (let [rows (history/plan-retrying
              3
              (fn []
                (xt/q node
                      '(-> (from :history/meta [{:xt/id id :xt/system-from sf}])
                           (where (= id :cursor))))))]
    (some-> rows first :sf history/->instant)))

(defn- guard-monotonic
  "Return a `:system-time` Date that is guaranteed non-decreasing
  relative to the node's current state. If `op-ts` is at or past
  `latest`, return op-ts unchanged. Otherwise log a warning and
  advance to `latest + 1ms`.

  Why strictly-before, not before-or-equal: XTDB v2.2.0-beta1 accepts
  multiple `xt/submit-tx` calls at the same `:system-time` — each gets a
  distinct tx-id and both are visible at `{:snapshot-time t}` (verified
  via REPL probe). Equal-ts is therefore safe and the extra millisecond
  nudge was noise that also exacerbated BUG-3's cursor-shape corruption."
  ^Date [^Date op-ts ^Instant latest]
  (if (or (nil? latest)
          (not (.isBefore (.toInstant op-ts) latest)))
    op-ts
    (let [advanced (.plusMillis latest 1)]
      (log/warn "history tailer advancing system-time"
                {:op-ts (.toString (.toInstant op-ts))
                 :latest-system-from (.toString latest)
                 :advanced-to (.toString advanced)})
      (Date/from advanced))))

;; ============================================================
;; Apply one op
;; ============================================================

(defn- apply-op-with-guard!
  "Call `replayer/apply-op!` after enforcing monotonic system-time and
  verify the cursor advanced afterwards. Throws ex-info on a dropped
  write so the caller stalls.

  When `guard-monotonic` advances the history system-time (clock skew,
  retroactive backfill), we pass the adjusted Date as `apply-op!`'s
  explicit `system-time` arg WITHOUT mutating `op-record`'s `:op/ts`.
  Otherwise the cursor's `:last-op-ts` would diverge from the OLTP
  `operations.ts` axis and subsequent ops whose `op.ts < adjusted`
  would be silently skipped by `fetch-batch`'s `WHERE (o.ts, o.id) >
  cursor` clause.

  Returns the new cursor doc (post-apply read) for status reporting."
  [node op-record audit-rows]
  (let [latest (latest-system-from node)
        original (try
                   (history/->date (:op/ts op-record))
                   (catch Exception e
                     ;; Re-throw with op context so a bad op.ts produces a
                     ;; stall record that NAMES the offending op rather than
                     ;; the coercer's contextless :value.
                     (throw (ex-info (str "history op has uncoercible ts: " (ex-message e))
                                     {:type :replayer/malformed-row
                                      :op-id (:op/id op-record)
                                      :seq (:seq (first audit-rows))}
                                     e))))
        adjusted (guard-monotonic original latest)]
    (if (= adjusted original)
      (replayer/apply-op! node op-record audit-rows)
      (replayer/apply-op! node op-record audit-rows adjusted))
    ;; Re-read the cursor immediately to confirm the write landed —
    ;; XTDB v2 returns {:tx-id n} for dropped writes too, so the
    ;; submit-tx return value can't be trusted.
    (let [cursor (history/cursor-read node)]
      (when (or (nil? cursor)
                (not= (:last-op-id cursor) (:op/id op-record)))
        (throw (ex-info "history submit-tx appears to have been dropped (cursor did not advance)"
                        {:type :tailer/cursor-not-advanced
                         :op-id (:op/id op-record)
                         :op-ts (:op/ts op-record)
                         :cursor-after cursor})))
      cursor)))

;; ============================================================
;; Lag accounting (mirrors plaid.server.middleware/lag-rows)
;; ============================================================

(def ^:private lag-rows
  "Count audit_writes rows past the cursor (status snapshot; not for the
  tight inner loop). Shared with /health via plaid.history.core."
  history/lag-rows)

;; ============================================================
;; Seed cursor on cold start
;; ============================================================

(defn- seed-cursor
  "Return the cursor we should start from when none has been written
  yet. Honors `:cold-replay-on-empty?`:
    - true (default): start at epoch, replay everything.
    - false: advance the cursor to just past the latest existing
             `operations.ts` without applying anything, so the tailer
             only tracks ops committed from this moment forward.

  BUG-12 note: a prior version seeded `:last-op-id` to the latest
  existing op's UUID. The `fetch-batch` where clause filters with
  `(o.ts, o.id) > cursor`, and op-ids are random UUIDs — so a new
  op committed at the SAME ts with a lex-lower UUID would silently
  skip past the cursor forever. The fix is to seed with
  `:last-op-id nil` and `:last-op-ts` set to one ms past the latest
  existing ts. `fetch-batch` then collapses to `o.ts >= cursor-ts`
  (no UUID comparison), so the random-UUID tie-break disappears and
  anything strictly newer than the snapshot moment is picked up."
  [ds cfg]
  (if (:cold-replay-on-empty? cfg)
    {:last-op-ts epoch-iso :last-op-id nil :last-seq -1}
    (let [latest (psc/q1 ds {:select [[[:max :ts] :max_ts]]
                             :from [:operations]})
          max-ts (:max_ts latest)]
      (if max-ts
        (let [bumped (-> (Instant/parse ^String max-ts)
                         (.plusMillis 1)
                         (.toString))]
          {:last-op-ts bumped :last-op-id nil :last-seq -1})
        {:last-op-ts epoch-iso :last-op-id nil :last-seq -1}))))

;; ============================================================
;; One pass of the loop
;; ============================================================

(defn- update-status! [ds node cursor]
  (let [lag (try (lag-rows ds (:last-op-ts cursor) (:last-op-id cursor))
                 (catch Throwable _ 0))]
    (reset! last-status {:running? (not= (:tailer-status cursor) :stalled)
                         :cursor cursor
                         :lag-rows lag})))

(defn- latest-audit-tuple
  "Snapshot the (op_ts, op_id, seq) of the last audit_writes row
  currently visible in OLTP. Returns nil if the table is empty."
  [ds]
  (psc/q1 ds {:select [[:o.ts :op_ts] [:o.id :op_id] [:aw.seq :seq]]
              :from [[:audit_writes :aw]]
              :join [[:operations :o] [:= :aw.op_id :o.id]]
              :order-by [[:o.ts :desc] [:o.id :desc] [:aw.seq :desc]]
              :limit 1}))

(defn- cursor-reached?
  "True when the tailer cursor has applied at least up to the snapshot
  tuple `target`. Comparison is on (last-op-ts, last-op-id, last-seq).
  Returns true if the cursor's tuple is `>=` target."
  [cursor target]
  (when (and cursor target)
    (let [cur-ts (str (:last-op-ts cursor))
          tgt-ts (str (:op_ts target))
          cur-id (str (:last-op-id cursor))
          tgt-id (str (:op_id target))
          cur-seq (long (or (:last-seq cursor) -1))
          tgt-seq (long (or (:seq target) -1))]
      (cond
        (pos? (compare cur-ts tgt-ts)) true
        (neg? (compare cur-ts tgt-ts)) false
        (pos? (compare cur-id tgt-id)) true
        (neg? (compare cur-id tgt-id)) false
        :else (>= cur-seq tgt-seq)))))

(defn await-drained!
  "Block (with timeout) until the tailer has applied every audit_writes
   row currently visible in OLTP. Returns true when caught up, false on
   timeout. Intended for tests + REPL.

   Implementation: snapshot the latest (op_ts, op_id, seq) tuple in
   audit_writes, then poll the history cursor every ~10ms until it has
   reached or passed that tuple. If the audit log is empty at snapshot
   time, returns true immediately."
  ([] (await-drained! 5000))
  ([timeout-ms]
   (await-drained! datasource history/node timeout-ms))
  ([ds node timeout-ms]
   (when-not node
     (throw (ex-info "history node is nil — is :enabled? true in :plaid.history/config?"
                     {:type :tailer/not-enabled})))
   (let [target (latest-audit-tuple ds)]
     (if (nil? target)
       true
       (let [deadline (+ (System/currentTimeMillis) timeout-ms)]
         (loop []
           (let [cursor (history/cursor-read node)]
             (cond
               (cursor-reached? cursor target) true
               (>= (System/currentTimeMillis) deadline) false
               :else
               (do
                 ;; Use a core.async timeout rather than Thread/sleep so
                 ;; the helper plays nicely with parking schedulers in
                 ;; tests that already use core.async elsewhere.
                 (async/<!! (async/timeout 10))
                 (recur))))))))))

(defn poll-once!
  "Run a single pass of the tailer loop. Visible for tests and the REPL
  `resume!` helper. Returns `{:applied-ops N :rows-consumed M :cursor c}`.
  Throws if `(history/enabled?)` is false — there's no node to apply
  against.

  NOT mutually-exclusive with the mounted go-loop: calling this from the
  REPL while the loop is running means two threads apply against the same
  node concurrently. It won't corrupt (writes are idempotent puts keyed by
  xt/id; each call re-reads the system-time high-water mark) but it wastes
  duplicate work. Prefer `resume!` (which won't spawn a second loop) over a
  bare `poll-once!` while the tailer is live."
  ([]
   (poll-once! datasource history/node))
  ([ds node]
   (when-not node
     (throw (ex-info "history node is nil — is :enabled? true in :plaid.history/config?"
                     {:type :tailer/not-enabled})))
   (let [cfg (history/history-config)
         batch-size (or (-> cfg :tailer :batch-size) 500)
         existing-cursor (history/cursor-read node)
         cursor (or existing-cursor (seed-cursor ds cfg))
         rows (fetch-batch-with-grow ds (:last-op-ts cursor)
                                     (:last-op-id cursor) batch-size)
         grouped (->> rows
                      (partition-by :op_id)
                      (mapv vec))
         applied (atom 0)
         final-cursor (atom cursor)]
     (doseq [op-rows grouped]
       (let [op-record (op-record-from-row (first op-rows))
             cur (apply-op-with-guard! node op-record op-rows)]
         (reset! final-cursor cur)
         (swap! applied inc)))
     ;; First-poll-on-quiet-OLTP case (M-pipeline-2): we have no
     ;; existing cursor and no ops to apply, so the apply loop above
     ;; never wrote one either. Persist the seed cursor explicitly so
     ;; health reads + staleness checks see a cursor instead of nil
     ;; forever. We only do this when the apply loop didn't already
     ;; write a cursor — otherwise we'd risk advancing system-time
     ;; ahead of pending replay rows and tripping guard-monotonic.
     (when (and (nil? existing-cursor) (zero? @applied))
       (xt/execute-tx node [(history/cursor->tx-op cursor)])
       (reset! final-cursor (or (history/cursor-read node) cursor)))
     (update-status! ds node @final-cursor)
     {:applied-ops @applied
      :rows-consumed (count rows)
      :cursor @final-cursor})))

;; ============================================================
;; Background go-loop
;; ============================================================

(defn- drain-nudges!
  "Non-blocking consume of any pending nudge tokens. The dropping-buffer-1
  channel coalesces N commits into at most one waiting nudge, but we
  still poll! once before each work cycle so a nudge that arrived
  mid-batch doesn't trigger a spurious extra wakeup after we've already
  caught up."
  [nudge]
  (loop []
    (when (async/poll! nudge)
      (recur))))

(defn- maybe-log-progress!
  "Emit an `:info` progress line during long replays. Fires every
  `cold-replay-log-stride` rows applied since this loop instance started
  — the design notes promised this cadence for
  cold-replay visibility, but the prior implementation never wired it.

  Cheap: a single atom CAS per call, plus a `quot` to decide whether
  this row crossed a stride boundary."
  [cursor rows-consumed]
  (when (pos? rows-consumed)
    (let [total (swap! rows-applied-since-start + rows-consumed)
          prev @last-progress-logged-at
          milestone (* cold-replay-log-stride (quot total cold-replay-log-stride))]
      (when (> milestone prev)
        (reset! last-progress-logged-at milestone)
        (log/info "history tailer replay progress"
                  {:rows-applied total
                   :cursor-ts (:last-op-ts cursor)
                   :cursor-op-id (str (:last-op-id cursor))})))))

(defn- maybe-log-caught-up!
  "First-edge log when the tailer transitions from lagging to caught-up
  (`lag-rows` 0 after being non-zero). Pairs with `maybe-log-progress!`
  to bracket a cold replay: stride logs while catching up, one
  \"caught up\" log when done."
  [cursor lag-rows-n]
  (cond
    (zero? lag-rows-n)
    (when @was-lagging?
      (reset! was-lagging? false)
      (log/info "history tailer caught up"
                {:cursor-ts (:last-op-ts cursor)
                 :cursor-op-id (str (:last-op-id cursor))}))
    :else (reset! was-lagging? true)))

(defn- now-ms ^long [] (System/currentTimeMillis))

(defn- warn-rate-limited!
  "Emit `(log/warn …)` if at least `warn-cooldown-ms` has elapsed since
  the last warn recorded in `last-at-atom`. Returns true if a warn was
  emitted; false otherwise. Used to throttle the dead-knob checks below
  so a tripped threshold doesn't spam the log on every poll."
  [last-at-atom msg data]
  (let [now (now-ms)
        prev @last-at-atom]
    (when (>= (- now prev) warn-cooldown-ms)
      (when (compare-and-set! last-at-atom prev now)
        (log/warn msg data)
        true))))

(defn- check-max-lag-warn!
  "Compute the current OLTP-history op-ts gap (true lag, not cursor age)
  and emit a rate-limited `:warn` when it exceeds `:max-lag-warn-ms`.
  Returns nil. No-op when the knob is unset / 0 or when the OLTP has
  no rows past the cursor."
  [ds cursor cfg]
  (when-let [max-ms (-> cfg :tailer :max-lag-warn-ms)]
    (when (pos? (long max-ms))
      (let [cursor-ts (:last-op-ts cursor)
            cursor-op-id (:last-op-id cursor)
            ;; Same true-lag (op-ts gap) computation /health uses — nil
            ;; when caught up (no rows past the cursor). Shared via
            ;; plaid.history.core so the two surfaces can't drift.
            max-ts (history/max-unreplicated-op-ts ds cursor-ts cursor-op-id)]
        (when (and max-ts cursor-ts)
          (try
            (let [lag-ms (- (.toEpochMilli (Instant/parse ^String max-ts))
                            (.toEpochMilli (Instant/parse ^String cursor-ts)))]
              (when (> lag-ms (long max-ms))
                (warn-rate-limited!
                 last-lag-warn-at
                 "history tailer lag exceeds :max-lag-warn-ms"
                 {:lag-ms lag-ms
                  :max-lag-warn-ms max-ms
                  :cursor-ts cursor-ts
                  :cursor-op-id (str cursor-op-id)})))
            (catch Throwable _
              ;; Malformed cursor or op ts — swallow; this is just a
              ;; warning surface, not a correctness path.
              nil)))))))

(defn- check-max-disk-warn!
  "Sample history on-disk size every `disk-check-stride` polls and emit a
  rate-limited `:warn` when it exceeds `:max-disk-warn-mb`. We sample
  on a stride (rather than every poll) because `file-seq` + per-file
  `.length` walks every column file under the history storage tree — on
  a multi-GB store this is non-trivial."
  [cfg]
  (when-let [max-mb (-> cfg :tailer :max-disk-warn-mb)]
    (when (pos? (long max-mb))
      (let [n (swap! poll-counter inc)]
        (when (zero? (mod n disk-check-stride))
          (try
            (let [bytes (history/disk-bytes)
                  mb (long (Math/round (double (/ bytes (* 1024 1024)))))]
              (when (> mb (long max-mb))
                (warn-rate-limited!
                 last-disk-warn-at
                 "history store size exceeds :max-disk-warn-mb"
                 {:store-mb mb
                  :max-disk-warn-mb max-mb})))
            (catch Throwable _
              ;; A disk read failure shouldn't stall the tailer; the
              ;; /health endpoint will surface persistent failure
              ;; through `store-bytes (try ... (catch 0))`.
              nil)))))))

(defn- stop-requested?
  "Non-blocking check: is the `stop` channel closed? A closed channel is
  always ready to read (yields nil), so `alts!!` selects it; an open,
  empty channel falls to the `:default` branch. `poll!` can't be used —
  it returns nil for both closed and empty. `stop` is close-only (no
  values are ever put), so a selected `stop` means closed."
  [stop]
  (let [[_ port] (async/alts!! [stop] :default ::open)]
    (= port stop)))

(defn- apply-batches-until-empty!
  "Run poll-once! repeatedly until a pass consumes zero rows OR throws.
  Returns true on a clean drain; rethrows on failure so the outer loop
  can stall.

  Without this, the outer wait would block on the next nudge/heartbeat
  after each single batch — fine for tiny bursts, but on a backlog
  (cold start, post-restart catch-up) every additional batch would pay
  one heartbeat of latency.

  Checks `stop` BETWEEN batches so `:stop` is honored within one batch on
  a long backlog drain — otherwise a multi-second cold-replay drain would
  outlast `:stop`'s 5s wait, get abandoned, and leave an orphan loop that
  a subsequent start could double up."
  [ds node stop]
  (let [cfg (history/history-config)]
    (loop []
      (let [{:keys [rows-consumed cursor]} (poll-once! ds node)]
        (maybe-log-progress! cursor rows-consumed)
        (when (and (pos? rows-consumed) (not (stop-requested? stop)))
          (recur))))
    ;; Post-drain checks: read the latest status snapshot (poll-once!
    ;; refreshed it) and run the rate-limited warn knobs + the
    ;; caught-up edge log.
    (let [{:keys [cursor lag-rows]} @last-status]
      (maybe-log-caught-up! cursor (or lag-rows 0))
      (check-max-lag-warn! ds cursor cfg)
      (check-max-disk-warn! cfg)))
  true)

(defn- reset-loop-instance-state!
  "Clear the atoms scoped to a single tailer loop instance — progress
  counters and warn-cooldown timestamps. Called at run-loop! start and
  on :stop so a restart re-emits the cold-replay progress cadence and
  the dead-knob warnings rather than carrying state across the boundary."
  []
  (reset! rows-applied-since-start 0)
  (reset! last-progress-logged-at 0)
  (reset! was-lagging? false)
  (reset! last-lag-warn-at 0)
  (reset! last-disk-warn-at 0)
  (reset! poll-counter 0))

(defn- transient-db-error?
  "True when `t` (or any cause in its chain) is a transient SQLite
  contention error — SQLITE_BUSY / SQLITE_LOCKED / \"database is
  locked\". These can ONLY originate from the audit-log READ
  (`fetch-batch`); the apply path writes to the XTDB history node, never
  SQLite, so a busy/locked here means the cursor never moved and nothing
  partial landed. Such errors are operational, not data defects, and
  MUST NOT latch the tailer into a permanent `:stalled` state (that
  contract is reserved for malformed/structural rows that need an
  operator). The loop instead backs off one poll interval and retries
  the same cursor — idempotent and self-healing."
  [^Throwable t]
  (loop [^Throwable e t]
    (cond
      (nil? e) false
      (re-find #"(?i)SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked"
               (or (.getMessage e) "")) true
      :else (recur (.getCause e)))))

(defn- shutdown-db-error?
  "True when `t` (or any cause) is a 'datasource/pool/connection has been
  closed' error. Happens during shutdown: mount stops the tailer (bounded
  5s wait) then closes the Hikari pool; a `fetch-batch` read still in
  flight when the pool closes (e.g. mid cold-replay backlog) throws this.

  It is NEITHER a data defect NOR retryable contention — the system is
  going down. The loop must exit CLEANLY without persisting `:stalled`,
  else every restart would resume into a false stall needing a manual
  `resume!`. Safe: the read failed so the cursor never moved and nothing
  partial landed; the next start resumes from the same cursor."
  [^Throwable t]
  (loop [^Throwable e t]
    (cond
      (nil? e) false
      (re-find #"(?i)has been closed|connection is closed|connection pool .*shut(ting)? down|datasource .*closed"
               (or (.getMessage e) "")) true
      :else (recur (.getCause e)))))

(defn- run-loop!
  "Body of the background loop. Returns a promise-channel `done` that
  receives `::exited` exactly once when the loop exits (stall or stop).

  `done` is a promise-channel so external waiters can distinguish
  'loop still running' from 'loop has terminated' via `(async/poll!
  done)` — a closed empty channel returns nil for both, but a
  promise-chan with the sentinel buffered returns the sentinel forever
  after the loop exits. `resume!` relies on this distinction to decide
  whether to spawn a fresh loop."
  [ds node cfg]
  (let [stop (async/chan)
        done (async/promise-chan)
        nudge history/nudge-chan
        heartbeat-ms (or (-> cfg :tailer :poll-interval-ms) 5000)
        signal-done! (fn [] (async/put! done ::exited) (async/close! done))]
    (reset-loop-instance-state!)
    (reset! stop-chan stop)
    (reset! done-chan done)
    (async/go-loop []
      (let [running? (try
                       (let [cur (history/cursor-read node)]
                         (not= :stalled (:tailer-status cur)))
                       (catch Throwable t
                         (log/error t "history tailer cursor read failed")
                         false))
            keep-going? (when running?
                          (try
                            ;; Drain any nudges queued while we were
                            ;; sleeping so we don't double-process the
                            ;; same wakeup on the next iteration.
                            (drain-nudges! nudge)
                            (apply-batches-until-empty! ds node stop)
                            (catch Throwable t
                              (cond
                                ;; Transient SQLite lock contention on the
                                ;; audit-log read. The cursor hasn't moved and
                                ;; nothing partial landed (apply writes to XTDB,
                                ;; not SQLite), so DON'T stall — return truthy to
                                ;; fall through to the normal poll wait and retry
                                ;; the same cursor next iteration.
                                (transient-db-error? t)
                                (do (log/warn t "history tailer hit transient DB contention; retrying next poll:"
                                              (or (ex-message t) (str t)))
                                    true)

                                ;; Datasource closed under us during shutdown.
                                ;; Exit the loop cleanly WITHOUT persisting a
                                ;; stall — the read failed so the cursor never
                                ;; moved; the next :start resumes from it. (A
                                ;; persisted stall here would make every restart
                                ;; come up dead until a manual resume!.)
                                (shutdown-db-error? t)
                                (do (log/info "history tailer: datasource closed (shutting down); exiting cleanly")
                                    false)

                                ;; Structural / data defect: stall so an operator
                                ;; can intervene. The stall write uses a fresh
                                ;; execute-tx so the cursor doc is updated even
                                ;; though the apply tx (which would have included
                                ;; its own cursor-advance) failed.
                                :else
                                (let [data (ex-data t)
                                      reason (or (ex-message t) (str t))]
                                  (log/error t "history tailer stalled:" reason)
                                  (try
                                    (history/set-stalled! node
                                                          {:op-id (:op-id data)
                                                           :seq (:seq data)
                                                           :reason reason})
                                    (catch Throwable t2
                                      (log/error t2 "history tailer failed to record stall")))
                                  false)))))]
        (if (and running? keep-going?)
          (let [[_ port] (async/alts! [stop nudge (async/timeout heartbeat-ms)])]
            (if (= port stop)
              (do (log/info "history tailer stop requested; exiting loop")
                  (signal-done!))
              (recur)))
          (do (when-not running?
                (log/info "history tailer not running (stalled or shutting down)"))
              (signal-done!)))))
    done))

;; ============================================================
;; Mount lifecycle
;; ============================================================

(defn- clear-stale-stall-on-start!
  "If the node comes up `:stalled`, clear the flag (RETRY semantics — we
  do NOT advance the cursor, so the loop simply re-reads the same row) and
  WARN-log the prior reason.

  Rationale: a persisted stall survives restarts, but most stalls we see
  in practice are transient/environmental (a shutdown-race datasource
  close, contention, stale-loaded code) — and a restart resolves the
  underlying condition. Clearing on start auto-recovers all of those.
  A GENUINE malformed/structural row is not skipped, so the loop re-hits
  it and re-stalls within one poll — the loud signal survives, just with
  a WARN trail here naming what we retried. (Skipping a bad row is still
  the deliberate, operator-only `resume! {:skip-current-row? true}`.)"
  [node]
  (let [cur (history/cursor-read node)]
    (when (= :stalled (:tailer-status cur))
      (log/warn "history tailer came up stalled; clearing flag and retrying (cursor unchanged). Prior stall reason:"
                (:stall-reason cur))
      (history/set-running! node))))

(defstate tailer
  :start (let [cfg (history/history-config)]
           (if (and (:enabled? cfg) history/node)
             (do
               (log/info "Starting history tailer"
                         (select-keys (:tailer cfg)
                                      [:poll-interval-ms :batch-size]))
               (clear-stale-stall-on-start! history/node)
               (run-loop! datasource history/node cfg))
             (do
               (log/info "history tailer disabled (:plaid.history/config :enabled? = false); skipping")
               nil)))
  :stop (do
          (when-let [stop @stop-chan]
            (log/info "Signalling history tailer to stop")
            (async/close! stop))
          (when-let [done @done-chan]
            ;; Bounded wait — :stop must not hang the JVM on a stuck
            ;; loop iteration. 5s is plenty for the current poll
            ;; cycle to finish; the loop is just one batch query +
            ;; submit-tx per iteration.
            (async/alt!!
              done :done
              (async/timeout 5000) (log/warn "history tailer did not stop within 5s; abandoning")))
          (reset! stop-chan nil)
          (reset! done-chan nil)
          (reset! last-status {:running? false :cursor nil :lag-rows 0})
          (reset-loop-instance-state!)
          nil))

;; ============================================================
;; Operator surface
;; ============================================================

(defn status
  "Snapshot of the tailer's current state: `:running?`, `:cursor`,
  `:lag-rows`. Refreshed at the end of every successful poll; on
  demand a caller can force a refresh by calling `(poll-once!)` first.

  Returns a stable map; never throws."
  []
  @last-status)

(defn- skip-row-by-advancing-cursor!
  "Write a synthetic cursor advance that bypasses the failed row.
  We seek the NEXT (o.ts, o.id, aw.seq) after the current cursor in
  audit_writes and set the cursor doc to land on that row's seq — so
  the next batch query strictly skips past it.

  Returns the new cursor doc, or nil if there's nothing past the
  current cursor to skip to."
  [ds node]
  (let [cursor (history/cursor-read node)
        cur-ts (:last-op-ts cursor)
        cur-id (:last-op-id cursor)
        cur-seq (or (:last-seq cursor) -1)
        ;; Find the very next audit_writes row past the current
        ;; (op.ts, op.id, aw.seq) tuple. Two-clause lex compare on
        ;; (op.ts, op.id), then strict > on aw.seq within the same
        ;; op as a tertiary key — we want to advance ONE row past
        ;; the offending one, not skip a whole op-group.
        next-row (psc/q1 ds
                         {:select [[:o.ts :op_ts] [:o.id :op_id_full] [:aw.seq :seq]]
                          :from [[:audit_writes :aw]]
                          :join [[:operations :o] [:= :aw.op_id :o.id]]
                          :where (cond
                                   (nil? cur-id) [:>= :o.ts cur-ts]
                                   :else [:or
                                          [:> :o.ts cur-ts]
                                          [:and [:= :o.ts cur-ts] [:> :o.id cur-id]]
                                          [:and [:= :o.ts cur-ts]
                                           [:= :o.id cur-id]
                                           [:> :aw.seq cur-seq]]])
                          :order-by [:o.ts :o.id :aw.seq]
                          :limit 1})]
    (when next-row
      (let [new-cursor {;; Normalize through ->iso-string like every other
                        ;; cursor write so `:last-op-ts` keeps the canonical
                        ;; fixed-width shape the lex-compared keyset depends
                        ;; on — don't trust the raw JDBC value here.
                        :last-op-ts (history/->iso-string (:op_ts next-row))
                        :last-op-id (:op_id_full next-row)
                        :last-seq (:seq next-row)
                        :tailer-status :running
                        :stall-reason nil}]
        ;; Log BEFORE the write so the audit trail records the intent
        ;; even if the put-docs throws. `:skip-current-row? true` is a
        ;; destructive operator action — the offending audit row is
        ;; never replayed — so the trail matters for postmortems.
        (log/warn "history tailer skipping audit row"
                  {:from-cursor cursor :to-cursor new-cursor})
        (xt/execute-tx node [(history/cursor->tx-op new-cursor)])
        new-cursor))))

(defn resume!
  "Clear the stall flag and restart the loop. REPL helper.

  Options:
    :skip-current-row? — when true, advance the cursor past the row
                         that caused the stall before restarting.
                         Without this, the loop will re-hit the same
                         row and stall again.

  3-arity (ds node opts) is for tests that haven't started the mount
  defstates; the 0/1-arity REPL forms read the mounted `datasource` +
  `history/node` (both are mount-bound to their values, not deref'd).

  Returns the new cursor record."
  ([] (resume! {}))
  ([opts] (resume! datasource history/node opts))
  ([ds node {:keys [skip-current-row?]}]
   (when-not node
     (throw (ex-info "history node is nil — cannot resume" {:type :tailer/not-enabled})))
   (when skip-current-row?
     (skip-row-by-advancing-cursor! ds node))
   (history/set-running! node)
   ;; Spawn a fresh loop iff the prior one has exited (or never ran).
   ;; `done` is a promise-channel that buffers `::exited` exactly
   ;; once at loop exit, so `poll!` returns the sentinel iff the
   ;; loop is terminated and nil while it's alive. Pre-promise-chan
   ;; this used a plain channel, where poll!-on-closed also returns
   ;; nil — making this check a no-op that left the tailer
   ;; permanently dead after a stall.
   (when (or (nil? @done-chan)
             (some? (async/poll! @done-chan)))
     (run-loop! ds node (history/history-config)))
   (history/cursor-read node)))

(defn simulate-stall!
  "DEV-ONLY: force the tailer into `:stalled` without an actual bad row.

  Writes `:tailer-status :stalled` onto the cursor doc; the running loop
  notices on its next poll and exits, exactly as a real structural stall
  does. `/health` then reports stalled and `?as-of=` document reads return
  503. This is a FAKE stall — the data is fine, the cursor doesn't move —
  so a server restart auto-clears it (`clear-stale-stall-on-start!`) and
  the loop runs clean again. For a stall that re-asserts on restart,
  corrupt an unconsumed `audit_writes.post_image` instead.

  Recover with `(resume!)` (no skip needed — the cursor never moved).

  0-arity reads the mounted `history/node`; 1-arity takes an explicit node
  for tests that haven't started the mount defstates."
  ([] (simulate-stall! history/node))
  ([node]
   (when-not node
     (throw (ex-info "history node is nil — cannot stall" {:type :tailer/not-enabled})))
   (history/set-stalled! node {:op-id nil :seq nil :reason "simulated dev stall"})))
