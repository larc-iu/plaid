(ns plaid.sql.occ-race-test
  "Task #102.2 — Document the OCC behavior under concurrent PATCHes
  carrying the SAME stale `document-version`.

  Ideal: exactly one wins with 200, the other gets 409 because the OCC
  middleware re-reads the bumped version and rejects.

  That is what happens (task #108). The in-tx version check inside
  `plaid.sql.operation/submit-operation*` reads the document row through
  the same write tx as the body, so two racers carrying the same stale
  version cannot both commit. Before it, the check lived in
  `plaid.rest-api.v1.middleware/wrap-document-version`, which read and
  dispatched without carrying a tx-level lock into the write: a classic
  TOCTOU window in which both racers could land.

  So every attempt must resolve to exactly {200, 409}. A regression that
  let both writers through even once fails here."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request with-admin with-clean-db
                                    api-call assert-created]]
            [plaid.test-helpers :refer [create-test-project create-test-document
                                        create-text-layer create-text]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- patch-text-with-version
  "Issue a PATCH /texts/:id with ?document-version=<v>. Returns the full
  response map (we care about status, headers, body)."
  [text-id version body]
  (api-call admin-request
            {:method :patch
             :path (str "/api/v1/texts/" text-id "?document-version=" version)
             :body {:body body}}))

(defn- attempt-race!
  "One race attempt. Fresh doc + fresh text so each attempt starts
  from a known-clean state. Fire two PATCHes in parallel against the
  same text with the same stale version, return the pair of statuses."
  [proj tl i]
  (let [doc (create-test-document admin-request proj (str "RaceDoc-" i))
        text-res (create-text admin-request tl doc (str "race-seed-" i))
        text-id (-> text-res :body :id)
        _ (assert-created text-res)
        ;; Known-good version right after creation; both racers will
        ;; attempt to write with THIS value.
        v0 (-> (api-call admin-request {:method :get :path (str "/api/v1/documents/" doc)})
               :body :document/version)
        f1 (future (patch-text-with-version text-id v0 (str "racer-A-" i)))
        f2 (future (patch-text-with-version text-id v0 (str "racer-B-" i)))]
    [(:status @f1) (:status @f2)]))

(deftest racing-patches-with-stale-version
  (let [proj (create-test-project admin-request "OccRaceProj")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        attempts 8
        results (mapv (partial attempt-race! proj tl) (range attempts))
        any-409? (some (fn [[s1 s2]] (or (= 409 s1) (= 409 s2))) results)
        double-409 (count (filter (fn [[s1 s2]] (and (= 409 s1) (= 409 s2))) results))
        any-200? (some (fn [[s1 s2]] (or (= 200 s1) (= 200 s2))) results)]
    (testing "At least one of the writers must commit on every attempt
              (a 409/409 pair would mean BOTH writers somehow saw a
              version they didn't write — impossible if BEGIN IMMEDIATE
              serialization is intact)"
      (is (zero? double-409)
          (str "Saw 409/409 on " double-409 " attempts: " results)))
    (testing "Every attempt produces at least one 200 (the winner)"
      (is any-200? (str "No 200 in any attempt: " results)))
    (testing "STRICT OCC: EVERY attempt resolves to exactly {200, 409}.
              Under BEGIN IMMEDIATE the loser's tx cannot start until
              the winner commits, so its in-tx version check necessarily
              sees the bump — there is no timing window in which both
              may commit. The previous any-409?-across-8-attempts
              assertion would have passed a partial regression that let
              both writers through 7 times out of 8."
      (doseq [[i pair] (map-indexed vector results)]
        (is (= #{200 409} (set pair))
            (str "Attempt " i " did not resolve to {200, 409}: " pair))))
    ;; Kept for the failure-message ergonomics of the aggregate view.
    (is any-409? (str "Expected 409s under strict OCC; got " results))))
