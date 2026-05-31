(ns plaid.olap.tailer-test
  "Targeted regression tests for `plaid.olap.tailer`. The integration
  test in `integration_test.clj` covers the happy-path REST surface;
  this namespace pins specific failure modes that previously slipped
  through to production:

   - BUG-2: an op whose audit-row count exceeds `batch-size` must not
     stall the tailer (drop-trailing-partial would otherwise return 0
     rows and the loop would silently never advance).
   - M-pipeline-2: the seed cursor must be persisted on the first poll
     against a quiet OLTP so health/staleness reads stop seeing nil
     forever.

  These tests bypass the REST helpers and write directly into
  `operations` + `audit_writes`, then call `poll-once!` so we can
  control the row count without standing up a project/document graph."
  (:require [clojure.data.json :as json]
            [clojure.test :refer :all]
            [next.jdbc :as jdbc]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    with-admin with-test-users with-clean-db]]
            [plaid.olap.core :as olap]
            [plaid.olap.document :as olap-doc]
            [plaid.olap.tailer :as tailer]
            [plaid.sql.common :as psc]
            [xtdb.api :as xt]
            [xtdb.node :as xtn])
  (:import (java.time Instant)
           (java.util UUID)))

(def ^:dynamic ^:private *olap-node* nil)

(defn- with-olap-node [f]
  (with-open [node (xtn/start-node {})]
    (binding [*olap-node* node]
      (with-redefs [olap/enabled? (constantly true)
                    olap/node node]
        (f)))))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db with-olap-node)

;; ============================================================
;; Direct OLTP fixture builders
;; ============================================================

(defn- canon-ts
  "Canonicalize a ts literal to the fixed-width 9-digit form the real
  write path (`psc/now-iso` → `instant->iso`) always produces for
  `operations.ts`. Test fixtures insert directly, so without this a
  sloppy `\"...00Z\"` literal would land non-canonical in the DB and the
  cursor (which IS normalized) would mis-lex-compare against it — a
  test-only artifact, never a production shape."
  [ts]
  (psc/instant->iso (Instant/parse ts)))

(defn- insert-operation! [ds op-id ts]
  (jdbc/execute!
   ds
   ["INSERT INTO operations (id, op_type, project_id, document_id, description, batch_id, user_id, user_agent, ts)
     VALUES (?, 'test/op', NULL, NULL, 'test', NULL, NULL, NULL, ?)"
    op-id (canon-ts ts)]))

(defn- insert-audit-rows!
  "Insert `n` audit rows for `op-id`, all targeting an arbitrary
  `:olap/spans` doc. Each row gets a distinct entity-id so applying them
  to the OLAP node won't merge-collapse via `merge-same-id-tx-ops`."
  [ds op-id ts n]
  (let [doc-id (str (UUID/randomUUID))
        layer-id (str (UUID/randomUUID))]
    (jdbc/with-transaction [tx ds]
      (doseq [i (range n)]
        (let [span-id (UUID/randomUUID)
              post (json/write-str {:id (str span-id)
                                    :span_layer_id layer-id
                                    :document_id doc-id
                                    :value (str "v" i)})]
          (jdbc/execute!
           tx
           ["INSERT INTO audit_writes (id, op_id, seq, target_table, target_id, change_type, pre_image, post_image, ts)
             VALUES (?, ?, ?, 'spans', ?, 'insert', NULL, ?, ?)"
            (str (UUID/randomUUID)) op-id i (str span-id) post (canon-ts ts)]))))))

;; ============================================================
;; BUG-2: tailer must not stall on an op whose audit-rows > batch-size
;; ============================================================

;; Default tailer config for these tests. Note `:cold-replay-on-empty? true`
;; is the production default — it makes `seed-cursor` start at the epoch,
;; which is what most of these tests assume (they insert ops into a fresh
;; OLTP and expect them all to apply on the first poll). Omitting the key
;; would fall into the `false` branch of `seed-cursor`, which seeds past
;; the latest existing op's ts and silently skips the test inserts.
(defn- ^:private cfg [batch-size]
  {:enabled? true
   :cold-replay-on-empty? true
   :tailer {:batch-size batch-size
            :poll-interval-ms 5000}})

(deftest oversized-op-rows-do-not-stall-tailer
  ;; Pre-fix: `drop-trailing-partial` saw last-op-id == first-op-id when
  ;; the whole `batch-size + 1` window belonged to one op, returned 0
  ;; rows, and the loop silently exited. `poll-once!` would keep coming
  ;; back with 0 applied indefinitely.
  ;;
  ;; Now: `fetch-batch-with-grow` escalates LIMIT until the op fits, so
  ;; the entire op applies in one batch and the cursor advances past it.
  (let [batch-size 5
        op-id (str (UUID/randomUUID))
        ts "2026-05-28T10:00:00Z"
        rows-in-op (+ batch-size 3)] ; comfortably > batch-size
    (insert-operation! plaid.fixtures/db op-id ts)
    (insert-audit-rows! plaid.fixtures/db op-id ts rows-in-op)
    (with-redefs [olap/olap-config (constantly (cfg batch-size))]
      (let [{:keys [applied-ops rows-consumed cursor]}
            (tailer/poll-once! plaid.fixtures/db *olap-node*)]
        (is (= 1 applied-ops)
            "the oversized op applies as one apply call, not zero")
        (is (= rows-in-op rows-consumed)
            "every audit row in the op is consumed in this batch")
        (is (= op-id (:last-op-id cursor))
            "the cursor advances past the oversized op")))))

(deftest fetch-batch-with-grow-keeps-cheap-path-for-small-ops
  ;; Sanity check: when the natural batch-size headroom is fine, the
  ;; grow logic must not kick in or re-fetch. Two small ops with
  ;; batch-size 10 fit comfortably in one batch.
  (let [batch-size 10
        op1 (str (UUID/randomUUID))
        op2 (str (UUID/randomUUID))]
    (insert-operation! plaid.fixtures/db op1 "2026-05-28T10:01:00Z")
    (insert-audit-rows! plaid.fixtures/db op1 "2026-05-28T10:01:00Z" 2)
    (insert-operation! plaid.fixtures/db op2 "2026-05-28T10:01:01Z")
    (insert-audit-rows! plaid.fixtures/db op2 "2026-05-28T10:01:01Z" 3)
    (with-redefs [olap/olap-config (constantly (cfg batch-size))]
      (let [{:keys [applied-ops rows-consumed]}
            (tailer/poll-once! plaid.fixtures/db *olap-node*)]
        (is (= 2 applied-ops))
        (is (= 5 rows-consumed))))))

;; ============================================================
;; M-pipeline-2: seed cursor is persisted on first quiet-OLTP poll
;; ============================================================

(deftest seed-cursor-is-persisted-on-first-poll-against-empty-oltp
  ;; Pre-fix: with cold-replay-on-empty? false, OLTP empty, no cursor:
  ;; `seed-cursor` was used in-memory only and never written to XTDB.
  ;; `cursor-read` would return nil forever, breaking health reporting
  ;; and the staleness check.
  (with-redefs [olap/olap-config (constantly {:enabled? true
                                              :cold-replay-on-empty? false
                                              :tailer {:batch-size 500
                                                       :poll-interval-ms 5000}})]
    (is (nil? (olap/cursor-read *olap-node*)) "precondition: no cursor")
    (let [{:keys [applied-ops cursor]} (tailer/poll-once! plaid.fixtures/db *olap-node*)]
      (is (zero? applied-ops) "OLTP is empty so nothing applies")
      (is (some? cursor) "but the seed cursor was still returned"))
    (is (some? (olap/cursor-read *olap-node*))
        "and crucially the seed cursor was PERSISTED so health reads see it")))

(deftest seed-cursor-persisted-on-first-poll-cold-replay-true-empty-oltp
  ;; Same fix, the other config branch: cold-replay-on-empty? true with
  ;; an empty OLTP still has no apply to write a cursor, so we must seed.
  (with-redefs [olap/olap-config (constantly {:enabled? true
                                              :cold-replay-on-empty? true
                                              :tailer {:batch-size 500
                                                       :poll-interval-ms 5000}})]
    (is (nil? (olap/cursor-read *olap-node*)))
    (tailer/poll-once! plaid.fixtures/db *olap-node*)
    (is (some? (olap/cursor-read *olap-node*)))))

;; ============================================================
;; Cursor shape: :last-op-ts must round-trip as a String, not ZDT
;; (BUG-3 regression — see plaid.olap.replayer/cursor-from-op)
;; ============================================================

(deftest cursor-last-op-ts-survives-as-iso-string-through-apply
  ;; Before the BUG-3 fix, `cursor-from-op` wrote `(:op/ts op-record)`
  ;; verbatim. If guard-monotonic had rebuilt op-record* with an
  ;; adjusted Date, the cursor stored a Date — XTDB round-trips it as
  ;; ZonedDateTime, breaking the subsequent (= o.ts cursor-ts) compare
  ;; in `fetch-batch` and `cursor-reached?`. Apply one op and assert
  ;; the cursor's :last-op-ts is a String regardless.
  (let [op-id (str (UUID/randomUUID))
        ts "2026-05-28T11:00:00Z"]
    (insert-operation! plaid.fixtures/db op-id ts)
    (insert-audit-rows! plaid.fixtures/db op-id ts 1)
    (with-redefs [olap/olap-config (constantly (cfg 500))]
      (tailer/poll-once! plaid.fixtures/db *olap-node*))
    (let [cursor (olap/cursor-read *olap-node*)]
      (is (string? (:last-op-ts cursor))
          ":last-op-ts must round-trip as an ISO string, not a ZonedDateTime")
      (is (= (canon-ts ts) (:last-op-ts cursor))
          "and the string is the exact (canonical) OLTP ts so fetch-batch's = compare works"))))

;; ============================================================
;; B-pipeline-3: guard-monotonic must NOT advance when op-ts == latest
;; ============================================================

(deftest guard-monotonic-leaves-equal-op-ts-untouched
  ;; XTDB v2 accepts multiple submit-tx calls at the same :system-time
  ;; (verified by REPL probe; each gets a distinct tx-id). The prior
  ;; predicate advanced on `op-ts <= latest + 1ms`, which generated
  ;; noisy warnings AND triggered the BUG-3 cursor-shape corruption on
  ;; every equal-ts op. Strict-before only.
  (let [latest (Instant/parse "2026-05-28T12:00:00Z")
        equal-date (java.util.Date/from latest)
        earlier-date (java.util.Date/from (.minusMillis latest 5))
        later-date (java.util.Date/from (.plusMillis latest 5))
        guard @#'tailer/guard-monotonic]
    (is (identical? equal-date (guard equal-date latest))
        "op-ts == latest is left untouched (no advance, no nudge)")
    (is (identical? later-date (guard later-date latest))
        "op-ts > latest is left untouched")
    (is (not (identical? earlier-date (guard earlier-date latest)))
        "op-ts < latest still advances (the guard's real job)")
    (let [advanced (guard earlier-date latest)]
      (is (= (.plusMillis latest 1) (.toInstant advanced))
          "advanced exactly to latest+1ms"))
    (is (identical? equal-date (guard equal-date nil))
        "nil latest is treated as no constraint")))

(deftest cursor-iso-shape-survives-guard-monotonic-advance
  ;; This is the path BUG-3 actually corrupted. Drive
  ;; `plaid.olap.replayer/apply-op!` directly with an op whose `:op/ts`
  ;; is a `java.util.Date` (the shape `apply-op-with-guard!` would hand
  ;; off after rebuilding op-record* with an adjusted Date). Without
  ;; the BUG-3 fix, `cursor-from-op` would store that Date verbatim and
  ;; XTDB round-trips it as `ZonedDateTime` — breaking the
  ;; `(= o.ts cursor-ts)` comparison in `fetch-batch`. Post-fix the
  ;; cursor must read back as a String regardless of input shape.
  (let [op-id (str (UUID/randomUUID))
        ts (Instant/parse "2026-05-28T08:00:00Z")
        op-record {:op/id op-id
                   :op/ts (java.util.Date/from ts) ; the Date shape that triggered BUG-3
                   :op/op-type :test/op}
        rows [{:target_table "spans"
               :target_id (str (UUID/randomUUID))
               :change_type "insert"
               :pre_image nil
               :post_image (clojure.data.json/write-str
                            {:id (str (UUID/randomUUID))
                             :span_layer_id (str (UUID/randomUUID))
                             :document_id (str (UUID/randomUUID))
                             :value "v"})
               :seq 0}]]
    (plaid.olap.replayer/apply-op! *olap-node* op-record rows)
    (let [cursor (olap/cursor-read *olap-node*)]
      (is (string? (:last-op-ts cursor))
          ":last-op-ts is normalized to ISO string when (:op/ts op-record) was a Date")
      (is (not (instance? java.time.ZonedDateTime (:last-op-ts cursor)))
          "specifically not a ZonedDateTime — the regression shape that broke fetch-batch")
      ;; A Date/Instant input is rendered via the canonical fixed-width
      ;; 9-digit formatter (`olap/->iso-string` → `psc/instant->iso`),
      ;; same format `now-iso` produces for `operations.ts`, so the
      ;; cursor stays lexicographically comparable. NOT `Instant.toString`
      ;; (which would drop the fractional part on a whole second).
      (is (= (psc/instant->iso ts) (:last-op-ts cursor))
          "Date input round-trips as the canonical fixed-width ISO string")
      (is (= "2026-05-28T08:00:00.000000000Z" (:last-op-ts cursor))
          "fixed-width 9-digit fractional seconds"))))

(deftest apply-op-with-explicit-system-time-preserves-cursor-oltp-axis
  ;; When guard-monotonic fires (clock skew / backfill), the OLAP-axis
  ;; `:system-time` advances but the cursor's `:last-op-ts` MUST stay
  ;; on the OLTP axis (i.e. equal to the original `operations.ts`).
  ;; Otherwise `fetch-batch`'s `WHERE (o.ts, o.id) > cursor` clause
  ;; would silently skip any subsequent op whose `op.ts` falls between
  ;; the original ts and the adjusted system-time — a real data-loss
  ;; trigger under clock skew.
  ;;
  ;; This pins the apply-op! 4-arity contract: the cursor reflects the
  ;; ORIGINAL op-record's :op/ts; the explicit system-time argument
  ;; governs only the XTDB write axis.
  (let [op-id (str (UUID/randomUUID))
        oltp-ts-str "2026-05-28T08:00:00Z"
        ;; Pretend the OLAP's previous latest-system-from was 12:00.
        ;; In production apply-op-with-guard! computes the adjusted
        ;; Date via guard-monotonic; here we pass it directly.
        adjusted-system-time (java.util.Date/from
                              (.plusMillis (Instant/parse "2026-05-28T12:00:00Z") 1))
        op-record {:op/id op-id
                   :op/ts oltp-ts-str ; OLTP wall-clock as JDBC delivered it
                   :op/op-type :test/op}
        rows [{:target_table "spans"
               :target_id (str (UUID/randomUUID))
               :change_type "insert"
               :pre_image nil
               :post_image (clojure.data.json/write-str
                            {:id (str (UUID/randomUUID))
                             :span_layer_id (str (UUID/randomUUID))
                             :document_id (str (UUID/randomUUID))
                             :value "v"})
               :seq 0}]]
    (plaid.olap.replayer/apply-op! *olap-node* op-record rows adjusted-system-time)
    (let [cursor (olap/cursor-read *olap-node*)]
      (is (= (canon-ts oltp-ts-str) (:last-op-ts cursor))
          "cursor's :last-op-ts equals the ORIGINAL OLTP op.ts (canonical form), NOT the adjusted system-time")
      (is (not= (.toString (.toInstant adjusted-system-time))
                (:last-op-ts cursor))
          "specifically, NOT the adjusted system-time — that would skip subsequent ops"))))

;; ============================================================
;; Stall + resume cycle
;; ============================================================
;;
;; The stall/resume mechanism (set-stalled!, resume!, resume! :skip-current-row?)
;; is the operator's only recourse when a malformed audit row halts the tailer.
;; A bad post_image (unparseable JSON) makes `replayer/parse-image` throw
;; `:replayer/malformed-row`, which the loop catches and records via
;; `olap/set-stalled!`. The cursor doc's `:tailer-status` flips to `:stalled`
;; with a populated `:stall-reason`. From there:
;;   - `resume!` clears the stall flag but does NOT advance the cursor — the
;;     loop will re-hit the same bad row and stall again.
;;   - `resume! :skip-current-row? true` advances the cursor past the offending
;;     audit row first, then clears the flag, so subsequent rows apply cleanly.

(defn- insert-malformed-audit-row!
  "Insert one audit row with unparseable post_image JSON. `parse-image`
  will throw `:replayer/malformed-row` when the tailer tries to apply
  this op, which the loop maps to a stall."
  [ds op-id ts seq-n]
  (jdbc/execute!
   ds
   ["INSERT INTO audit_writes (id, op_id, seq, target_table, target_id, change_type, pre_image, post_image, ts)
     VALUES (?, ?, ?, 'spans', ?, 'insert', NULL, 'this-is-not-valid-json{{{{', ?)"
    (str (UUID/randomUUID)) op-id seq-n (str (UUID/randomUUID)) (canon-ts ts)]))

(deftest malformed-audit-row-throws-malformed-row-and-stall-write-records-reason
  ;; Two-step verification of the stall path:
  ;;   1. `poll-once!` against a malformed audit row throws `:replayer/malformed-row`.
  ;;      In production the run-loop's outer try/catch catches and writes the stall.
  ;;   2. The stall write (`olap/set-stalled!`) flips :tailer-status to :stalled
  ;;      and populates :stall-reason for operator diagnosis.
  (let [batch-size 50
        op-id (str (UUID/randomUUID))
        ts "2026-05-28T13:00:00Z"]
    (insert-operation! plaid.fixtures/db op-id ts)
    (insert-malformed-audit-row! plaid.fixtures/db op-id ts 0)
    (testing "poll-once! propagates the malformed-row ex-info"
      (with-redefs [olap/olap-config (constantly (cfg batch-size))]
        (let [thrown (try
                       (tailer/poll-once! plaid.fixtures/db *olap-node*)
                       nil
                       (catch clojure.lang.ExceptionInfo e e))]
          (is (some? thrown) "throws on malformed audit row")
          (is (= :replayer/malformed-row (:type (ex-data thrown)))
              "exception type drives the run-loop's stall write"))))
    (testing "the loop's stall write surfaces the reason"
      ;; The run-loop's stall write happens in apply-batches-until-empty!'s
      ;; catch — `olap/set-stalled!` records both the cursor's halt and
      ;; the operator-facing reason. Simulate that write here.
      (olap/set-stalled! *olap-node*
                         {:op-id op-id
                          :seq 0
                          :reason "audit row missing post_image for non-delete change"})
      (let [cursor (olap/cursor-read *olap-node*)]
        (is (= :stalled (:tailer-status cursor))
            "stall flag set on cursor")
        (is (string? (:stall-reason cursor))
            "stall-reason populated")
        (is (re-find #"missing post_image|malformed" (:stall-reason cursor))
            "stall-reason mentions the underlying parse failure")
        (is (re-find (re-pattern (str "op-id=" op-id)) (:stall-reason cursor))
            "stall-reason embeds the offending op-id for grep-ability")))))

(deftest resume-without-skip-does-not-advance-cursor
  ;; Drive the private skip-row + set-running! helpers in isolation rather
  ;; than `resume!` itself — `resume!`'s 0-arg form derefs the
  ;; `plaid.server.sql/datasource` defstate, which isn't started in this
  ;; unit-test fixture. The integration suite's `with-test-olap-node`
  ;; covers the wired-up path; here we just need to verify the cursor
  ;; semantics: `set-running!` clears the stall WITHOUT advancing.
  (let [op-id (str (UUID/randomUUID))
        ts "2026-05-28T13:01:00Z"]
    (insert-operation! plaid.fixtures/db op-id ts)
    (insert-malformed-audit-row! plaid.fixtures/db op-id ts 0)
    (olap/set-stalled! *olap-node*
                       {:op-id op-id
                        :seq 0
                        :reason "audit row missing post_image for non-delete change"})
    (let [pre-cursor (olap/cursor-read *olap-node*)]
      (is (= :stalled (:tailer-status pre-cursor)))
      (olap/set-running! *olap-node*)
      (let [post-cursor (olap/cursor-read *olap-node*)]
        (is (= :running (:tailer-status post-cursor)) "stall flag cleared")
        (is (nil? (:stall-reason post-cursor)) "stall-reason cleared too")
        (is (= (:last-op-ts pre-cursor) (:last-op-ts post-cursor))
            "cursor ts unchanged — no advance without skip")
        (is (= (:last-op-id pre-cursor) (:last-op-id post-cursor))
            "cursor op-id unchanged")
        (is (= (:last-seq pre-cursor) (:last-seq post-cursor))
            "cursor seq unchanged")))))

(deftest resume-with-skip-advances-past-bad-row-and-applies-subsequent-rows
  ;; The full happy-path recovery: a good op, then a bad op, then a good op.
  ;; After the loop stalls on op2, the operator's `:skip-current-row?` path
  ;; advances past op2's audit row; the next poll applies op3.
  ;;
  ;; We drive the private `skip-row-by-advancing-cursor!` directly because
  ;; the public `resume!` derefs a defstate (`plaid.server.sql/datasource`)
  ;; that isn't started in this fixture. The skip helper is the load-
  ;; bearing piece — it's what makes the cursor move past the bad row.
  (let [op1-id (str (UUID/randomUUID))
        op2-id (str (UUID/randomUUID))
        op3-id (str (UUID/randomUUID))
        ts1 "2026-05-28T13:02:00Z"
        ts2 "2026-05-28T13:02:01Z"
        ts3 "2026-05-28T13:02:02Z"
        skip-row! @#'tailer/skip-row-by-advancing-cursor!]
    (insert-operation! plaid.fixtures/db op1-id ts1)
    (insert-audit-rows! plaid.fixtures/db op1-id ts1 1)
    (insert-operation! plaid.fixtures/db op2-id ts2)
    (insert-malformed-audit-row! plaid.fixtures/db op2-id ts2 0)
    (insert-operation! plaid.fixtures/db op3-id ts3)
    (insert-audit-rows! plaid.fixtures/db op3-id ts3 1)
    (with-redefs [olap/olap-config (constantly (cfg 50))]
      ;; First poll: applies op1 and writes its cursor, then throws on op2.
      (try (tailer/poll-once! plaid.fixtures/db *olap-node*)
           (catch clojure.lang.ExceptionInfo _ nil))
      ;; Cursor at op1 after the first poll (op2's bad row caused the
      ;; throw before its cursor advance could happen). XTDB round-trips
      ;; the UUID-shape op-id, so coerce to str on the read side.
      (let [cur-after-op1 (olap/cursor-read *olap-node*)]
        (is (= op1-id (str (:last-op-id cur-after-op1)))
            "cursor sits at op1 after the throw"))
      ;; Run-loop would write the stall here — simulate.
      (olap/set-stalled! *olap-node*
                         {:op-id op2-id
                          :seq 0
                          :reason "audit row missing post_image for non-delete change"})
      ;; Operator's :skip-current-row? path: skip past op2's bad row,
      ;; then clear the stall flag.
      (skip-row! plaid.fixtures/db *olap-node*)
      (olap/set-running! *olap-node*)
      (let [cur-after-skip (olap/cursor-read *olap-node*)]
        (is (= op2-id (str (:last-op-id cur-after-skip)))
            "skip lands the cursor on the bad row's op so the next batch query strictly skips past it"))
      ;; Next poll: op3 applies cleanly.
      (let [{:keys [applied-ops]} (tailer/poll-once! plaid.fixtures/db *olap-node*)]
        (is (= 1 applied-ops) "op3 applies after skip")
        (let [cursor (olap/cursor-read *olap-node*)]
          (is (= :running (:tailer-status cursor)))
          (is (= op3-id (str (:last-op-id cursor)))
              "cursor advanced past op2 (skipped) to op3 (applied)"))))))

;; ============================================================
;; olap-cursor accessor — direct shape coverage
;; ============================================================
;;
;; The integration test asserts the cursor's existence indirectly via the
;; 425 response body. A direct shape test catches refactors that change
;; the exposed keys without flipping a REST status — operator dashboards
;; consume this shape.

(deftest olap-cursor-returns-canonical-running-shape
  ;; The integration test surfaces this indirectly via 425 / /health; this
  ;; pins the exact key set so a refactor that drops a field surfaces here
  ;; rather than as a frontend complaint.
  ;;
  ;; We apply the cursor directly via `cursor->tx-op` rather than driving
  ;; the full poll-once! pipeline. The poll path is exercised end-to-end
  ;; by the other tests in this ns; here the load-bearing question is
  ;; "does `olap-cursor` expose the right keys with the right types?".
  ;; The direct-write avoids any cross-test OLTP state leak.
  (let [op-id (UUID/randomUUID)
        ts "2026-05-29T01:00:00Z"]
    (xt/submit-tx *olap-node*
                  [(olap/cursor->tx-op {:last-op-ts ts
                                        :last-op-id op-id
                                        :last-seq 3
                                        :tailer-status :running})])
    (let [c (olap-doc/olap-cursor *olap-node*)]
      (is (some? c) "cursor exposed via the accessor")
      (is (= ts (:ts c)) ":ts is the cursor's last-op-ts as ISO string")
      (is (= op-id (:op-id c))
          ":op-id is the cursor's last-op-id (round-trips as UUID)")
      (is (= 3 (:seq c)) ":seq is the cursor's last-seq")
      (is (= :running (:status c))
          ":status reflects tailer-status"))))

(deftest olap-cursor-surfaces-stalled-status
  ;; Pin the stalled-status branch of olap-cursor — a stalled tailer is
  ;; what /health and 425/503 responses surface to operators. The
  ;; `:stall-reason` lives on the underlying cursor doc; `olap-cursor`
  ;; only exposes `:status` today, but the stalled state must be visible.
  (olap/set-stalled! *olap-node*
                     {:op-id (str (UUID/randomUUID))
                      :seq 3
                      :reason "test stall"})
  (let [c (olap-doc/olap-cursor *olap-node*)]
    (is (= :stalled (:status c))
        "stalled status propagates through the public accessor"))
  ;; Underlying cursor still carries the diagnostic reason for /health
  ;; reads (which consult olap/cursor-read directly).
  (let [raw (olap/cursor-read *olap-node*)]
    (is (re-find #"test stall" (:stall-reason raw))
        "stall-reason preserved on the raw cursor doc")))

(deftest olap-cursor-returns-nil-on-fresh-node
  ;; Cold-start case: no cursor has been written. `olap-cursor` returns
  ;; nil rather than throwing — /health treats nil as "not ready" without
  ;; a 500.
  (is (nil? (olap-doc/olap-cursor *olap-node*))
      "fresh node with no cursor returns nil"))

;; ============================================================
;; fetch-batch-with-grow escalation cap
;; ============================================================
;;
;; The grow ladder is [4 16 1024]. The first two are routine — a single
;; oversized op fits inside `batch-size * 16` for any plausible workload.
;; The 1024 entry is the sanity cap; past that, the loop throws
;; `:tailer/op-too-large` rather than escalate to an unbounded LIMIT (the
;; old behaviour, which would pull a runaway 10M-row op into the heap).
;;
;; A real cap-hit test needs > 1024×batch-size rows, which is too
;; expensive to materialise here. Instead we exercise the recursion-limit
;; branch directly by re-binding the multipliers to an empty vector — the
;; loop then exits immediately and must throw. The 4×→fits path is
;; already covered by `oversized-op-rows-do-not-stall-tailer` above.
;; The `(+ batch-size 1)` case below also confirms the first multiplier
;; fits a deliberately-too-large-for-batch op without hitting the cap.

(deftest fetch-batch-with-grow-applies-op-exceeding-batch-size-by-one
  ;; Smallest possible "oversized" op (batch-size + 1 rows) — the first
  ;; grow multiplier (4×) trivially fits it. Pinned separately from the
  ;; bigger oversized test because the off-by-one boundary at exactly
  ;; (inc batch-size) rows is the one drop-trailing-partial triggers on.
  (let [batch-size 5
        op-id (str (UUID/randomUUID))
        ts "2026-05-28T15:00:00Z"]
    (insert-operation! plaid.fixtures/db op-id ts)
    (insert-audit-rows! plaid.fixtures/db op-id ts (inc batch-size))
    (with-redefs [olap/olap-config (constantly (cfg batch-size))]
      (let [{:keys [applied-ops rows-consumed]}
            (tailer/poll-once! plaid.fixtures/db *olap-node*)]
        (is (= 1 applied-ops))
        (is (= (inc batch-size) rows-consumed)
            "the first grow multiplier comfortably fits a (batch-size + 1)-row op")))))

(deftest fetch-batch-with-grow-throws-when-all-multipliers-exhausted
  ;; Recursion-limit unit test: re-bind the multipliers to an empty
  ;; vector and assert that an oversized op throws `:tailer/op-too-large`
  ;; rather than escalating to an unbounded scan.
  (let [batch-size 5
        op-id (str (UUID/randomUUID))
        ts "2026-05-28T15:01:00Z"]
    (insert-operation! plaid.fixtures/db op-id ts)
    (insert-audit-rows! plaid.fixtures/db op-id ts (+ batch-size 3))
    (with-redefs [olap/olap-config (constantly (cfg batch-size))
                  ;; Force the grow loop to exit on the first iteration
                  ;; without finding a fitting multiplier — the cap-hit
                  ;; branch is structurally identical, just at a real
                  ;; multiplier of 1024 we can't afford to populate.
                  tailer/fetch-grow-multipliers []]
      (let [thrown (try
                     (tailer/poll-once! plaid.fixtures/db *olap-node*)
                     nil
                     (catch clojure.lang.ExceptionInfo e e))]
        (is (some? thrown) "exhausted multipliers must throw, not return empty")
        (is (= :tailer/op-too-large (:type (ex-data thrown)))
            "ex-data :type drives the run-loop's stall classification")))))

;; ============================================================
;; Run-loop catch pipeline (end-to-end stall surfacing)
;; ============================================================
;;
;; Per-piece tests cover poll-once! throwing on a malformed row, and
;; set-stalled! flipping the cursor. The end-to-end question — does the
;; run-loop's catch block actually CALL set-stalled! when poll-once!
;; throws? — is not pinned anywhere. A regression in the catch (caught
;; wrong type, didn't extract ex-data's :op-id/:seq, didn't call
;; set-stalled!) would leave the loop spinning silently.

(deftest run-loop-catch-pipeline-surfaces-stall-end-to-end
  ;; Spawn the real run-loop! against a malformed audit row, then poll
  ;; the cursor until it reflects :tailer-status :stalled. If we hit
  ;; the timeout the catch block is broken — the run-loop swallowed
  ;; the throw without recording it.
  (let [ds plaid.fixtures/db
        node *olap-node*
        op-id (str (UUID/randomUUID))
        ts "2026-05-28T16:00:00Z"]
    (insert-operation! ds op-id ts)
    (insert-malformed-audit-row! ds op-id ts 0)
    (with-redefs [olap/olap-config (constantly
                                    {:enabled? true
                                     :cold-replay-on-empty? true
                                     :tailer {:batch-size 50
                                              :poll-interval-ms 50}})]
      (let [done (#'tailer/run-loop! ds node (olap/olap-config))]
        (try
          ;; Wake the loop immediately rather than waiting out the
          ;; heartbeat, then poll the cursor for the stall flag. The
          ;; loop runs poll-once! → catches → set-stalled! → exits
          ;; (running? false on next iteration).
          (olap/nudge!)
          (let [deadline (+ (System/currentTimeMillis) 5000)
                stalled-cursor
                (loop []
                  (let [c (olap/cursor-read node)]
                    (cond
                      (= :stalled (:tailer-status c)) c
                      (>= (System/currentTimeMillis) deadline) nil
                      :else (do (Thread/sleep 25) (recur)))))]
            (is (some? stalled-cursor)
                "run-loop's catch must flip the cursor to :stalled within the deadline")
            (is (= :stalled (:tailer-status stalled-cursor))
                "tailer-status flipped via set-stalled!")
            (is (string? (:stall-reason stalled-cursor))
                ":stall-reason populated — confirms the catch read the throwable and called set-stalled!")
            (is (re-find #"malformed|post_image|JSON|missing"
                         (:stall-reason stalled-cursor))
                ":stall-reason captures the underlying ex-message, not just a generic stall placeholder"))
          (finally
            ;; Loop has already exited (stall sets running? false on the
            ;; next iteration); close stop-chan to clear the atom slot
            ;; so subsequent deftests start clean. `done` was already
            ;; signaled by the stall-then-exit path.
            (when-let [s @@#'tailer/stop-chan]
              (clojure.core.async/close! s))
            (clojure.core.async/alt!!
              done :done
              (clojure.core.async/timeout 5000) :timeout)))))))

;; ============================================================
;; BUG-A regression: transient SQLITE_BUSY must NOT stall the tailer
;; ============================================================
;;
;; Found live in round-3 play-house: a 5-agent write storm sustained
;; SQLITE_BUSY past the shared pool's busy_timeout=5000, the tailer's
;; audit-log READ (fetch-batch) lost the lock race, and the run-loop's
;; (then blanket) catch latched :tailer-status :stalled — permanently,
;; needing a manual resume!. That contract is for malformed/structural
;; rows (data defects), NOT operational lock contention: SQLITE_BUSY can
;; only come from the read (the apply path writes to XTDB, never SQLite),
;; so the cursor never moved and a retry is always safe. The loop must
;; log+retry and self-heal once the lock clears.

(deftest run-loop-does-not-stall-on-transient-sqlite-busy-and-recovers
  (let [ds plaid.fixtures/db
        node *olap-node*
        op-id (str (UUID/randomUUID))
        ts "2026-05-28T17:00:00Z"
        cfg {:enabled? true
             :cold-replay-on-empty? true
             :tailer {:batch-size 50 :poll-interval-ms 50}}]
    (insert-operation! ds op-id ts)
    (insert-audit-rows! ds op-id ts 1)
    (testing "every audit-log read throws SQLITE_BUSY -> loop retries, never stalls"
      (with-redefs [olap/olap-config (constantly cfg)
                    ;; Each read loses the lock race. The message shape
                    ;; mirrors the live stall_reason that org.sqlite emits.
                    tailer/fetch-batch
                    (fn [& _]
                      (throw (java.sql.SQLException.
                              "[SQLITE_BUSY] The database file is locked (database is locked)")))]
        (let [done (#'tailer/run-loop! ds node cfg)]
          (try
            (olap/nudge!)
            ;; Several poll cycles' worth of transient failures.
            (Thread/sleep 400)
            (let [c (olap/cursor-read node)]
              (is (not= :stalled (:tailer-status c))
                  "a transient SQLITE_BUSY on the read must NOT stall the tailer")
              (is (nil? (:stall-reason c))
                  "no stall-reason recorded for transient lock contention")
              (is (not= op-id (str (:last-op-id c)))
                  "the locked-out op has NOT been applied yet (cursor never advanced)"))
            (finally
              (when-let [s @@#'tailer/stop-chan]
                (clojure.core.async/close! s))
              (clojure.core.async/alt!!
                done :done
                (clojure.core.async/timeout 5000) :timeout))))))
    (testing "lock clears -> a normal poll applies the op; no manual resume! needed"
      (with-redefs [olap/olap-config (constantly cfg)]
        (let [{:keys [applied-ops]} (tailer/poll-once! ds node)]
          (is (= 1 applied-ops)
              "the formerly-locked op applies once contention clears — self-healed")
          (let [c (olap/cursor-read node)]
            (is (= op-id (str (:last-op-id c)))
                "cursor advanced to the formerly-locked op")
            (is (not= :stalled (:tailer-status c))
                "tailer is running — never required an operator resume!")))))))

;; ============================================================
;; BUG-RES regression: resume! must restart a dead loop
;; ============================================================
;;
;; Pre-fix: after the loop exited via stall, `done-chan` held a closed
;; plain channel. `(async/poll! closed-chan)` returns nil, so resume!'s
;; "is the loop dead?" check evaluated to nil → it called set-running!
;; but never re-spawned the loop. The tailer was permanently dead.
;;
;; Post-fix: `done` is a `promise-chan` that buffers `::exited` once at
;; loop exit, so `poll!` returns the sentinel iff the loop is gone.
;; resume! then re-runs `run-loop!`.

(deftest resume-restarts-loop-after-stall
  ;; Avoid the heartbeat-wait timing by exiting via stop-chan instead
  ;; of inducing a real stall. The resume! restart path only cares
  ;; that the prior `done` promise-chan has the `::exited` sentinel
  ;; buffered; how the loop got there doesn't matter for this test.
  (let [ds plaid.fixtures/db
        node *olap-node*
        cfg (-> (olap/olap-config)
                ;; Tight heartbeat so the loop's first alts! returns
                ;; quickly when we close stop.
                (assoc-in [:tailer :poll-interval-ms] 50))
        done1 (#'tailer/run-loop! ds node cfg)]
    (is (identical? done1 @@#'tailer/done-chan)
        "run-loop! installed done1 in the atom")
    (is (nil? (clojure.core.async/poll! done1))
        "fresh promise-chan polls nil while loop is alive")
    ;; Tear down the first loop cleanly via stop, then assert it
    ;; signaled the sentinel.
    (clojure.core.async/close! @@#'tailer/stop-chan)
    (let [[v _] (clojure.core.async/alts!!
                 [done1 (clojure.core.async/timeout 5000)])]
      (is (= ::tailer/exited v) "loop puts ::exited on done before close"))
    (is (some? (clojure.core.async/poll! done1))
        "post-exit, promise-chan poll returns the sentinel forever")
    ;; Critical BUG-RES regression: resume! must spawn a NEW loop, not
    ;; silently no-op. Pre-fix, the (async/poll! closed-plain-chan) check
    ;; returned nil → no spawn → tailer permanently dead.
    (tailer/resume! ds node {})
    (let [done2 @@#'tailer/done-chan]
      (is (not (identical? done1 done2))
          "resume! installed a fresh done-chan (a new loop was spawned)")
      (is (nil? (clojure.core.async/poll! done2))
          "the fresh loop's promise-chan polls nil — loop is alive")
      ;; Teardown the second loop too so we don't leak go-blocks
      ;; across deftests.
      (clojure.core.async/close! @@#'tailer/stop-chan)
      (clojure.core.async/alt!!
        done2 :done
        (clojure.core.async/timeout 5000) :timeout))))

;; ============================================================
;; Dead-knob unit tests (Group D coverage)
;; ============================================================
;;
;; `check-max-lag-warn!` / `check-max-disk-warn!` / `warn-rate-limited!`
;; never had direct coverage — the integration test exercises the loop
;; happy path, where neither knob trips. A refactor that silently broke
;; these checks (e.g. inverting the comparator, dropping the rate limit)
;; would let lag/disk runaway go un-warned in production until an
;; operator noticed in /health. These tests pin the contract on the
;; loop-instance-scoped atoms (`last-lag-warn-at`, `last-disk-warn-at`)
;; rather than fishing log lines out of Timbre — the atom mutation IS
;; the observable side effect the cooldown logic guards.

(defn- reset-warn-atoms! []
  ;; The two atoms are :private — reset via `@#'` so the tests don't
  ;; need to be in the same ns. Cleared before every dead-knob test so
  ;; assertions don't depend on whatever the previous test left behind.
  (reset! @#'tailer/last-lag-warn-at 0)
  (reset! @#'tailer/last-disk-warn-at 0)
  (reset! @#'tailer/poll-counter 0))

(deftest warn-rate-limited-emits-then-suppresses-within-cooldown
  ;; First call: atom at 0, cooldown trivially elapsed → fires.
  ;; Second call: atom at now (set by the first), 0ms since → suppressed.
  ;; The contract is "no spam"; we observe via the atom (a real log
  ;; capture would couple this test to Timbre's appender plumbing).
  (reset-warn-atoms!)
  (let [a (atom 0)
        warn! @#'tailer/warn-rate-limited!]
    (is (true? (warn! a "msg" {}))
        "first call emits — atom was at 0 (way past cooldown)")
    (let [after-first @a]
      (is (pos? after-first) "atom updated to now after emission")
      (is (nil? (warn! a "msg" {}))
          "second call within cooldown is suppressed (no-op)")
      (is (= after-first @a)
          "atom unchanged on suppressed call — fixture for the rate-limit invariant"))))

(deftest check-max-lag-warn-no-op-when-knob-zero
  ;; `:max-lag-warn-ms 0` (or absent) MUST disable the check — operators
  ;; rely on 0/nil to mean "I don't care, don't spam". A regression that
  ;; flips this to "fire on every poll" would dominate the log.
  (reset-warn-atoms!)
  (let [check! @#'tailer/check-max-lag-warn!
        cfg {:tailer {:max-lag-warn-ms 0}}
        ;; The cursor + ds args are irrelevant when the knob is off;
        ;; pass nils so an attempt to read them would throw, surfacing
        ;; a regression as an exception rather than a quiet false pass.
        before @@#'tailer/last-lag-warn-at]
    (check! nil nil cfg)
    (is (= before @@#'tailer/last-lag-warn-at)
        "atom untouched — knob disable bypassed every read path")))

(deftest check-max-lag-warn-fires-when-lag-exceeds-threshold
  ;; Build a real OLTP fixture where the operations max ts is well past
  ;; the cursor's last-op-ts, then call `check-max-lag-warn!` with a
  ;; tight threshold. The atom must advance (= warn emitted) once.
  (reset-warn-atoms!)
  (let [check! @#'tailer/check-max-lag-warn!
        ds plaid.fixtures/db
        op-id (str (UUID/randomUUID))
        ;; 1-minute lag: operations.ts is at 10:01, cursor sits at 10:00.
        op-ts "2026-05-28T10:01:00Z"
        cursor-ts "2026-05-28T10:00:00Z"
        cursor-op-id (UUID/randomUUID)]
    (insert-operation! ds op-id op-ts)
    (insert-audit-rows! ds op-id op-ts 1)
    (let [cursor {:last-op-ts cursor-ts :last-op-id cursor-op-id}
          cfg {:tailer {:max-lag-warn-ms 30000}} ; 30s threshold; 60s lag
          before @@#'tailer/last-lag-warn-at]
      (check! ds cursor cfg)
      (is (> @@#'tailer/last-lag-warn-at before)
          "atom advanced — warn fired because 60s > 30s"))))

(deftest check-max-lag-warn-quiet-when-under-threshold
  (reset-warn-atoms!)
  (let [check! @#'tailer/check-max-lag-warn!
        ds plaid.fixtures/db
        op-id (str (UUID/randomUUID))
        ;; 1s lag — well under a generous 60s threshold.
        op-ts "2026-05-28T10:00:01Z"
        cursor-ts "2026-05-28T10:00:00Z"
        cursor-op-id (UUID/randomUUID)]
    (insert-operation! ds op-id op-ts)
    (insert-audit-rows! ds op-id op-ts 1)
    (let [cursor {:last-op-ts cursor-ts :last-op-id cursor-op-id}
          cfg {:tailer {:max-lag-warn-ms 60000}}
          before @@#'tailer/last-lag-warn-at]
      (check! ds cursor cfg)
      (is (= before @@#'tailer/last-lag-warn-at)
          "atom untouched — 1s lag does not breach a 60s threshold"))))

(deftest check-max-disk-warn-fires-when-over-threshold-on-stride-tick
  ;; The check is gated on `disk-check-stride` (every Nth poll) — so we
  ;; advance the poll counter to land exactly on a stride boundary
  ;; before calling. Stub `olap/disk-bytes` to a value over the
  ;; threshold so the warn-arm path executes deterministically without
  ;; depending on any actual on-disk OLAP node.
  (reset-warn-atoms!)
  (let [check! @#'tailer/check-max-disk-warn!
        stride @#'tailer/disk-check-stride
        ;; The check increments `poll-counter` then takes mod stride.
        ;; Pre-load counter to stride-1 so the call's swap! pushes it to
        ;; stride (mod 0 → triggers the inner branch).
        _ (reset! @#'tailer/poll-counter (dec stride))
        cfg {:tailer {:max-disk-warn-mb 10}}
        before @@#'tailer/last-disk-warn-at]
    ;; 100MB > 10MB threshold → warn must fire on the stride tick.
    (with-redefs [plaid.olap.core/disk-bytes (constantly (* 100 1024 1024))]
      (check! cfg))
    (is (> @@#'tailer/last-disk-warn-at before)
        "atom advanced — warn fired (over-threshold && stride boundary)")))

(deftest check-max-disk-warn-no-op-when-knob-zero
  (reset-warn-atoms!)
  (let [check! @#'tailer/check-max-disk-warn!
        cfg {:tailer {:max-disk-warn-mb 0}}
        before @@#'tailer/last-disk-warn-at]
    (check! cfg)
    (is (= before @@#'tailer/last-disk-warn-at)
        "atom untouched — 0 disables the check")))

(deftest check-max-disk-warn-skips-non-stride-polls
  ;; Within a stride window the check is a no-op, regardless of how far
  ;; over-threshold the disk is. Operators rely on this to keep
  ;; `file-seq` off the hot path. Pre-load the counter to 0 so the call
  ;; lands at 1 (mod stride = 1, NOT 0) and never enters the inner
  ;; branch.
  (reset-warn-atoms!)
  (let [check! @#'tailer/check-max-disk-warn!
        cfg {:tailer {:max-disk-warn-mb 10}}
        before @@#'tailer/last-disk-warn-at]
    (reset! @#'tailer/poll-counter 0) ; next swap! lands at 1
    (with-redefs [plaid.olap.core/disk-bytes (constantly (* 100 1024 1024))]
      (check! cfg))
    (is (= before @@#'tailer/last-disk-warn-at)
        "atom untouched — non-stride poll skips disk read entirely")))

;; ============================================================
;; Progress logging unit tests (Group D coverage)
;; ============================================================
;;
;; `maybe-log-progress!` + `maybe-log-caught-up!` are loop-instance-state
;; mutators wrapped around `log/info` calls. The state atoms
;; (`rows-applied-since-start`, `was-lagging?`, `last-progress-logged-at`)
;; are what the cold-replay milestone cadence relies on; verify the
;; atoms move at the stride boundary, on the first lagging→caught-up
;; edge, and NOT on subsequent caught-up calls.

(defn- reset-progress-atoms! []
  (reset! @#'tailer/rows-applied-since-start 0)
  (reset! @#'tailer/last-progress-logged-at 0)
  (reset! @#'tailer/was-lagging? false))

(deftest maybe-log-progress-fires-on-stride-boundary
  ;; The stride is 50000 — apply ≥50000 rows in a single call and the
  ;; milestone atom must advance. Smaller counts (here: 1000) leave it
  ;; untouched. Drives the `quot` arithmetic without needing to log-
  ;; capture.
  (reset-progress-atoms!)
  (let [maybe-log! @#'tailer/maybe-log-progress!
        stride @#'tailer/cold-replay-log-stride
        cursor {:last-op-ts "2026-05-28T10:00:00Z" :last-op-id (UUID/randomUUID)}]
    (maybe-log! cursor 1000)
    (is (zero? @@#'tailer/last-progress-logged-at)
        "1000 rows < stride → no milestone advance")
    (is (= 1000 @@#'tailer/rows-applied-since-start)
        "rows-applied counter still ticks")
    ;; Push over the stride: 49000 + earlier 1000 = 50000.
    (maybe-log! cursor 49000)
    (is (= stride @@#'tailer/last-progress-logged-at)
        "crossing the stride boundary advances the milestone atom")))

(deftest maybe-log-progress-no-op-on-zero-rows
  ;; Idle wakeups land here with rows-consumed=0; must not bump the
  ;; counter (otherwise progress lines fire on every heartbeat).
  (reset-progress-atoms!)
  (let [maybe-log! @#'tailer/maybe-log-progress!
        cursor {:last-op-ts "x" :last-op-id (UUID/randomUUID)}]
    (maybe-log! cursor 0)
    (is (zero? @@#'tailer/rows-applied-since-start)
        "0 rows → counter untouched")
    (is (zero? @@#'tailer/last-progress-logged-at))))

(deftest maybe-log-caught-up-flips-on-lagging-to-zero-edge
  ;; Two-step: first call with non-zero lag sets the lagging flag,
  ;; second call with zero clears it. The flag is the load-bearing atom
  ;; — the log line itself is fire-and-forget.
  (reset-progress-atoms!)
  (let [maybe-caught! @#'tailer/maybe-log-caught-up!
        cursor {:last-op-ts "y" :last-op-id (UUID/randomUUID)}]
    (maybe-caught! cursor 5)
    (is (true? @@#'tailer/was-lagging?)
        "non-zero lag flips the lagging flag on")
    (maybe-caught! cursor 0)
    (is (false? @@#'tailer/was-lagging?)
        "zero lag after lagging clears the flag (the caught-up edge)")))

(deftest maybe-log-caught-up-no-double-fire-when-already-caught-up
  ;; The contract: the caught-up log fires EXACTLY ONCE per edge.
  ;; Calling repeatedly while already caught-up must not flip the flag
  ;; or re-fire — a regression here would emit a "caught up" line on
  ;; every heartbeat during idle.
  (reset-progress-atoms!)
  (let [maybe-caught! @#'tailer/maybe-log-caught-up!
        cursor {:last-op-ts "z" :last-op-id (UUID/randomUUID)}]
    (maybe-caught! cursor 0) ; never lagging in the first place — no-op
    (is (false? @@#'tailer/was-lagging?))
    (maybe-caught! cursor 0) ; second zero-lag call — still no-op
    (is (false? @@#'tailer/was-lagging?)
        "repeated zero-lag calls keep the flag at false — no spurious 'caught up' edge")))
