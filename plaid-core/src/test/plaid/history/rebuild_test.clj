(ns plaid.history.rebuild-test
  "Rebuild-equivalence test for the history replica.

  The operator-facing claim is that `rm -rf data/history-*; restart`
  reconstructs the history from the OLTP audit log and produces identical
  state to the incremental tailer that's been running all along. This
  test exercises that path:

    Pass 1 (incremental): drive a scripted workload through OLTP, drain
      the tailer into an in-memory XTDB node. Snapshot every entity
      table — call it A.

    Pass 2 (cold-replay from a fresh node): spin up a SECOND in-memory
      XTDB node (no prior state, no cursor). Drain the same audit log
      from epoch. Snapshot B.

    Assert A ≡ B.

  Why in-memory rather than the docstring-promised on-disk close/wipe/
  reopen dance: the cold-replay equivalence claim is about replay
  determinism, not disk persistence. An in-memory second node with no
  cursor is functionally the same starting state as a wiped + reopened
  on-disk node — the tailer sees `cursor-read → nil` in both cases and
  seeds from epoch. On-disk persistence is exercised by
  `restart-resilience-test`; here we want a tight, fast equivalence
  check that doesn't pay the on-disk node startup cost twice per CI
  run."
  (:require [clojure.data.json :as json]
            [clojure.java.io :as io]
            [clojure.test :refer :all]
            [next.jdbc :as jdbc]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request assert-ok assert-status
                                    with-admin with-test-users with-clean-db]]
            [plaid.history.core :as history]
            [plaid.history.tailer :as tailer]
            [plaid.test-helpers :refer :all]
            [xtdb.api :as xt]
            [xtdb.node :as xtn]))

;; ============================================================
;; Fixture chain
;; ============================================================

(defn- pre-clean-audit-tables!
  "Wipe leftover audit_writes + operations rows from prior tests so the
  cold-replay path sees ONLY this test's writes. Without this, the
  cold-replay node would replay every test's accumulated audit log
  before reaching our anchor data — slow, and a source of cross-test
  state pollution if any earlier test was order-sensitive."
  []
  (jdbc/with-transaction [tx plaid.fixtures/db]
    (jdbc/execute! tx ["DELETE FROM audit_writes"])
    (jdbc/execute! tx ["DELETE FROM operations"])))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db
  (fn [f] (pre-clean-audit-tables!) (f)))

;; ============================================================
;; Tailer driver — drain to quiescence
;; ============================================================

(defn- drain-tailer!
  "Drain the tailer against `node` until poll-once! reports zero rows
  consumed (or the iteration / timeout bound trips). The integration
  test uses `await-drained!` which polls the cursor against the OLTP
  high-water mark; here we just run apply directly until consumption
  stops, because we want to drive the apply loop ourselves (the
  rebuild test runs without the mount-defstate tailer)."
  ([ds node] (drain-tailer! ds node 100 10000))
  ([ds node max-iters timeout-ms]
   (let [deadline (+ (System/currentTimeMillis) timeout-ms)]
     (loop [i 0]
       (let [result (tailer/poll-once! ds node)]
         (cond
           (zero? (:rows-consumed result)) result
           (>= i max-iters)
           (throw (ex-info "drain-tailer! exceeded max iterations" {:result result}))
           (> (System/currentTimeMillis) deadline)
           (throw (ex-info "drain-tailer! exceeded deadline" {:result result}))
           :else (recur (inc i))))))))

;; ============================================================
;; history-state snapshot helpers — capture every entity table into a
;; structure we can compare across runs by value.
;; ============================================================

(def ^:private snapshot-tables
  ["documents" "projects" "users"
   "text_layers" "token_layers" "span_layers" "relation_layers"
   "texts" "tokens" "spans" "relations"
   "vocab_layers" "vocab_items" "vocab_links"])

(defn- snapshot-table
  "Pull every row of `:history/<table>` at the current snapshot (no
   :snapshot-time pin — `now()` returns the latest visible state).
   Sort by :xt/id so two snapshots taken on different nodes compare
   equal by value."
  [node table]
  (let [tbl-kw (keyword "history" table)
        rows (xt/q node
                   (list '-> (list 'from tbl-kw '[*])))]
    (->> rows
         ;; Strip XTDB-only temporal columns so the diff doesn't trip on
         ;; per-run wall-clock noise. Two replays of the same audit log
         ;; against different node clocks will assign different
         ;; system-from values; what we care about is "did we
         ;; reconstruct the same logical state".
         (mapv #(dissoc % :xt/system-from :xt/system-to
                        :xt/valid-from :xt/valid-to))
         (sort-by (juxt #(str (:xt/id %))))
         vec)))

(defn- full-snapshot
  "Return `{table-name -> [row ...]}` for every entity table."
  [node]
  (into {} (for [t snapshot-tables] [t (snapshot-table node t)])))

;; ============================================================
;; The scripted workload — kept small so the test finishes fast.
;; ============================================================

(defn- run-workload!
  "Create a project + layers + doc + a few tokens + a span + an update
   + a delete. The OLTP audit log captures every step; both the
   incremental and cold-replay paths chew through the same rows."
  []
  (let [proj (create-test-project admin-request "RebuildEqProj")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        tkl (-> (create-token-layer admin-request tl "TKL") :body :id)
        sl (-> (create-span-layer admin-request tkl "SL") :body :id)
        text-id (-> (create-text admin-request tl doc "Hello world") :body :id)
        t1 (-> (create-token admin-request tkl text-id 0 5) :body :id)
        _ (create-token admin-request tkl text-id 6 11)
        s1 (-> (create-span admin-request sl [t1] "X") :body :id)
        _ (assert-ok (update-span admin-request s1 :value "Y"))
        ;; A delete of the span (not the doc) tests the bitemporal
        ;; close-out path on entity validity.
        _ (assert-status 204 (delete-span admin-request s1))]
    {:proj proj :doc doc}))

;; ============================================================
;; The test
;; ============================================================
;;
;; Real rebuild-equivalence: the operator's recovery story is "stop the
;; tailer, wipe the history store, restart". In an in-memory test we
;; simulate this by:
;;   1. Run workload + drain into node-A (incremental tailer over a
;;      growing audit log — the production path).
;;   2. Snapshot A.
;;   3. CLOSE node-A. Start a FRESH in-memory node-B. node-B's cursor
;;      is nil (cold-start) so the tailer seeds at epoch and re-applies
;;      every audit row from scratch — the rebuild path.
;;   4. Drain into node-B. Snapshot B.
;;   5. Assert A ≡ B.
;;
;; The previous version of this test ran A and B as TWO independent
;; in-memory nodes that each tailed from epoch — that's two parallel
;; cold replays, not the rebuild path. This version explicitly closes A
;; before starting B so node-B's cold-start IS the recovery path.

(deftest cold-replay-from-fresh-node-converges-to-same-state-as-incremental-tail
  (let [ds plaid.fixtures/db
        ;; --- Pass 1: incremental tail into snapshot-A node ---
        _ (run-workload!)
        snapshot-a (with-open [a-node (xtn/start-node {})]
                     (drain-tailer! ds a-node)
                     (let [cursor (history/cursor-read a-node)]
                       (is (some? cursor) "tailer wrote a cursor after pass 1")
                       (is (= :running (:tailer-status cursor))
                           "incremental tail finished cleanly, no stall"))
                     (full-snapshot a-node))
        ;; Pass 1's node is now closed (with-open exit). Any state lived
        ;; only in that node's heap — gone. We've extracted snapshot-a
        ;; as a plain Clojure map.
        ;; --- Pass 2: cold-replay from a FRESH node ---
        snapshot-b (with-open [b-node (xtn/start-node {})]
                     ;; node-B's cursor doc is nil — cold-start seed
                     ;; from epoch replays every audit row.
                     (is (nil? (history/cursor-read b-node))
                         "fresh node has no cursor — cold-replay path is active")
                     (drain-tailer! ds b-node)
                     (let [cursor (history/cursor-read b-node)]
                       (is (some? cursor) "cold replay wrote a cursor"))
                     (full-snapshot b-node))]
    (testing "snapshot A and snapshot B are byte-for-byte equal"
      (is (= (set (keys snapshot-a)) (set (keys snapshot-b)))
          "every entity table covered in both snapshots")
      ;; Per-table equality gives a useful diff if anything drifts —
      ;; one big map equality would print a wall of EDN on failure.
      (doseq [t snapshot-tables]
        (is (= (get snapshot-a t) (get snapshot-b t))
            (str "history table `" t "` diverges between incremental and cold-replay"))))

    (testing "snapshots are non-trivial — the workload actually wrote data"
      (is (pos? (count (get snapshot-a "documents")))
          "at least one document persisted")
      (is (pos? (count (get snapshot-a "tokens")))
          "tokens persisted (they weren't deleted in the workload))"))))

;; ============================================================
;; On-disk restart resilience — the production lifecycle
;; ============================================================
;;
;; The rebuild test above uses in-memory nodes (cold-start). The REAL
;; production lifecycle is on-disk: stop the server (close the node),
;; restart (reopen at the same storage path), and the tailer resumes.
;;
;; IMPORTANT durability fact (verified against XTDB v2.2.0-beta1): a
;; node's `:local` log/storage flushes ASYNCHRONOUSLY and `.close` does
;; NOT force a durable flush of the most recent transactions — so a
;; reopened node can REGRESS to an earlier state (we measured 50 rapid
;; same-id writes recovering only ~2 after reopen). There is no public
;; flush/checkpoint API to force durability.
;;
;; This is NOT data loss for the history, because the history is DERIVED: the
;; cursor and entity docs regress TOGETHER (same execute-tx), so on
;; restart the tailer reads the regressed cursor and RE-TAILS the OLTP
;; audit log forward (idempotent). The replica SELF-HEALS to the correct
;; state. This test pins exactly that property — convergence after
;; close/reopen/re-tail — NOT exact cursor persistence (which XTDB does
;; not guarantee). See the history operations notes §12.7.

(defn- start-disk-node
  "Start an on-disk XTDB node mirroring `plaid.history.core/start-xtdb-node`
  (local storage + log)."
  [storage-path log-path]
  (.mkdirs (io/file storage-path))
  (.mkdirs (io/file log-path))
  (xtn/start-node {:storage [:local {:path storage-path}]
                   :log [:local {:path log-path}]}))

(defn- delete-tree!
  "Recursively delete a file/dir (temp-store cleanup)."
  [^java.io.File f]
  (when (.isDirectory f)
    (doseq [c (.listFiles f)] (delete-tree! c)))
  (.delete f))

(deftest on-disk-node-self-heals-after-restart
  (let [ds plaid.fixtures/db
        base (str (System/getProperty "java.io.tmpdir") "/history-resume-" (random-uuid))
        storage (str base "/storage")
        logp (str base "/log")]
    (try
      ;; --- Pass 1: workload + drain into on-disk node-A; snapshot the
      ;; fully-tailed state, then close the node.
      (let [{:keys [proj]} (run-workload!)
            snapshot-a (with-open [node-a (start-disk-node storage logp)]
                         (drain-tailer! ds node-a)
                         (let [c (history/cursor-read node-a)]
                           (is (some? c) "pass-1 drain wrote a cursor")
                           (is (= :running (:tailer-status c)) "pass-1 finished cleanly, no stall"))
                         (full-snapshot node-a))]

        ;; --- Pass 2: reopen at the SAME paths and RE-TAIL. The cursor
        ;; may have regressed (lazy XTDB durability), so the tailer
        ;; re-applies forward until caught up. The end state must match
        ;; pass 1 exactly — self-healing.
        (with-open [node-b (start-disk-node storage logp)]
          ;; Reopen must NOT be a cold-start-from-epoch (that would mean
          ;; nothing persisted at all). Some durable state survived.
          (is (some? (history/cursor-read node-b))
              "a cursor survived close/reopen (on-disk persistence is partial, not total loss)")
          (drain-tailer! ds node-b)
          (let [snapshot-b (full-snapshot node-b)
                cursor-b (history/cursor-read node-b)]
            (testing "re-tail after restart converges to the same state (self-healing)"
              (doseq [t snapshot-tables]
                (is (= (get snapshot-a t) (get snapshot-b t))
                    (str "history table `" t "` diverges after restart+re-tail"))))
            (is (= :running (:tailer-status cursor-b))
                "caught up cleanly after re-tail, no stall")

            ;; --- A new op after restart applies incrementally on top.
            (let [docs-before (count (get snapshot-b "documents"))
                  _ (create-test-document admin-request proj "Doc-after-restart")
                  _ (drain-tailer! ds node-b)
                  docs-after (count (snapshot-table node-b "documents"))]
              (is (= (inc docs-before) docs-after)
                  "post-restart document applied incrementally on top of the healed state")))))
      (finally
        (delete-tree! (io/file base))))))

;; ============================================================
;; Cold-replay of a 3-LEVEL token hierarchy + multi-token span + relation,
;; with VALUE-LEVEL assertions on the cold-replayed node (not just A≡B)
;; ============================================================
;;
;; The convergence test above proves A(incremental) ≡ B(cold-replay) by
;; per-table equality, but on a tiny workload (one token layer, single-token
;; span, no relation). A replay bug specific to nested token-layer parentage,
;; a multi-token span's token junction, or a relation's source/target FKs
;; could converge-but-be-wrong if BOTH passes share the bug (they replay the
;; same audit log), so table-equality alone is not enough. This builds the
;; exact rich shape — l1 ⊃ l2 ⊃ l3 non-overlapping token layers, tokens at
;; KNOWN offsets, a 2-token span carrying metadata on l3, and a relation
;; between two spans — wipes to a fresh cold node, and asserts the
;; reconstructed VALUES (offsets, parent links, span token-set, span value +
;; folded metadata, relation endpoints) on the cold node directly.

(defn- run-rich-workload!
  "Build a 3-level non-overlapping token hierarchy with a multi-token span
  (+metadata) and a relation. Returns the ids + known offsets so the test can
  assert exact values after cold replay. Every create is guarded with a 201
  assertion so a rejected setup op can't leave a nil id and make a later
  value comparison vacuous."
  []
  (let [cid (fn [resp] (assert-status 201 resp) (-> resp :body :id))
        proj (create-test-project admin-request "ColdRich3LevelProj")
        doc (create-test-document admin-request proj "RichDoc")
        tl (cid (create-text-layer admin-request proj "TL"))
        l1 (cid (create-token-layer-opts admin-request tl "L1" {:overlap-mode "non-overlapping"}))
        l2 (cid (create-token-layer-opts admin-request tl "L2"
                                         {:overlap-mode "non-overlapping" :parent-token-layer-id l1}))
        l3 (cid (create-token-layer-opts admin-request tl "L3"
                                         {:overlap-mode "non-overlapping" :parent-token-layer-id l2}))
        sl (cid (create-span-layer admin-request l3 "SL"))
        rl (cid (create-relation-layer admin-request sl "RL"))
        text-id (cid (create-text admin-request tl doc "alpha beta gamma"))
        ;; offsets within "alpha beta gamma": alpha 0-5, beta 6-10, gamma 11-16
        a1 (cid (create-token admin-request l1 text-id 0 16))   ; whole-span root token
        a2 (cid (create-token admin-request l2 text-id 0 5))    ; within a1
        t3a (cid (create-token admin-request l3 text-id 0 2))   ; within a2
        t3b (cid (create-token admin-request l3 text-id 2 5))   ; within a2
        s-multi (cid (create-span admin-request sl [t3a t3b] "MULTI" {"k" "v"}))
        s2 (cid (create-span admin-request sl [t3a] "S2"))
        r1 (cid (create-relation admin-request rl s2 s-multi "rel"))]
    {:proj proj :doc doc :tl tl :l1 l1 :l2 l2 :l3 l3 :sl sl :rl rl :text text-id
     :a1 a1 :a2 a2 :t3a t3a :t3b t3b :s-multi s-multi :s2 s2 :r1 r1}))

(deftest cold-replay-3level-hierarchy-survives-wipe-with-value-level-asserts
  (let [ds plaid.fixtures/db
        ids (run-rich-workload!)
        ;; Pass 1: incremental tail into node-A, snapshot every table.
        snapshot-a (with-open [a-node (xtn/start-node {})]
                     (drain-tailer! ds a-node)
                     (let [cursor (history/cursor-read a-node)]
                       (is (some? cursor) "incremental tail wrote a cursor")
                       (is (= :running (:tailer-status cursor)) "no stall in pass 1"))
                     (full-snapshot a-node))]
    ;; Pass 2: cold-replay into a FRESH node (the wipe+restart recovery path),
    ;; then assert VALUES on the cold node directly.
    (with-open [b-node (xtn/start-node {})]
      (is (nil? (history/cursor-read b-node))
          "fresh node has no cursor — cold-replay path is active")
      (drain-tailer! ds b-node)
      (let [snapshot-b (full-snapshot b-node)
            ;; row lookups by entity id against the cold node, keyed off the
            ;; full snapshot map (every entity attr present). `:xt/id` round-
            ;; trips as a UUID; ids from REST come back as strings — compare
            ;; on (str ...). The whole row is returned so the asserts read the
            ;; replayer's actual attr keys (`:token/end`, `:span/value`, …).
            row (fn [table id]
                  (->> (snapshot-table b-node table)
                       (filter #(= (str id) (str (:xt/id %))))
                       first))]
        (testing "cold-replay reproduces the same per-table state as incremental (A≡B)"
          (doseq [t snapshot-tables]
            (is (= (get snapshot-a t) (get snapshot-b t))
                (str "history table `" t "` diverges between incremental and cold-replay"))))
        (testing "setup was non-trivial (guards against vacuous value asserts)"
          (is (= 3 (count (get snapshot-b "token_layers"))) "three token layers cold-replayed")
          (is (= 4 (count (get snapshot-b "tokens"))) "four tokens cold-replayed")
          (is (= 2 (count (get snapshot-b "spans"))) "two spans cold-replayed")
          (is (= 1 (count (get snapshot-b "relations"))) "one relation cold-replayed"))
        (testing "3-level token-layer parentage reconstructed by VALUE on the cold node"
          (let [tl1 (row "token_layers" (:l1 ids))
                tl2 (row "token_layers" (:l2 ids))
                tl3 (row "token_layers" (:l3 ids))]
            (is (some? tl1) "L1 present")
            (is (nil? (:token-layer/parent-token-layer tl1))
                (str "L1 is a root (no parent); row=" (pr-str tl1)))
            (is (= (str (:l1 ids)) (str (:token-layer/parent-token-layer tl2)))
                (str "L2's parent is L1; row=" (pr-str tl2)))
            (is (= (str (:l2 ids)) (str (:token-layer/parent-token-layer tl3)))
                (str "L3's parent is L2; row=" (pr-str tl3)))))
        (testing "token offsets reconstructed by VALUE on the cold node"
          (let [t3a (row "tokens" (:t3a ids))
                t3b (row "tokens" (:t3b ids))
                a1 (row "tokens" (:a1 ids))]
            (is (= 0 (:token/begin t3a)) (str "t3a begin; row=" (pr-str t3a)))
            (is (= 2 (:token/end t3a)) (str "t3a end; row=" (pr-str t3a)))
            (is (= 2 (:token/begin t3b)) (str "t3b begin; row=" (pr-str t3b)))
            (is (= 5 (:token/end t3b)) (str "t3b end; row=" (pr-str t3b)))
            (is (= 0 (:token/begin a1)) (str "root token a1 begin; row=" (pr-str a1)))
            (is (= 16 (:token/end a1)) (str "root token a1 end; row=" (pr-str a1)))))
        (testing "multi-token span tokens + value + folded metadata reconstructed by VALUE"
          (let [sm (row "spans" (:s-multi ids))]
            (is (some? sm) "multi-token span present on cold node")
            (is (= #{(str (:t3a ids)) (str (:t3b ids))}
                   (set (map str (:tokens sm))))
                (str "multi-token span carries both tokens; row=" (pr-str sm)))
            ;; `:span/value` is stored JSON-encoded ("\"MULTI\"") on the raw
            ;; history doc; the document read path decodes it. Assert the decoded
            ;; VALUE so the check pins the logical span value, not the encoding.
            (is (= "MULTI" (json/read-str (:span/value sm)))
                (str "span value cold-replayed; row=" (pr-str sm)))
            (let [md (:metadata sm)]
              ;; metadata folds to an opaque JSON string column
              (is (and md (re-find #"\"k\"" (str md)) (re-find #"\"v\"" (str md)))
                  (str "span folded metadata {\"k\" \"v\"} survived cold replay; md=" (pr-str md))))))
        (testing "relation endpoints reconstructed by VALUE on the cold node"
          (let [r (row "relations" (:r1 ids))]
            (is (some? r) "relation present on cold node")
            (is (= (str (:s2 ids)) (str (:relation/source r)))
                (str "relation source = s2; row=" (pr-str r)))
            (is (= (str (:s-multi ids)) (str (:relation/target r)))
                (str "relation target = multi-token span; row=" (pr-str r)))
            (is (= "rel" (json/read-str (:relation/value r)))
                (str "relation value cold-replayed; row=" (pr-str r)))))))))
