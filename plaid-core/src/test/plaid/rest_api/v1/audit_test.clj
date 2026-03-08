(ns plaid.rest-api.v1.audit-test
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-xtdb
                                    with-mount-states with-rest-handler admin-request api-call
                                    assert-status assert-created assert-ok assert-no-content assert-forbidden
                                    with-admin with-test-users user1-request user2-request]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-xtdb with-mount-states with-rest-handler with-admin with-test-users)

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
            entries (:body r)]
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
        (is (< (count (:body filtered)) (count (:body all-entries))))))))

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
            entries (:body r)]
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
      (is (sequential? (:body r))))))

(deftest user-audit-log-shows-user-actions
  (let [;; user1 performs actions as writer
        proj (create-test-project admin-request "UserAuditProj")
        _ (assert-no-content (add-project-writer admin-request proj "user1@example.com"))
        doc (create-test-document user1-request proj "Doc")]

    (testing "Admin can query user1's audit log and see their actions"
      (let [r (get-user-audit admin-request "user1@example.com")]
        (assert-ok r)
        (is (sequential? (:body r)))
        (is (pos? (count (:body r))))))))

(deftest audit-log-enrichment
  (let [proj (create-test-project admin-request "EnrichAuditProj")
        doc (create-test-document admin-request proj "Doc")]

    (testing "Audit entries include enriched data"
      (let [r (get-project-audit admin-request proj)
            entries (:body r)]
        (assert-ok r)
        (is (pos? (count entries)))

        (let [entry (first entries)]
          ;; User should be enriched (a map, not just a string)
          (is (map? (:audit/user entry)))

          ;; Ops should be enriched
          (let [op (first (:audit/ops entry))]
            (is (some? (:op/type op)))
            (is (some? (:op/description op)))))))))
