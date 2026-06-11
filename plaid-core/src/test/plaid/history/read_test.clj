(ns plaid.history.read-test
  "Keystone tests for serving as-of reads directly from the audit log
  (plaid.history.read — XTDB-removal plan, Phase 2).

  The central claim: for any T, reconstruction at T equals what the
  OLTP deep read RETURNED at T. We verify it two ways:
   - parity at now: reconstruction-at-latest-op == live OLTP deep read,
     strict =, after a scenario touching every entity kind;
   - parity at a historical point: snapshot the OLTP read mid-scenario,
     keep mutating, then assert reconstruction at that ts still equals
     the stored snapshot byte-for-byte."
  (:require [clojure.test :refer :all]
            [next.jdbc :as jdbc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call
                                    with-test-users user1-request
                                    assert-created assert-ok assert-no-content
                                    assert-status with-clean-db]]
            [plaid.history.read :as hread]
            [plaid.sql.common :as psc]
            [plaid.sql.document :as doc]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- latest-op-ts []
  (:ts (psc/q1 db {:select [:ts] :from [:operations]
                   :order-by [[:ts :desc]] :limit 1})))

(deftest reconstruction-matches-oltp-now-and-then
  (let [proj (create-test-project admin-request "HReadProj")
        doc-id (create-test-document admin-request proj "HReadDoc")
        tl (-> (create-text-layer admin-request proj "HR-TL") :body :id)
        text-id (-> (create-text admin-request tl doc-id "hello world foo") :body :id)
        tkl (-> (create-token-layer admin-request tl "HR-TKL") :body :id)
        ;; layer config (JSON-string round trip through images)
        _ (assert-no-content (api-call admin-request
                                       {:method :put
                                        :path (str "/api/v1/token-layers/" tkl "/config/hr-ed/color")
                                        :body "teal"}))
        t1 (-> (create-token admin-request tkl text-id 0 5) :body :id)
        t2 (-> (create-token admin-request tkl text-id 6 11 nil {"pos" "NOUN" "conf" 0.9}) :body :id)
        t3 (-> (create-token admin-request tkl text-id 12 15 2) :body :id) ; precedence
        sl (-> (create-span-layer admin-request tkl "HR-SL") :body :id)
        s1 (-> (create-span admin-request sl [t1 t2] "greeting") :body :id)
        s2 (-> (create-span admin-request sl [t3] 42 {"dc/source" "test"}) :body :id)
        rl (-> (create-relation-layer admin-request sl "HR-RL") :body :id)
        _ (assert-created (create-relation admin-request rl s1 s2 "dep" {"k" "v"}))
        vid (-> (create-vocab-layer admin-request "HR-Vocab") :body :id)
        _ (assert-status 204 (link-vocab-to-project admin-request proj vid))
        item (-> (create-vocab-item admin-request vid "hello" {"gloss" "greeting"}) :body :id)
        _ (assert-created (create-vocab-link admin-request item [t1] {"conf" 1}))
        _ (assert-ok (update-document-metadata admin-request doc-id {"lang" "en" "dc/title" "T"}))

        ;; ---- historical point: snapshot what OLTP returns RIGHT NOW ----
        t-mid (latest-op-ts)
        snapshot-mid (doc/get-with-layer-data db doc-id)
        shallow-mid (doc/get db doc-id)

        ;; ---- keep mutating past the snapshot ----
        _ (assert-no-content (delete-token admin-request t1)) ; trims s1, drops vocab link
        _ (assert-ok (update-span admin-request s2 :value "forty-two"))
        _ (assert-ok (api-call admin-request {:method :patch
                                              :path (str "/api/v1/texts/" text-id)
                                              :body {:body "hello brave new world"}}))
        t-now (latest-op-ts)]

    (testing "parity at now: reconstruction == live OLTP deep read (strict =)"
      (is (= (doc/get-with-layer-data db doc-id)
             (hread/get-with-layer-data-at db doc-id t-now))))

    (testing "parity at now: shallow get"
      (is (= (doc/get db doc-id)
             (hread/get-at db doc-id t-now))))

    (testing "parity at a historical point: stored snapshot reproduced exactly"
      (is (= snapshot-mid (hread/get-with-layer-data-at db doc-id t-mid)))
      (is (= shallow-mid (hread/get-at db doc-id t-mid))))

    (testing "T in the future returns current state (decided: yes)"
      (is (= (doc/get-with-layer-data db doc-id)
             (hread/get-with-layer-data-at db doc-id "2999-01-01T00:00:00Z"))))

    (testing "before the document existed: nil / false"
      (is (nil? (hread/get-at db doc-id "2000-01-01T00:00:00Z")))
      (is (nil? (hread/get-with-layer-data-at db doc-id "2000-01-01T00:00:00Z")))
      (is (false? (hread/exists-at? db doc-id "2000-01-01T00:00:00Z")))
      (is (true? (hread/exists-at? db doc-id t-now))))))

(deftest batch-atomicity-clamps-mid-batch-reads
  (let [proj (create-test-project admin-request "HReadBatchProj")
        doc-id (create-test-document admin-request proj "HReadBatchDoc")
        tl (-> (create-text-layer admin-request proj "HRB-TL") :body :id)
        text-id (-> (create-text admin-request tl doc-id "aaa bbb ccc") :body :id)
        tkl (-> (create-token-layer admin-request tl "HRB-TKL") :body :id)
        pre-batch (doc/get-with-layer-data db doc-id)
        ;; atomic batch: two token creates
        resp (api-call admin-request
                       {:method :post
                        :path "/api/v1/batch"
                        :body [{:path "/api/v1/tokens" :method "post"
                                :body {:token-layer-id tkl :text text-id :begin 0 :end 3}}
                               {:path "/api/v1/tokens" :method "post"
                                :body {:token-layer-id tkl :text text-id :begin 4 :end 7}}]})
        _ (is (= 200 (:status resp)))
        batch-op-ts (->> (psc/q db {:select [:ts] :from [:operations]
                                    :where [:!= :batch_id nil]
                                    :order-by [:ts]})
                         (mapv :ts))]
    (is (>= (count batch-op-ts) 2) "batch produced per-sub-op operations rows")
    (testing "T at the FIRST sub-op clamps to pre-batch state — intermediate states are unobservable"
      (is (= pre-batch (hread/get-with-layer-data-at db doc-id (first batch-op-ts)))))
    (testing "T at the LAST sub-op sees the whole batch"
      (is (= (doc/get-with-layer-data db doc-id)
             (hread/get-with-layer-data-at db doc-id (last batch-op-ts)))))))

(deftest deleted-documents-reconstruct-and-then-vanish
  (let [proj (create-test-project admin-request "HReadDelProj")
        doc-id (create-test-document admin-request proj "Doomed")
        tl (-> (create-text-layer admin-request proj "HRD-TL") :body :id)
        _ (assert-created (create-text admin-request tl doc-id "ephemeral"))
        t-alive (latest-op-ts)
        snapshot (doc/get-with-layer-data db doc-id)
        _ (assert-no-content (api-call admin-request
                                       {:method :delete
                                        :path (str "/api/v1/documents/" doc-id)}))
        t-dead (latest-op-ts)]
    (testing "reconstruction at the pre-delete point still works (OLTP row is gone)"
      (is (nil? (doc/get db doc-id)) "precondition: OLTP no longer has the doc")
      (is (= snapshot (hread/get-with-layer-data-at db doc-id t-alive))))
    (testing "reconstruction after the delete is nil"
      (is (nil? (hread/get-at db doc-id t-dead)))
      (is (false? (hread/exists-at? db doc-id t-dead))))))

(deftest rest-as-of-get-end-to-end
  ;; Through the full REST stack: ?as-of= on the top-level document GET
  ;; serves the audit-log reconstruction. Notably this runs with ZERO
  ;; history configuration — the old replica stack 503'd ("history
  ;; disabled") in exactly this test environment.
  (let [proj (create-test-project admin-request "HReadRestProj")
        doc-id (create-test-document admin-request proj "HReadRestDoc")
        tl (-> (create-text-layer admin-request proj "HRR-TL") :body :id)
        text-id (-> (create-text admin-request tl doc-id "first body") :body :id)
        t1 (latest-op-ts)
        _ (assert-ok (api-call admin-request {:method :patch
                                              :path (str "/api/v1/texts/" text-id)
                                              :body {:body "second body"}}))
        get-doc (fn [qs] (api-call admin-request
                                   {:method :get
                                    :path (str "/api/v1/documents/" doc-id "?include-body=true" qs)}))
        body-of (fn [resp] (-> resp :body :document/text-layers first :text-layer/text :text/body))]
    (testing "live GET sees the current body"
      (let [resp (get-doc "")]
        (assert-ok resp)
        (is (= "second body" (body-of resp)))))
    (testing "as-of GET sees the historical body"
      (let [resp (get-doc (str "&as-of=" t1))]
        (assert-ok resp)
        (is (= "first body" (body-of resp)))))
    (testing "as-of GET on a deleted doc still resolves (project fallthrough + reconstruction)"
      (assert-no-content (api-call admin-request
                                   {:method :delete :path (str "/api/v1/documents/" doc-id)}))
      (let [resp (get-doc (str "&as-of=" t1))]
        (assert-ok resp)
        (is (= "first body" (body-of resp))))
      (is (= 404 (:status (get-doc "")))
          "live GET 404s — the doc is gone from OLTP"))))

(deftest deleted-doc-readable-by-non-admin-reader-via-fallthrough
  ;; Auth resolves a deleted doc's project by reconstruction at T
  ;; (get-project-id fallthrough), then ACLs against CURRENT membership.
  ;; A project reader keeps at-time access to deleted docs; the live GET
  ;; 403s for them (no project resolvable on the live path).
  (let [proj (create-test-project admin-request "HReadAclProj")
        doc-id (create-test-document admin-request proj "AclDoomed")
        _ (assert-no-content (api-call admin-request
                                       {:method :post
                                        :path (str "/api/v1/projects/" proj "/readers/user1@example.com")}))
        t-alive (latest-op-ts)
        _ (assert-no-content (api-call admin-request
                                       {:method :delete
                                        :path (str "/api/v1/documents/" doc-id)}))]
    (testing "reader's at-time GET of the deleted doc succeeds"
      (let [resp (api-call user1-request
                           {:method :get
                            :path (str "/api/v1/documents/" doc-id "?as-of=" t-alive)})]
        (assert-ok resp)
        (is (= "AclDoomed" (-> resp :body :document/name)))))
    (testing "reader's LIVE GET of the deleted doc 403s (no project resolvable without fallthrough)"
      (is (= 403 (:status (api-call user1-request
                                    {:method :get
                                     :path (str "/api/v1/documents/" doc-id)})))))))

(deftest retention-gate-refuses-pruned-range
  (let [proj (create-test-project admin-request "HReadPruneProj")
        doc-id (create-test-document admin-request proj "PruneDoc")
        t-now (latest-op-ts)]
    (jdbc/execute! db ["INSERT INTO audit_retention (id, pruned_below_ts, pruned_at)
                        VALUES (1, ?, ?)" "2026-01-01T00:00:00.000000000Z" t-now])
    (try
      (testing "T below the marker is refused with a typed error"
        (is (thrown-with-msg? clojure.lang.ExceptionInfo #"pruned"
                              (hread/get-at db doc-id "2025-06-01T00:00:00Z"))))
      (testing "T above the marker still reads"
        (is (some? (hread/get-at db doc-id t-now))))
      (finally
        (jdbc/execute! db ["DELETE FROM audit_retention"])))))
