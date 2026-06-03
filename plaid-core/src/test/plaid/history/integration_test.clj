(ns plaid.history.integration-test
  "End-to-end history integration tests driven entirely through the REST
  surface.

  Every assertion goes through `GET /api/v1/documents/{id}?as-of=<ts>`.
  This is the contract we ship: any regression that breaks the
  user-facing time-travel path surfaces here (the previous direct-XTQL
  version hid a storage-column-naming bug for weeks because the test
  reached past the read API).

  Synchronization is via `tailer/await-drained!` — `Thread/sleep` would
  either be flaky (too short) or slow (too long), and `poll-once!`
  bypasses the commit-side nudge path we want to exercise.

  Why per-test history nodes (and not one shared node across the ns):
   - Each test wants a clean cursor so `await-drained!` only waits for
     THIS test's writes, not any leftover from sibling tests.
   - In-memory XTDB nodes start in <100ms; the cost is negligible
     relative to a typical deftest.

  Note on standing user audit rows: the `with-admin` + `with-test-users`
  fixtures create users in :once setup, which generates `audit_writes`
  rows whose `target_id` is the username/email string (not a UUID).
  The replayer is built to handle non-UUID ids — this fixture used to
  pre-clean those rows as a workaround, but that was masking a real
  regression: a future replayer change that re-tightens to UUIDs only
  would silently pass the integration suite. We let those rows replay
  into the per-test history node so every scenario implicitly proves the
  non-UUID path still works."
  (:require [clojure.core.async :as async]
            [clojure.test :refer :all]
            [clojure.walk :as walk]
            [next.jdbc :as jdbc]
            [next.jdbc.result-set :as rs]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request api-call assert-created assert-ok
                                    assert-status with-admin with-test-users
                                    user1-request user2-request with-clean-db]]
            [plaid.history.core :as history]
            [plaid.history.tailer :as tailer]
            [plaid.server.middleware :as smw]
            [plaid.test-helpers :refer :all]
            [xtdb.node :as xtn])
  (:import (java.time Instant)))

;; ============================================================
;; Fixture chain
;; ============================================================

(def ^:dynamic ^:private *history-node* nil)

(defn- with-test-history-node
  "Spin up a fresh in-memory XTDB node + a real tailer go-loop per test,
   and redef history state so `submit-operation*`'s nudge reaches the loop.

   Drain any stale nudges from prior tests BEFORE starting the loop so
   the new loop's first wakeup is driven by THIS test's writes, not by
   a coalesced leftover from a sibling test."
  [f]
  (async/poll! history/nudge-chan)
  (with-open [node (xtn/start-node {})]
    (binding [*history-node* node]
      (with-redefs [history/enabled? (constantly true)
                    history/node node]
        (let [done (#'tailer/run-loop! plaid.fixtures/db node (history/history-config))]
          (try
            (f)
            (finally
              ;; `tailer/stop-chan` is a private `(defonce stop-chan (atom nil))`
              ;; — go through the var and deref the atom to reach the chan.
              (when-let [stop @@#'tailer/stop-chan]
                (async/close! stop))
              ;; Bounded join — same 5s ceiling the defstate's :stop uses.
              (async/alt!! done :done (async/timeout 5000) :timeout))))))))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

;; ============================================================
;; Helpers
;; ============================================================

(defn- drain!
  "Block until the in-test tailer has applied every audit_writes row
   visible at call time. Throws on timeout so a tailer regression
   surfaces loudly instead of producing a stale snapshot."
  []
  (or (tailer/await-drained! plaid.fixtures/db *history-node* 5000)
      (throw (ex-info "tailer drain timed out" {}))))

(defn- latest-op-ts
  "Read the most recent `operations.ts` as the ISO-8601 string we'll
   pass back as `?as-of=`. Each `submit-operation!` advances this
   monotonically, so calling this between REST mutations yields a
   distinct anchor for each snapshot we want to assert on."
  []
  (-> (jdbc/execute-one!
       plaid.fixtures/db
       ["SELECT ts FROM operations ORDER BY ts DESC, id DESC LIMIT 1"]
       {:builder-fn rs/as-unqualified-maps})
      :ts))

(defn- get-doc-as-of
  "Mock-request `GET /api/v1/documents/{id}?as-of=<ts>` and return the
   full response map. `include-body?` controls whether the deep-read
   shape (with text/token/span layers) is requested."
  ([doc-id ts] (get-doc-as-of doc-id ts true))
  ([doc-id ts include-body?]
   (api-call admin-request
             {:method :get
              :path (str "/api/v1/documents/" doc-id
                         "?as-of=" ts
                         (when include-body? "&include-body=true"))})))

(defn- spans-from-body
  "Walk the deep-read response body to a flat seq of span maps. The
   tree shape is doc → text-layers → token-layers → span-layers →
   spans; we don't care which layer a span lives under for the
   lifecycle assertions."
  [body]
  (for [tl (:document/text-layers body)
        tkl (:text-layer/token-layers tl)
        sl (:token-layer/span-layers tkl)
        s (:span-layer/spans sl)]
    s))

(defn- tokens-from-body
  [body]
  (for [tl (:document/text-layers body)
        tkl (:text-layer/token-layers tl)
        t (:token-layer/tokens tkl)]
    t))

;; ============================================================
;; Scenario A: full doc lifecycle through the REST surface
;; ============================================================
;;
;; Walk the doc through (create + tokenize) → (add span) → (update
;; span) → (delete span). At each anchor, GET ?as-of=<ts> through REST
;; must reproduce what OLTP saw at that wall-clock moment.

(deftest ^:integration scenario-a-doc-lifecycle-snapshots-via-rest
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "ScenarioAProj")
            doc (create-test-document admin-request proj "Doc")
            tl (-> (create-text-layer admin-request proj "TL") :body :id)
            tkl (-> (create-token-layer admin-request tl "TKL") :body :id)
            sl (-> (create-span-layer admin-request tkl "SL") :body :id)
            text-id (-> (create-text admin-request tl doc "Hello world") :body :id)
            t1 (-> (create-token admin-request tkl text-id 0 5) :body :id)
            _t2 (-> (create-token admin-request tkl text-id 6 11) :body :id)
            ts-a (latest-op-ts)
            _ (drain!)
            s1 (-> (create-span admin-request sl [t1] "GREETING") :body :id)
            ts-b (latest-op-ts)
            _ (drain!)
            _ (assert-ok (update-span admin-request s1 :value "INTERJECTION"))
            ts-c (latest-op-ts)
            _ (drain!)
            _ (assert-status 204 (delete-span admin-request s1))
            ts-d (latest-op-ts)
            _ (drain!)]

        (testing "ts_a: tokens present, no spans yet"
          (let [res (get-doc-as-of doc ts-a)]
            (assert-ok res)
            (is (= 2 (count (tokens-from-body (:body res)))))
            (is (empty? (spans-from-body (:body res))))))

        (testing "ts_b: span S1 exists with value GREETING"
          (let [res (get-doc-as-of doc ts-b)
                spans (spans-from-body (:body res))]
            (assert-ok res)
            (is (= 1 (count spans)))
            (is (= "GREETING" (:span/value (first spans))))))

        (testing "ts_c: S1's value is now INTERJECTION"
          (let [res (get-doc-as-of doc ts-c)
                spans (spans-from-body (:body res))]
            (assert-ok res)
            (is (= 1 (count spans)))
            (is (= "INTERJECTION" (:span/value (first spans))))))

        (testing "ts_d: span deleted, tokens still present"
          (let [res (get-doc-as-of doc ts-d)]
            (assert-ok res)
            (is (empty? (spans-from-body (:body res))))
            (is (= 2 (count (tokens-from-body (:body res))))
                "deleting the span does not affect its tokens")))))))

;; ============================================================
;; Scenario B: metadata round-trips intact (regression test)
;; ============================================================
;;
;; Pre-fix, the doc-version-bump audit row in the same op as a
;; metadata PUT would overwrite the metadata-bearing image, leaving
;; the history doc with no `:metadata`. The replayer's same-id merge
;; fix keeps the user-supplied keys around.

(deftest ^:integration scenario-b-metadata-survives-version-bump
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "ScenarioBProj")
            doc (create-test-document admin-request proj "Doc")
            md {"author" "alice" "lang" "en"}
            _ (assert-ok (update-document-metadata admin-request doc md))
            ts (latest-op-ts)
            _ (drain!)
            res (get-doc-as-of doc ts)]
        (assert-ok res)
        (is (= md (-> res :body :metadata))
            "metadata PUT must round-trip through the replayer despite the same-op version bump")))))

;; ============================================================
;; Scenario C: 425 when ?as-of= is past the history cursor
;; ============================================================

(deftest ^:integration scenario-c-future-ts-returns-425-with-cursor
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "ScenarioCProj")
            doc (create-test-document admin-request proj "Doc")
            _ (drain!)
            future-ts (.toString (.plusSeconds (Instant/now) 86400))
            res (api-call admin-request
                          {:method :get
                           :path (str "/api/v1/documents/" doc "?as-of=" future-ts)})]
        (assert-status 425 res)
        (is (some? (-> res :body :history-cursor))
            "425 body carries the cursor so the caller knows when to retry")))))

;; ============================================================
;; Scenario D: 400 for malformed ?as-of=
;; ============================================================

(deftest ^:integration scenario-d-malformed-ts-returns-400
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "ScenarioDProj")
            doc (create-test-document admin-request proj "Doc")
            res (api-call admin-request
                          {:method :get
                           :path (str "/api/v1/documents/" doc "?as-of=banana")})]
        (assert-status 400 res)
        (is (re-find #"Invalid as-of" (-> res :body :error)))))))

;; ============================================================
;; Scenario E: 503 when history is disabled
;; ============================================================
;;
;; This test deliberately runs WITHOUT `with-test-history-node` — the
;; whole point is to exercise the "history wasn't even started" branch
;; of `wrap-route-as-of`. `history/enabled?` reads config (which doesn't
;; opt in by default in tests), so a stock REST request with ?as-of=
;; lands on the 503 branch.

(deftest ^:integration scenario-e-disabled-history-returns-503
  (let [proj (create-test-project admin-request "ScenarioEProj")
        doc (create-test-document admin-request proj "Doc")
        res (api-call admin-request
                      {:method :get
                       :path (str "/api/v1/documents/" doc
                                  "?as-of=" (.toString (Instant/now)))})]
    (assert-status 503 res)
    (is (re-find #"disabled" (-> res :body :error)))))

;; ============================================================
;; Scenario F: deep-read body fields all populated (regression test)
;; ============================================================
;;
;; The 2026-05-28 bug had `?as-of=` returning 200 but with mostly-nil
;; document fields (`:document/name`, `:document/version`, etc.)
;; because the SQL SELECT list named bare columns that XTDB v2 doesn't
;; expose. This locks down the end-to-end shape so a re-regression is
;; caught here, not by a frontend complaint.

(deftest ^:integration scenario-f-intrinsic-fields-populate-via-rest
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "ScenarioFProj")
            doc (create-test-document admin-request proj "Hello Doc")
            ts (latest-op-ts)
            _ (drain!)
            res (get-doc-as-of doc ts true)
            body (:body res)]
        (assert-ok res)
        (is (= "Hello Doc" (:document/name body)))
        (is (integer? (:document/version body)))
        (is (some? (:document/project body)))
        (is (some? (:document/time-created body)))
        (is (some? (:document/time-modified body)))))))

;; ============================================================
;; Bonus regression coverage: as-of on non-document routes still 400s
;; ============================================================
;;
;; Defense-in-depth that survived the rewrite — `wrap-reject-as-of`
;; should refuse the param on routes that don't support time travel.
;; Doesn't need the history node (the rejection happens before any history
;; lookup).

(deftest ^:integration as-of-rejected-on-non-document-routes
  (let [res (api-call admin-request
                      {:method :get
                       :path (str "/api/v1/projects?as-of="
                                  (.toString (Instant/now)))})]
    (assert-status 400 res)
    (is (re-find #"not supported" (-> res :body :error)))))

;; ============================================================
;; Regression: non-UUID user-id audit rows replay without stalling
;; ============================================================
;;
;; `users.id` is a username/email string, not a UUID. The replayer's
;; `coerce-target-id` accepts non-UUID strings; this test exercises
;; the path end-to-end via POST /users + a subsequent doc read at the
;; same ts. If a future change re-tightens the replayer to UUIDs
;; only, the tailer would stall on the user audit row and the doc
;; read at ts_after_user would never apply — surfacing here as a
;; failed drain (or a stalled cursor when the failed drain bubbles
;; up).

(deftest ^:integration user-creation-via-rest-does-not-stall-tailer
  (with-test-history-node
    (fn []
      (let [new-username (str "history-test-user-" (random-uuid) "@example.com")
            create-res (api-call admin-request
                                 {:method :post
                                  :path "/api/v1/users"
                                  :body {:username new-username
                                         :password "correcthorsebatterystaple"
                                         :is-admin false}})
            _ (assert-created create-res)
            proj (create-test-project admin-request "UserRegressionProj")
            doc (create-test-document admin-request proj "Doc-after-user")
            ts (latest-op-ts)
            _ (drain!)
            res (get-doc-as-of doc ts true)]
        (assert-ok res)
        (is (= "Doc-after-user" (-> res :body :document/name))
            "doc read at ts after user create succeeds — replayer didn't stall on the user audit row")
        (is (= :running
               (:tailer-status (history/cursor-read *history-node*)))
            "tailer is still running, not stalled")))))

(deftest ^:integration project-acl-change-does-not-stall-tailer
  ;; A project ACL grant (add reader) emits a SYNTHETIC `:projects`
  ;; `:update` audit row that folds the new `:readers` vector under an
  ;; unqualified key, flowing through the replayer's `coerce-junction`.
  ;; If that fold shape ever broke, the tailer would STALL — and a stall
  ;; is global (503 on every as-of read, operator-only recovery). Users
  ;; have a sibling no-stall test; projects/ACLs did not. This pins that
  ;; an ACL fold replays cleanly.
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "AclRegressionProj")
            doc (create-test-document admin-request proj "Doc-after-acl")
            new-username (str "history-acl-user-" (random-uuid) "@example.com")
            _ (assert-created (api-call admin-request
                                        {:method :post
                                         :path "/api/v1/users"
                                         :body {:username new-username
                                                :password "correcthorsebatterystaple"
                                                :is-admin false}}))
            _ (assert-status 204 (add-project-reader admin-request proj new-username))
            ts (latest-op-ts)
            _ (drain!)
            res (get-doc-as-of doc ts true)]
        (assert-ok res)
        (is (= "Doc-after-acl" (-> res :body :document/name))
            "doc read at ts after a project ACL change succeeds — replayer didn't stall on the synthetic :projects :update fold")
        (is (= :running (:tailer-status (history/cursor-read *history-node*)))
            "tailer still running, not stalled after an ACL fold")))))

;; ============================================================
;; Bonus regression coverage: span/tokens junction round-trips via REST
;; ============================================================
;;
;; The synthetic audit row on `spans` from `set-tokens` folds the
;; token vector into the parent post_image under unqualified `:tokens`;
;; the replayer preserves it; `get-with-layer-data-at` exposes it as
;; `:span/tokens` (vector of UUIDs). Worth pinning end-to-end since the
;; OLTP and history read paths share the same shape contract.

(deftest ^:integration span-tokens-junction-survives-tailer-replay-via-rest
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "SpanTokensProj")
            doc (create-test-document admin-request proj "Doc")
            tl (-> (create-text-layer admin-request proj "TL") :body :id)
            tkl (-> (create-token-layer admin-request tl "TKL") :body :id)
            sl (-> (create-span-layer admin-request tkl "SL") :body :id)
            text-id (-> (create-text admin-request tl doc "Hello world") :body :id)
            t1 (-> (create-token admin-request tkl text-id 0 5) :body :id)
            _t2 (-> (create-token admin-request tkl text-id 6 11) :body :id)
            s1 (-> (create-span admin-request sl [t1] "X") :body :id)
            ts (latest-op-ts)
            _ (drain!)
            res (get-doc-as-of doc ts)
            spans (spans-from-body (:body res))]
        (assert-ok res)
        (is (= 1 (count spans)))
        (let [s (first spans)]
          (is (= s1 (:span/id s)) "span id round-trips as UUID")
          (let [toks (:span/tokens s)]
            (is (= 1 (count toks)))
            (is (= t1 (first toks))
                "token id round-trips as UUID, not stringified")))))))

;; ============================================================
;; Scenario G: :cold-replay-on-empty? false picks up new ops
;; regardless of UUID lex order (BUG-12 regression)
;; ============================================================
;;
;; The original seed-cursor parked `:last-op-id` at the latest existing
;; UUID. `fetch-batch` filters with `(o.ts, o.id) > cursor`, and op-ids
;; are random — so a new op committed (in the worst case, at the same
;; ts) with a lex-lower UUID would slip past forever. The fix is to
;; seed with `:last-op-id nil` and a `:last-op-ts` set strictly past
;; the latest existing operations.ts, so the where clause degrades to
;; `o.ts >= cursor-ts` and the UUID comparison is bypassed.
;;
;; This test creates pre-existing ops, spins the tailer with
;; `:cold-replay-on-empty? false`, then commits a new op AFTER the
;; tailer is running. The new op carries a fresh UUID (no control
;; over whether it sorts above or below pre-existing ones — that's
;; the bug shape). The tailer must pick it up regardless.

(defn- with-test-history-node-no-cold-replay
  "Variant of `with-test-history-node` that overrides `:cold-replay-on-empty?`
   to false. The override is scoped to `history/history-config` rather than
   bashing the on-disk config so other tests keep the shipped default."
  [f]
  (async/poll! history/nudge-chan)
  (with-open [node (xtn/start-node {})]
    (binding [*history-node* node]
      (let [base-cfg (history/history-config)
            test-cfg (-> base-cfg
                         (assoc :enabled? true
                                :cold-replay-on-empty? false))]
        (with-redefs [history/enabled? (constantly true)
                      history/node node
                      history/history-config (constantly test-cfg)]
          (let [done (#'tailer/run-loop! plaid.fixtures/db node test-cfg)]
            (try
              (f)
              (finally
                (when-let [stop @@#'tailer/stop-chan]
                  (async/close! stop))
                (async/alt!! done :done (async/timeout 5000) :timeout)))))))))

(deftest ^:integration scenario-g-cold-replay-false-tracks-new-ops
  ;; Pre-existing OLTP traffic: a project + a doc, generating several
  ;; audit_writes / operations rows BEFORE the tailer starts.
  (let [pre-proj (create-test-project admin-request "G-pre")
        pre-doc (create-test-document admin-request pre-proj "G-pre-doc")]
    ;; Start the tailer with cold-replay disabled. The pre-existing
    ;; rows must NOT be applied — that's the operator's contract for
    ;; `:cold-replay-on-empty? false`.
    (with-test-history-node-no-cold-replay
      (fn []
        ;; Let the seed-cursor write land; the loop's first wakeup
        ;; advances the cursor past the pre-existing tail without
        ;; applying anything.
        (drain!)
        ;; Now commit a NEW op. The UUID is fresh — we don't get to
        ;; pick whether it sorts above or below pre-existing ones.
        ;; A working seed (`:last-op-id nil` + bumped ts) collapses
        ;; the fetch-batch where clause to ts-only, so the comparison
        ;; is wall-clock monotonic and the new op is always picked up.
        (let [new-doc (create-test-document admin-request pre-proj "G-new-doc")
              ts (latest-op-ts)
              _ (drain!)
              ;; Read the NEW doc back via ?as-of= — proves the tailer
              ;; applied it.
              new-res (get-doc-as-of new-doc ts true)]
          (assert-ok new-res)
          (is (= "G-new-doc" (-> new-res :body :document/name))
              "new op is tracked despite random-UUID lex ordering against pre-existing ops")
          ;; And the pre-existing doc must NOT exist in the history — it
          ;; was committed before the cursor was seeded.
          (let [pre-res (get-doc-as-of pre-doc ts true)]
            (is (= 404 (:status pre-res))
                "pre-existing doc is not in history — cold replay was disabled")))))))

;; ============================================================
;; BUG-7 guard: ?as-of= on doc sub-routes rejected, not silently
;; serving current state
;; ============================================================
;;
;; `wrap-route-as-of` used to apply to the whole `/documents/{id}/...`
;; subtree, so a `?as-of=` query on `/lock`, `/media`, or any other
;; non-bitemporal sub-route would silently inject `:as-of-node` and the
;; handler — which doesn't read those keys — would happily serve
;; CURRENT state. The fix narrows the middleware to the top-level doc
;; GET path; sub-routes now reject with 400. These tests also pin the
;; positive path (top-level GET still serves at-time correctly).

(deftest ^:integration as-of-on-doc-lock-subroute-rejected
  ;; No history node needed — the rejection happens before any history lookup,
  ;; based on the request path alone.
  (let [proj (create-test-project admin-request "LockAsOfProj")
        doc (create-test-document admin-request proj "Doc")
        res (api-call admin-request
                      {:method :get
                       :path (str "/api/v1/documents/" doc "/lock?as-of="
                                  (.toString (Instant/now)))})]
    (assert-status 400 res)
    (is (re-find #"not supported on this endpoint" (-> res :body :error))
        "explicit 400 instead of silently serving the current lock state")))

(deftest ^:integration as-of-on-doc-media-subroute-rejected
  (let [proj (create-test-project admin-request "MediaAsOfProj")
        doc (create-test-document admin-request proj "Doc")
        res (api-call admin-request
                      {:method :get
                       :path (str "/api/v1/documents/" doc "/media?as-of="
                                  (.toString (Instant/now)))})]
    (assert-status 400 res)
    (is (re-find #"not supported on this endpoint" (-> res :body :error)))))

(deftest ^:integration as-of-on-non-get-doc-method-rejected
  ;; A PATCH/DELETE on a doc would otherwise silently inject
  ;; `:as-of-node` and then mutate OLTP — a permission-bypass shape if
  ;; the user thought they were operating at `ts`.
  (let [proj (create-test-project admin-request "MethodAsOfProj")
        doc (create-test-document admin-request proj "Doc")
        ts (.toString (Instant/now))
        patch-res (api-call admin-request
                            {:method :patch
                             :path (str "/api/v1/documents/" doc "?as-of=" ts)
                             :body {:name "renamed"}})]
    (assert-status 400 patch-res)
    (is (re-find #"only allowed with GET" (-> patch-res :body :error)))))

;; ============================================================
;; BUG-8 guard: deleted-doc reads at ts still resolve permission and
;; serve the historical document
;; ============================================================
;;
;; Pre-fix: the auth chain called `doc/get` on OLTP for the project
;; lookup; if the doc was deleted from OLTP it returned nil → 403,
;; regardless of whether the user had access to the project at `ts`.
;; The fix lets the doc→project lookup fall through to history at `ts`
;; (ACL membership is still resolved against CURRENT OLTP — historical
;; ACL is explicitly out of scope).
;;
;; V2 NOTE: v2's `wrap-as-of-db` set `:xt-map` with `:snapshot-time`,
;; and `get-project-id` called `(doc/get xt-map doc-id)` which then
;; saw the deleted doc's historical project — so v2 supported reading
;; deleted docs at ts. This restores parity.

(deftest ^:integration scenario-deleted-doc-readable-at-historical-ts
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "DeletedDocProj")
            doc (create-test-document admin-request proj "Will-be-deleted")
            ts-before-delete (latest-op-ts)
            _ (drain!)
            ;; Capture state-of-doc at ts-before-delete BEFORE deletion
            ;; — proves the at-time read works for a current doc too.
            res-before (get-doc-as-of doc ts-before-delete false)]
        (assert-ok res-before)
        (is (= "Will-be-deleted" (-> res-before :body :document/name)))
        ;; Now delete the doc from OLTP entirely.
        (assert-status 204
                       (api-call admin-request
                                 {:method :delete
                                  :path (str "/api/v1/documents/" doc)}))
        (drain!)
        (testing "doc is gone from current OLTP"
          (let [current-res (api-call admin-request
                                      {:method :get
                                       :path (str "/api/v1/documents/" doc)})]
            (is (= 404 (:status current-res))
                "current GET 404s as expected — doc no longer exists in OLTP")))
        (testing "but at-time GET at ts-before-delete still works (BUG-8)"
          (let [res-after-delete (get-doc-as-of doc ts-before-delete false)]
            (assert-ok res-after-delete)
            (is (= "Will-be-deleted" (-> res-after-delete :body :document/name))
                "deleted doc still readable at historical ts — auth resolved project via history fallthrough")
            ;; Option B (task #138 fix #7): media-url is OMITTED for
            ;; deleted-doc at-time reads because the URL would route
            ;; through media routes whose auth uses OLTP-only project
            ;; lookup — clicking it on a deleted doc would 403/404.
            (is (not (contains? (:body res-after-delete) :document/media-url))
                "media-url omitted for deleted-doc at-time read")))))))

;; ============================================================
;; BUG-8 non-admin coverage: deleted-doc history fallthrough for
;; reader-only users (Group D coverage)
;; ============================================================
;;
;; `scenario-deleted-doc-readable-at-historical-ts` above uses
;; admin-request; admins bypass the project-ACL check, so a regression
;; that strips the history fallthrough in `get-project-id` (the doc→project
;; lookup that lets the deleted-doc at-time read resolve permission)
;; would silently still pass. The non-admin reader path is the one that
;; actually exercises the auth chain end-to-end. This test pins it:
;;
;;   - U1 has reader access on the project → 200 at historical ts,
;;     404 at current state (doc is gone from OLTP), and still 200 at
;;     the historical ts even though `doc/get` returns nil — proves
;;     `get-project-id` fell through to history and the privilege check
;;     saw U1's current reader role on the project.
;;   - U2 has NO membership on the project → 403 at historical ts.
;;     Historical ACL is explicitly out of scope.

(deftest ^:integration deleted-doc-readable-by-non-admin-reader-via-history-fallthrough
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "DeletedDocAuthProj")
            doc (create-test-document admin-request proj "Will-be-deleted")
            ;; User1 = reader on the project; user2 has no membership.
            ;; `with-test-users` (once-fixture) provisions both standing
            ;; test users so the tokens are already valid; we just need
            ;; to grant U1 the reader role on this project.
            _ (assert-status 204
                             (add-project-reader admin-request proj
                                                 "user1@example.com"))
            ts-before-delete (latest-op-ts)
            _ (drain!)]
        ;; Sanity: U1 can read the live doc before the delete.
        (testing "live-state preconditions"
          (let [u1-live (api-call user1-request
                                  {:method :get
                                   :path (str "/api/v1/documents/" doc)})]
            (assert-ok u1-live)
            (is (= "Will-be-deleted" (-> u1-live :body :document/name)))))
        ;; Capture an at-time read BEFORE the delete proves the at-time
        ;; path works for a current doc + non-admin reader too — a
        ;; regression in `wrap-route-as-of`'s wiring to `wrap-reader-required`
        ;; would surface here as well.
        (testing "U1 at-time read before delete returns 200"
          (let [res (api-call user1-request
                              {:method :get
                               :path (str "/api/v1/documents/" doc
                                          "?as-of=" ts-before-delete)})]
            (assert-ok res)
            (is (= "Will-be-deleted" (-> res :body :document/name)))))
        ;; Now delete the doc from OLTP entirely.
        (assert-status 204
                       (api-call admin-request
                                 {:method :delete
                                  :path (str "/api/v1/documents/" doc)}))
        (drain!)
        (testing "U1 sees 403 on the current GET (auth can't resolve project for a gone doc)"
          ;; For non-admin users, the current GET of a deleted doc 403s
          ;; rather than 404s because `get-project-id` returns nil
          ;; (doc gone from OLTP, no `:as-of-node` since this is a live
          ;; GET) → `wrap-reader-required` can't find a project to ACL
          ;; against. Admins bypass ACL so they'd see 404 here, which is
          ;; the asymmetry this test is calling out.
          (let [res (api-call user1-request
                              {:method :get
                               :path (str "/api/v1/documents/" doc)})]
            (is (= 403 (:status res))
                "non-admin current-GET of deleted doc 403s — the auth chain can't resolve a project without history fallthrough on the live path")))
        (testing "U1 still reads the deleted doc at ts-before-delete (history fallthrough)"
          ;; If `get-project-id` lost its history fallthrough, this would
          ;; degrade to 403 because `doc/get db doc-id` returns nil →
          ;; `wrap-reader-required` couldn't resolve the project → ACL
          ;; check denied.
          (let [res (api-call user1-request
                              {:method :get
                               :path (str "/api/v1/documents/" doc
                                          "?as-of=" ts-before-delete)})]
            (assert-ok res)
            (is (= "Will-be-deleted" (-> res :body :document/name))
                "reader U1 reads the historical doc via the history fallthrough path")))
        (testing "U2 (no project membership) is forbidden even at ts-before-delete"
          ;; Historical ACL is out of scope — `wrap-project-privileges-required`
          ;; resolves the project from history (proving the fallthrough fired)
          ;; but checks U2 against CURRENT membership and rejects with 403.
          (let [res (api-call user2-request
                              {:method :get
                               :path (str "/api/v1/documents/" doc
                                          "?as-of=" ts-before-delete)})]
            (is (= 403 (:status res))
                "U2 has no current ACL on the project → 403, even though the doc existed at ts")))))))

;; ============================================================
;; Cascading delete: project deletion takes its docs with it
;; ============================================================
;;
;; A project DELETE walks the OLTP cascade (docs → layers etc.) and
;; should emit audit rows for each deleted entity. The history replays
;; those deletions, so:
;;   - at ts_before_delete: the docs exist in history (bitemporal preserves
;;     historical state regardless of what happened later)
;;   - at ts_after_delete: the docs are GONE in history (the delete audit
;;     row replayed as :delete-docs closes their validity)
;;
;; If the OLTP cascade doesn't audit the docs (a real risk on the SQL
;; port), the second assertion fails and we have a finding. We flag
;; rather than fix.

(deftest ^:integration cascade-delete-project-removes-docs-from-history-at-later-ts
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "CascadeDeleteProj")
            doc1 (create-test-document admin-request proj "Doc1")
            doc2 (create-test-document admin-request proj "Doc2")
            ts-before (latest-op-ts)
            _ (drain!)]
        (testing "before cascade-delete: both docs visible at ts-before"
          (let [r1 (get-doc-as-of doc1 ts-before false)
                r2 (get-doc-as-of doc2 ts-before false)]
            (assert-ok r1)
            (assert-ok r2)
            (is (= "Doc1" (-> r1 :body :document/name)))
            (is (= "Doc2" (-> r2 :body :document/name)))))
        ;; Delete the project — this should cascade through OLTP and
        ;; emit audit rows for the now-removed docs.
        (assert-status 204
                       (api-call admin-request
                                 {:method :delete
                                  :path (str "/api/v1/projects/" proj)}))
        (drain!)
        (let [ts-after (latest-op-ts)]
          (testing "after cascade-delete: docs still readable at the EARLIER ts (bitemporal)"
            (let [r1 (get-doc-as-of doc1 ts-before false)
                  r2 (get-doc-as-of doc2 ts-before false)]
              (assert-ok r1)
              (assert-ok r2)
              (is (= "Doc1" (-> r1 :body :document/name))
                  "historical preservation: doc1 still visible at ts-before")
              (is (= "Doc2" (-> r2 :body :document/name)))))
          (testing "after cascade-delete: docs gone from history at ts-after"
            ;; If this fails, the SQL cascade isn't emitting per-doc audit
            ;; rows — flag as a finding for the history coverage doc.
            (let [r1 (get-doc-as-of doc1 ts-after false)
                  r2 (get-doc-as-of doc2 ts-after false)]
              (is (= 404 (:status r1))
                  "doc1 deleted from history at ts-after — cascade emits audit row")
              (is (= 404 (:status r2))
                  "doc2 deleted from history at ts-after"))))))))

;; ============================================================
;; Multi-text-layer / multi-token-layer doc shape
;; ============================================================
;;
;; Most tests use a single text-layer + single token-layer. Exercise the
;; IN-list SQL queries (q-token-layers, q-span-layers, q-relation-layers)
;; by building a doc with 2 text layers × 2 token layers and verifying
;; the deep-read tree has them all, ordered by :order-idx.

(deftest ^:integration multi-text-layer-multi-token-layer-doc-shape
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "MultiLayerProj")
            doc (create-test-document admin-request proj "MultiDoc")
            tl-a (-> (create-text-layer admin-request proj "TLA") :body :id)
            tl-b (-> (create-text-layer admin-request proj "TLB") :body :id)
            tkl-a1 (-> (create-token-layer admin-request tl-a "TKLA1") :body :id)
            tkl-a2 (-> (create-token-layer admin-request tl-a "TKLA2") :body :id)
            tkl-b1 (-> (create-token-layer admin-request tl-b "TKLB1") :body :id)
            tkl-b2 (-> (create-token-layer admin-request tl-b "TKLB2") :body :id)
            ts (latest-op-ts)
            _ (drain!)
            res (get-doc-as-of doc ts true)
            body (:body res)
            tls (:document/text-layers body)]
        (assert-ok res)
        (is (= 2 (count tls)) "both text layers present")
        ;; text layers ordered by :order-idx (creation order).
        (is (= [tl-a tl-b] (mapv :text-layer/id tls))
            "text layers ordered by :order-idx")
        ;; Each text layer carries both of its token layers.
        (let [tls-a (-> tls first :text-layer/token-layers)
              tls-b (-> tls second :text-layer/token-layers)]
          (is (= 2 (count tls-a)) "tl-a has both token layers")
          (is (= 2 (count tls-b)) "tl-b has both token layers")
          (is (= [tkl-a1 tkl-a2] (mapv :token-layer/id tls-a))
              "tkl ordered by :order-idx within tl-a")
          (is (= [tkl-b1 tkl-b2] (mapv :token-layer/id tls-b))
              "tkl ordered by :order-idx within tl-b"))))))

;; ============================================================
;; OLTP vs history shape parity — THE canonical contract test
;; ============================================================
;;
;; The history read API's central claim is that `get-with-layer-data-at`
;; returns the SAME shape as `plaid.sql.document/get-with-layer-data`.
;; REST clients depend on it: a frontend reading from `?as-of=` cannot
;; tolerate the history response missing a key the live response has.
;;
;; This test exercises a fully-populated doc through both paths and
;; asserts the response bodies are equal (with the few known-acceptable
;; differences dissoc'ed). Drift surfaces here loudly.

(defn- normalize-vocab-links
  "Vocab-link `:vocab-layer/vocab-links` ordering isn't guaranteed
  deterministic across the two backends; sort by :vocab-link/id so the
  comparison is set-based for that key."
  [m]
  (walk/postwalk
   (fn [x]
     (if (and (map? x) (contains? x :vocab-layer/vocab-links))
       (update x :vocab-layer/vocab-links
               (fn [vs] (vec (sort-by :vocab-link/id vs))))
       x))
   m))

(defn- normalize-for-compare
  "Normalize the few keys whose ordering isn't guaranteed identical across
  the two backends before an `(= oltp history)` comparison. Today that's only
  `:vocab-layer/vocab-links` (sorted by id). Layers (text/token/span/
  relation) need no normalization — both read paths already ORDER BY
  `:order-idx`, so their order matches. Keep this list short: every entry
  is a contract concession that should be re-examined before being added."
  [body]
  (normalize-vocab-links body))

(deftest ^:integration oltp-vs-history-shape-parity-on-fully-populated-doc
  ;; Build a fully-populated doc (text + tokens + spans + relations +
  ;; per-entity metadata + vocab), then read it via both the OLTP path
  ;; (no `?as-of=`) and the history path (`?as-of=<ts>`). The two response
  ;; bodies must be equal.
  ;;
  ;; A failure here means the history contract has drifted from OLTP — a
  ;; user reading via `?as-of=` would see a different shape from a user
  ;; reading the live doc.
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "ParityProj")
            doc (create-test-document admin-request proj "ParityDoc")
            tl (-> (create-text-layer admin-request proj "TL") :body :id)
            tkl (-> (create-token-layer admin-request tl "TKL") :body :id)
            sl (-> (create-span-layer admin-request tkl "SL") :body :id)
            rl (-> (create-relation-layer admin-request sl "RL") :body :id)
            text-id (-> (create-text admin-request tl doc "Hello world") :body :id)
            t1 (-> (create-token admin-request tkl text-id 0 5) :body :id)
            t2 (-> (create-token admin-request tkl text-id 6 11) :body :id)
            ;; Per-entity metadata + a MULTI-token span so `(= oltp history)` is a
            ;; strong check (a dropped :token/precedence, mis-coerced
            ;; :span/tokens, or lost metadata fold would diverge here) rather
            ;; than passing on a sparse tree.
            _ (assert-ok (update-token-metadata admin-request t1 {"pos" "INTJ"}))
            s1 (-> (create-span admin-request sl [t1 t2] "GREETING" {"confidence" "high"}) :body :id)
            s2 (-> (create-span admin-request sl [t2] "PLACE") :body :id)
            _r1 (-> (create-relation admin-request rl s1 s2 "modifies" {"weight" "0.8"}) :body :id)
            _ (assert-ok (update-document-metadata admin-request doc
                                                   {"author" "alice" "topic" "demo"}))
            ts (latest-op-ts)
            _ (drain!)
            oltp-res (api-call admin-request
                               {:method :get
                                :path (str "/api/v1/documents/" doc "?include-body=true")})
            history-res (api-call admin-request
                                  {:method :get
                                   :path (str "/api/v1/documents/" doc
                                              "?as-of=" ts "&include-body=true")})]
        (assert-ok oltp-res)
        (assert-ok history-res)
        ;; The unused vars suppress the linter while keeping the demo
        ;; resources alive on the wire.
        (is (some? rl))
        (is (some? s2))
        (let [oltp-body (-> oltp-res :body normalize-for-compare)
              history-body (-> history-res :body normalize-for-compare)]
          (testing "top-level doc fields are identical"
            (is (= (dissoc oltp-body :document/text-layers)
                   (dissoc history-body :document/text-layers))
                "intrinsic doc keys (name, project, version, time-*, metadata, media-url) match")
            (is (= (count (:document/text-layers oltp-body))
                   (count (:document/text-layers history-body)))
                "same number of text-layers"))
          (testing "full deep-read body is equal"
            ;; Whole-tree equality is the contract. If this fails, the
            ;; failure message points at the diverging key — but EDN
            ;; pretty-printing of a deep nested map is noisy; consider
            ;; the per-layer diff above as the targeted failure.
            (is (= oltp-body history-body)
                "OLTP and history deep-read bodies are byte-equal modulo normalization")))))))

;; ============================================================
;; OLTP vs history shape parity — vocab + entity-metadata + token-layer
;; hierarchy (Group D coverage)
;; ============================================================
;;
;; The fully-populated parity test above exercises text → token → span →
;; relation with doc-level metadata. The three areas it doesn't cover —
;; vocab layers/items/links, per-entity metadata on tokens/spans/
;; relations, and the parent-child token-layer hierarchy — each have
;; their own assembly path in `get-with-layer-data-at`. A shape drift in
;; any of those would slip through the existing parity test silently.
;; This sibling test pins those three corners as a single deep-equality
;; check.

(deftest ^:integration oltp-vs-history-parity-with-vocab-and-hierarchy
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "ParityVocabProj")
            doc (create-test-document admin-request proj "ParityVocabDoc")
            tl (-> (create-text-layer admin-request proj "TL") :body :id)
            ;; Two-layer token hierarchy: parent partitioning + child
            ;; nested non-overlapping. Mirrors the campaign shape so the
            ;; history read path reproduces both `:token-layer/parent-token-layer`
            ;; (=nil for parent, =parent-id for child) and the child's
            ;; ordering within the parent.
            parent-tkl (-> (create-token-layer-opts
                            admin-request tl "ParentTL"
                            {:overlap-mode "partitioning"})
                           :body :id)
            child-tkl (-> (create-token-layer-opts
                           admin-request tl "ChildTL"
                           {:overlap-mode "non-overlapping"
                            :parent-token-layer-id parent-tkl})
                          :body :id)
            sl (-> (create-span-layer admin-request child-tkl "SL") :body :id)
            rl (-> (create-relation-layer admin-request sl "RL") :body :id)
            ;; Vocab layer + a single item, project-linked so the deep
            ;; read surfaces it under the token-layer that the vocab-link
            ;; touches.
            vocab-id (-> (create-vocab-layer admin-request "ParityVocab") :body :id)
            _ (assert-status 204 (link-vocab-to-project admin-request proj vocab-id))
            vi-id (-> (create-vocab-item admin-request vocab-id "hello") :body :id)
            text-id (-> (create-text admin-request tl doc "Hello world") :body :id)
            ;; Parent must cover the whole text (partitioning rule).
            ;; Partitioning layers REJECT single create (400) — use
            ;; bulk-create to establish the partition in one shot.
            parent-bulk-res (bulk-create-tokens
                             admin-request
                             [{:token-layer-id parent-tkl :text text-id :begin 0 :end 11}])
            _ (assert-created parent-bulk-res)
            parent-tok (-> parent-bulk-res :body :ids first)
            t1 (-> (create-token admin-request child-tkl text-id 0 5)
                   :body :id)
            t2 (-> (create-token admin-request child-tkl text-id 6 11)
                   :body :id)
            ;; Per-entity metadata via separate PUT — keeps the test
            ;; readable when the token POST signature doesn't accept
            ;; metadata inline.
            _ (assert-ok (update-token-metadata admin-request t1 {"pos" "INTJ"}))
            _ (assert-ok (update-token-metadata admin-request t2 {"pos" "NOUN"}))
            s1 (-> (create-span admin-request sl [t1] "GREETING"
                                {"confidence" "high"})
                   :body :id)
            s2 (-> (create-span admin-request sl [t2] "PLACE"
                                {"confidence" "medium"})
                   :body :id)
            _r1 (-> (create-relation admin-request rl s1 s2 "modifies"
                                     {"weight" "0.8"})
                    :body :id)
            ;; Link the vocab-item to a token under the CHILD layer —
            ;; vocab-links attach under whichever token-layer their
            ;; tokens belong to.
            _vl (-> (create-vocab-link admin-request vi-id [t1]) :body :id)
            ts (latest-op-ts)
            _ (drain!)
            oltp-res (api-call admin-request
                               {:method :get
                                :path (str "/api/v1/documents/" doc
                                           "?include-body=true")})
            history-res (api-call admin-request
                                  {:method :get
                                   :path (str "/api/v1/documents/" doc
                                              "?as-of=" ts "&include-body=true")})]
        (assert-ok oltp-res)
        (assert-ok history-res)
        ;; Keep the resources alive on the wire (suppresses linter).
        (is (some? rl))
        (is (some? parent-tok))
        (is (some? s2))
        (let [oltp-body (-> oltp-res :body normalize-for-compare)
              history-body (-> history-res :body normalize-for-compare)]
          (testing "deep-read body is equal across OLTP and history"
            ;; Whole-tree equality is the contract. A failing assertion
            ;; here is the SIGNAL that something drifted — don't dissoc
            ;; keys away to silence it; document the divergence as a
            ;; finding instead. See group's coverage notes for the
            ;; known concession surface.
            (is (= oltp-body history-body)
                "vocab + entity metadata + token-layer hierarchy round-trip identically")))))))

;; ============================================================
;; OLTP vs history parity — vocab maintainers ordering (Fix #13)
;; ============================================================
;;
;; `:vocab/maintainers` is a folded list assembled from a join (OLTP)
;; or an array column (history). If the two sides return maintainers in
;; different orders, the parity contract breaks for any vocab with >1
;; maintainer. OLTP now ORDER BYs the vocab_maintainers join; history sorts
;; the stored array Clojure-side. Both sort by id (user-id), so a vocab
;; with three maintainers added in non-sorted order must come back in
;; the SAME order from both backends. The single-maintainer parity tests
;; above can't catch an ordering divergence — this one can.

(deftest ^:integration oltp-vs-history-parity-vocab-maintainers-ordering
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "MaintParityProj")
            doc (create-test-document admin-request proj "MaintParityDoc")
            tl (-> (create-text-layer admin-request proj "TL") :body :id)
            tkl (-> (create-token-layer admin-request tl "TKL") :body :id)
            vocab-id (-> (create-vocab-layer admin-request "MaintVocab") :body :id)
            _ (assert-status 204 (link-vocab-to-project admin-request proj vocab-id))
            ;; Add user2 THEN user1 — deliberately NOT in sorted order, so
            ;; a backend that preserved insertion order ("user2", "user1")
            ;; would diverge from one that sorts by id ("user1", "user2").
            ;; (The vocab creator is not auto-added as a maintainer, so the
            ;; final maintainer set is exactly {user1, user2}.)
            _ (assert-status 204 (add-vocab-maintainer admin-request vocab-id
                                                       "user2@example.com"))
            _ (assert-status 204 (add-vocab-maintainer admin-request vocab-id
                                                       "user1@example.com"))
            vi-id (-> (create-vocab-item admin-request vocab-id "hello") :body :id)
            text-id (-> (create-text admin-request tl doc "Hello world") :body :id)
            t1 (-> (create-token admin-request tkl text-id 0 5) :body :id)
            _vl (-> (create-vocab-link admin-request vi-id [t1]) :body :id)
            ts (latest-op-ts)
            _ (drain!)
            oltp-res (api-call admin-request
                               {:method :get
                                :path (str "/api/v1/documents/" doc
                                           "?include-body=true")})
            history-res (api-call admin-request
                                  {:method :get
                                   :path (str "/api/v1/documents/" doc
                                              "?as-of=" ts "&include-body=true")})]
        (assert-ok oltp-res)
        (assert-ok history-res)
        (let [oltp-body (-> oltp-res :body normalize-for-compare)
              history-body (-> history-res :body normalize-for-compare)
              maintainers-of (fn [body]
                               (->> body :document/text-layers
                                    (mapcat :text-layer/token-layers)
                                    (mapcat :token-layer/vocabs)
                                    (filter #(= vocab-id (:vocab/id %)))
                                    first
                                    :vocab/maintainers))]
          (testing "both backends agree on maintainer membership AND order"
            (is (= 2 (count (maintainers-of history-body)))
                "user1 + user2 both present")
            (is (= (maintainers-of oltp-body) (maintainers-of history-body))
                "maintainer order is identical across OLTP and history (both sorted by id)")
            (is (= (sort (maintainers-of history-body)) (maintainers-of history-body))
                "history returns maintainers sorted by id"))
          (testing "full deep-read body is equal"
            (is (= oltp-body history-body)
                "whole-tree parity holds with multiple vocab maintainers")))))))

;; ============================================================
;; /health against a real history node (caught-up, populated cursor)
;; ============================================================
;;
;; The existing `plaid.server.health-test` mocks every history fn so it
;; covers shape but not the underlying SQL queries (`lag-rows`,
;; `max-unreplicated-op-ts`). A real history-running /health test catches
;; bugs in those queries that the mocked suite can't.

(deftest ^:integration health-against-real-history-node-reports-caught-up
  (with-test-history-node
    (fn []
      ;; Drive some real OLTP traffic + drain so the history cursor is
      ;; populated AND lag-rows is zero (caught up).
      (let [proj (create-test-project admin-request "HealthProj")
            _ (create-test-document admin-request proj "HealthDoc")
            _ (drain!)]
        ;; Drive /health through the actual wrap-health middleware. The
        ;; OLTP datasource isn't wired into mount in tests, so we hand
        ;; `health-response` the test ds directly via the private var.
        (let [history-block (#'smw/history-block plaid.fixtures/db)]
          (is (some? history-block) "history block populated when history is enabled")
          (is (true? (:enabled history-block)) ":enabled true when history/enabled? is true")
          (is (true? (:ready history-block))
              ":ready true when lag-rows is 0 (after drain)")
          (is (zero? (:lag_rows history-block))
              "lag-rows reads 0 from the real lag-rows SQL query")
          (is (some? (:cursor_ts history-block))
              "cursor-ts populated from the real history cursor doc")
          (is (= "running" (:tailer_status history-block))
              "tailer-status reads from the real cursor doc")
          (is (zero? (:lag_ms history-block))
              "lag-ms is 0 when caught up — the max-unreplicated-op-ts query returns no rows past cursor"))))))
