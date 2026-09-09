(ns plaid.rest-api.v1.audit-test
  (:require [clojure.set]
            [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db
                                    with-mount-states with-rest-handler admin-request api-call
                                    assert-status assert-created assert-ok assert-no-content assert-forbidden
                                    with-admin with-test-users user1-request user2-request with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(deftest project-audit-log-basic
  (let [proj (create-test-project admin-request "AuditProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "hello")
        _ (assert-created text-res)]

    (testing "Project audit log returns entries"
      (let [r (get-project-audit admin-request proj)
            entries (:entries (:body r))]
        (assert-ok r)
        (is (sequential? entries))
        (is (pos? (count entries)))

        (testing "Each entry has expected structure"
          (let [entry (first entries)]
            (is (some? (:audit/id entry)))
            (is (some? (:audit/ops entry)))
            (is (sequential? (:audit/ops entry)))))))))

(deftest project-audit-log-with-time-filters
  (let [proj (create-test-project admin-request "AuditTimeProj")
        _ (Thread/sleep 100)
        start-time (java.time.Instant/now)
        _ (Thread/sleep 100)
        doc (create-test-document admin-request proj "Doc")
        _ (Thread/sleep 100)
        end-time (java.time.Instant/now)
        _ (Thread/sleep 100)
        ;; Create text layer after end-time — should be excluded
        tl-res (create-text-layer admin-request proj "TL")
        _ (assert-created tl-res)]

    (testing "Time-filtered audit returns only entries in range"
      (let [all-entries (get-project-audit admin-request proj)
            filtered (get-project-audit admin-request proj start-time end-time)]
        (assert-ok all-entries)
        (assert-ok filtered)
        ;; Filtered should have fewer entries than all
        (is (< (count (:entries (:body filtered))) (count (:entries (:body all-entries)))))))))

(deftest project-audit-log-access-control
  (let [proj (create-test-project admin-request "AuditACProj")]

    (testing "Non-member cannot access project audit"
      (assert-forbidden (get-project-audit user1-request proj)))

    (testing "Reader can access project audit"
      (assert-no-content (add-project-reader admin-request proj "user1@example.com"))
      (assert-ok (get-project-audit user1-request proj)))))

(deftest document-audit-log-basic
  (let [proj (create-test-project admin-request "DocAuditProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "hello")
        _ (assert-created text-res)]

    (testing "Document audit log returns entries"
      (let [r (get-document-audit admin-request doc)
            entries (:entries (:body r))]
        (assert-ok r)
        (is (sequential? entries))
        ;; Should have at least the text creation entry
        (is (pos? (count entries)))))))

(deftest document-audit-log-access-control
  (let [proj (create-test-project admin-request "DocAuditACProj")
        doc (create-test-document admin-request proj "Doc")]

    (testing "Non-member cannot access document audit"
      (assert-forbidden (get-document-audit user1-request doc)))

    (testing "Reader can access document audit"
      (assert-no-content (add-project-reader admin-request proj "user1@example.com"))
      (assert-ok (get-document-audit user1-request doc)))))

(deftest user-audit-log-admin-only
  (testing "Non-admin cannot access user audit logs"
    (assert-forbidden (get-user-audit user1-request "user1@example.com")))

  (testing "Admin can access any user's audit log"
    (let [r (get-user-audit admin-request "admin@example.com")]
      (assert-ok r)
      (is (sequential? (:entries (:body r)))))))

(deftest user-audit-log-shows-user-actions
  (let [;; user1 performs actions as writer
        proj (create-test-project admin-request "UserAuditProj")
        _ (assert-no-content (add-project-writer admin-request proj "user1@example.com"))
        doc (create-test-document user1-request proj "Doc")]

    (testing "Admin can query user1's audit log and see their actions"
      (let [r (get-user-audit admin-request "user1@example.com")]
        (assert-ok r)
        (is (sequential? (:entries (:body r))))
        (is (pos? (count (:entries (:body r)))))))))

(deftest audit-log-enrichment
  (let [proj (create-test-project admin-request "EnrichAuditProj")
        doc (create-test-document admin-request proj "Doc")]

    (testing "Audit entries include enriched data"
      (let [r (get-project-audit admin-request proj)
            entries (:entries (:body r))]
        (assert-ok r)
        (is (pos? (count entries)))

        (let [entry (first entries)]
          ;; User should be enriched (a map, not just a string)
          (is (map? (:audit/user entry)))

          ;; Ops should be enriched
          (let [op (first (:audit/ops entry))]
            (is (some? (:op/type op)))
            (is (some? (:op/description op)))))))))

;; --- /audit/last-edits: when the CALLER last wrote to each document --------

(defn- get-last-edits
  "The endpoint's body keyed by document id as a STRING: the test harness reads
  responses as EDN, so a UUID key comes back as a UUID rather than the string a
  JSON client would see."
  [user-request-fn project-id]
  (let [r (api-call user-request-fn
                    {:method :get
                     :path (str "/api/v1/projects/" project-id "/audit/last-edits")})]
    (update r :body #(into {} (map (fn [[k v]] [(str k) v])) %))))

(deftest last-edits-covers-only-the-callers-own-writes
  (let [proj (create-test-project admin-request "LastEditsProj")
        touched (create-test-document admin-request proj "Touched")
        _ (assert-status 204 (add-project-writer admin-request proj "user1@example.com"))]

    (testing "a document the caller wrote to is there, with a timestamp"
      (let [r (get-last-edits admin-request proj)]
        (assert-ok r)
        (is (string? (get (:body r) (str touched))))))

    (testing "a member who has written nothing sees nothing"
      (let [r (get-last-edits user1-request proj)]
        (assert-ok r)
        (is (empty? (:body r)))))

    (testing "and then sees only their own document, not the admin's"
      (let [theirs (create-test-document user1-request proj "Theirs")
            r (get-last-edits user1-request proj)]
        (assert-ok r)
        (is (contains? (:body r) (str theirs)))
        (is (not (contains? (:body r) (str touched))))))

    (testing "the newest write wins for a document written to twice"
      (let [before (get (:body (get-last-edits admin-request proj)) (str touched))
            _ (Thread/sleep 10)
            _ (assert-ok (update-document-metadata admin-request touched {:note "again"}))
            after (get (:body (get-last-edits admin-request proj)) (str touched))]
        (is (some? after))
        (is (pos? (compare after before)) "the timestamp moved forward")))))

(deftest last-edits-access-control
  (let [proj (create-test-project admin-request "LastEditsACProj")]
    (testing "a non-member cannot read it"
      (assert-forbidden (get-last-edits user2-request proj)))))

;; ============================================================
;; Instance-wide feed, ordering, and the per-user tally
;; ============================================================

(deftest instance-audit-log-is-admin-only
  (let [proj (create-test-project admin-request "InstanceAuditProj")
        _ (create-test-document admin-request proj "Doc")]

    (testing "An admin sees a feed spanning every project"
      (let [r (get-audit admin-request)
            entries (:entries (:body r))]
        (assert-ok r)
        (is (pos? (count entries)))
        (is (some? (:audit/id (first entries))))))

    (testing "A non-admin is refused, even one with projects of their own"
      (assert-forbidden (get-audit user1-request)))))

(deftest instance-audit-log-orders-both-ways
  (let [proj (create-test-project admin-request "OrderProj")
        _ (create-test-document admin-request proj "First")
        _ (Thread/sleep 20)
        _ (create-test-document admin-request proj "Second")
        asc (:entries (:body (get-audit admin-request {:limit 50})))
        desc (:entries (:body (get-audit admin-request {:limit 50 :order :desc})))]

    (testing "Ascending is the default and starts at the oldest unit"
      (is (= (mapv :audit/time asc) (sort (mapv :audit/time asc)))))

    (testing "?order=desc starts at the newest and runs backwards"
      (is (= (mapv :audit/time desc) (reverse (sort (mapv :audit/time desc)))))
      (is (= (first (mapv :audit/time desc)) (last (mapv :audit/time asc)))))

    (testing "A descending cursor keeps going backwards rather than restarting"
      (let [page1 (:body (get-audit admin-request {:limit 2 :order :desc}))
            page2 (:body (get-audit admin-request {:limit 2 :order :desc
                                                   :cursor (:next-cursor page1)}))
            times1 (mapv :audit/time (:entries page1))
            times2 (mapv :audit/time (:entries page2))]
        (is (seq times2))
        (is (neg? (compare (first times2) (last times1)))
            "the second page's newest unit is older than the first page's oldest")
        (is (empty? (clojure.set/intersection (set times1) (set times2))))))))

(deftest audit-tally-counts-changes-not-writes
  (let [proj (create-test-project admin-request "TallyProj")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        _ (assert-created (create-text admin-request tl doc "hello"))]

    (testing "The project tally names the people who did something"
      (let [r (get-audit-tally admin-request proj)
            rows (:entries (:body r))
            mine (first (filter #(= "admin@example.com" (:user/id (:user %))) rows))]
        (assert-ok r)
        (is (seq rows))
        (is (some? mine))
        (is (pos? (:changes mine)))
        (is (pos? (:documents mine)))
        (is (<= (:changes mine) (:operations mine))
            "a change folds one or more operations, so it can never exceed them")
        (is (some? (:first-ts mine)))
        (is (some? (:last-ts mine)))))

    (testing "daily=true adds dated counts as a LIST, so the dates survive a client's key casing"
      (let [rows (:entries (:body (get-audit-tally admin-request proj {:daily true})))
            mine (first (filter #(= "admin@example.com" (:user/id (:user %))) rows))
            by-day (:by-day mine)]
        (is (sequential? by-day))
        (is (seq by-day))
        (is (every? #(and (string? (:date %)) (pos? (:changes %))) by-day))
        (is (= by-day (sort-by :date by-day)) "oldest first")))

    (testing "Without daily, by-day is absent rather than empty"
      (let [rows (:entries (:body (get-audit-tally admin-request proj)))]
        (is (every? #(not (contains? % :by-day)) rows))))

    (testing "The instance tally is admin-only; the project tally wants a maintainer"
      (assert-forbidden (get-audit-tally user1-request))
      (assert-forbidden (get-audit-tally user1-request proj)))))

(deftest audit-tally-window-narrows-the-count
  (let [proj (create-test-project admin-request "TallyWindowProj")
        _ (create-test-document admin-request proj "Before")
        _ (Thread/sleep 100)
        cutoff (java.time.Instant/now)
        _ (Thread/sleep 100)
        _ (create-test-document admin-request proj "After")
        all (:entries (:body (get-audit-tally admin-request proj)))
        since (:entries (:body (get-audit-tally admin-request proj {:start-time cutoff})))
        changes-of (fn [rows] (->> rows (map :changes) (reduce + 0)))]
    (testing "A start time drops what happened before it"
      (is (pos? (changes-of since)))
      (is (< (changes-of since) (changes-of all))))))

(deftest audit-entries-omit-deleted-entities-rather-than-nulling-them
  (testing "A deleted document leaves no null in an entry's documents array"
    (let [proj (create-test-project admin-request "DeletedDocProj")
          doc (create-test-document admin-request proj "Doomed")
          _ (assert-no-content (api-call admin-request {:method :delete
                                                        :path (str "/api/v1/documents/" doc)}))
          entries (:entries (:body (get-project-audit admin-request proj {:limit 200})))]
      (is (seq entries))
      (doseq [entry entries]
        (is (every? some? (:audit/projects entry))
            "a project reference is either hydrated or absent")
        (is (every? some? (:audit/documents entry))
            "a document reference is either hydrated or absent")
        (is (every? #(some? (:document/id %)) (:audit/documents entry))))
      (testing "and the ops that touched it are still in the log"
        (is (some (fn [e] (some #(= :document/delete (:op/type %)) (:audit/ops e)))
                  entries))))))
