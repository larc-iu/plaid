(ns plaid.olap.core
  "XTDB v2 OLAP replica — read-only time-travel store fed by an in-process
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

  Error-type taxonomy (ex-info `:type` keys across the OLAP namespaces,
  and how the REST layer maps each):
    :olap/not-caught-up   — read ts is past the tailer cursor.   → 425
    :olap/stalled         — tailer halted on a bad row.          → 503
    :olap/read-timeout    — OLAP read exceeded its deadline.     → 503
    :olap/invalid-timestamp — a ts coercer hit nil/garbage. On the apply
                              path the tailer loop catches it (→ stall);
                              on the read path it falls through to the
                              503 default in `wrap-route-as-of`.
    (OLAP disabled / node not started are returned directly as 503 by
     `wrap-route-as-of` without an ex-info.)
    :replayer/malformed-row    — an audit row the replayer can't
                                 translate (carries :op-id + :seq so the
                                 stall record names the offending row).
    :tailer/cursor-not-advanced — XTDB silently dropped the apply tx.
    :tailer/op-too-large        — one op's audit rows exceed the batch cap.
    :tailer/not-enabled         — resume! called with OLAP disabled.
  The `:replayer/*` and `:tailer/*` types are caught by the tailer loop
  (→ stall), never surfaced to REST callers directly.

  See `docs/olap-design.md` for the full design."
  (:require [clojure.core.async :as async]
            [clojure.java.io :as io]
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
   :storage-path "data/olap-storage"
   :log-path "data/olap-log"
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

(defn olap-config
  "Resolve the merged :plaid.olap/config map, applying defaults for any
   keys the operator didn't set."
  []
  (let [user-cfg (get config :plaid.olap/config {})
        ;; Shallow merge for top-level, then deep-merge the :tailer submap.
        merged (merge default-config user-cfg)]
    (assoc merged :tailer (merge (:tailer default-config)
                                 (:tailer user-cfg)))))

(defn enabled?
  "True if the operator has opted into the OLAP replica."
  []
  (boolean (:enabled? (olap-config))))

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
   a SQL tx. No-op when OLAP is disabled."
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
   to pin them (or move OLAP to a separate process) is tracked in the
   plan's open questions."
  [{:keys [storage-path log-path] :as cfg}]
  (ensure-dirs! cfg)
  (xtn/start-node
   {:storage [:local {:path storage-path}]
    :log [:local {:path log-path}]}))

(defstate node
  :start (let [cfg (olap-config)]
           (if (:enabled? cfg)
             (do
               (log/info "Starting OLAP XTDB node:" (select-keys cfg [:storage-path :log-path]))
               (start-xtdb-node cfg))
             (do
               (log/info "OLAP disabled (:plaid.olap/config :enabled? = false); skipping XTDB node")
               nil)))
  :stop (when node
          (log/info "Closing OLAP XTDB node")
          (.close ^java.lang.AutoCloseable node)))

;; ============================================================
;; Cursor (persisted as an :olap/meta doc)
;; ============================================================
;;
;; The cursor lives inside XTDB itself so its advance is atomic with the
;; corresponding op apply (one xt/submit-tx writes both). On startup, if
;; absent, the tailer seeds it to the epoch and replays from the start
;; of audit_writes (see plaid.olap.tailer).

(def cursor-id :cursor)

(defn cursor-read
  "Read the OLAP tailer's cursor. Returns nil if no cursor has been
   written yet (cold-start case)."
  [node]
  (first
   (xt/q node
         '(-> (from :olap/meta [{:xt/id id}
                                last-op-ts last-op-id last-seq
                                tailer-status stall-reason])
              (where (= id :cursor))))))

(defn cursor->tx-op
  "Build a `[:put-docs :olap/meta {:xt/id :cursor ...}]` tx-op carrying
   the supplied cursor fields. Pass to xt/submit-tx in the same vector
   as the op's other tx-ops so the cursor advance is atomic with the
   apply."
  [{:keys [last-op-ts last-op-id last-seq tailer-status stall-reason]
    :or {tailer-status :running stall-reason nil}}]
  [:put-docs :olap/meta
   {:xt/id cursor-id
    :last-op-ts last-op-ts
    :last-op-id last-op-id
    :last-seq last-seq
    :tailer-status tailer-status
    :stall-reason stall-reason}])

(defn set-stalled!
  "Halt the tailer by writing :tailer-status :stalled into the cursor doc.
   Called by the tailer when it hits a malformed audit row; operator
   resumes via plaid.olap.tailer/resume! once the upstream bug is fixed."
  [node {:keys [op-id seq reason]}]
  (let [cur (or (cursor-read node) {})
        next-cur (assoc cur
                        :tailer-status :stalled
                        :stall-reason (str reason
                                           " (at op-id=" op-id ", seq=" seq ")"))]
    (xt/execute-tx node [(cursor->tx-op next-cur)])
    next-cur))

(defn set-running!
  "Clear the stall flag on the cursor (operator-driven via REPL)."
  [node]
  (let [cur (or (cursor-read node) {})
        next-cur (assoc cur :tailer-status :running :stall-reason nil)]
    (xt/execute-tx node [(cursor->tx-op next-cur)])
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
   `cursor-instant` (in olap.document) calls this on `:last-op-ts`, so a
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
    ;; catch-all turns into an unidentifiable stall. :olap/invalid-timestamp
    ;; is caught by the tailer loop (→ stall) and mapped to 503 on the read
    ;; path — see this ns's error-taxonomy docstring.
    :else (throw (ex-info (str "Cannot coerce to Instant: "
                               (if (nil? x) "nil" (.getName (class x))))
                          {:type :olap/invalid-timestamp :value x}))))

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
  "Sum of file sizes under the OLAP storage + log paths (best-effort).
   Used by the /health endpoint to surface disk usage."
  []
  (let [{:keys [storage-path log-path]} (olap-config)]
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
;; know how far behind the OLAP is. These live HERE (one copy) rather
;; than duplicated in plaid.olap.tailer + plaid.server.middleware, so a
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
  OLAP. A nil cursor (cold start) means everything is unreplicated."
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
