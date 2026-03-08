(ns plaid.rest-api.v1.as-of-test
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-xtdb
                                    with-mount-states with-rest-handler admin-request api-call
                                    assert-status assert-created assert-ok assert-no-content assert-not-found assert-forbidden
                                    with-admin with-test-users user1-request]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-xtdb with-mount-states with-rest-handler with-admin with-test-users)

(deftest as-of-returns-historical-state
  (let [proj (create-test-project admin-request "AsOfProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "version one")
        text-id (-> text-res :body :id)
        _ (assert-created text-res)
        ;; Capture a timestamp after creation
        _ (Thread/sleep 100)
        snapshot-time (java.time.Instant/now)
        _ (Thread/sleep 100)
        ;; Update text
        _ (assert-ok (update-text admin-request text-id "version two"))]

    (testing "Current state shows updated value"
      (let [r (get-text admin-request text-id)]
        (assert-ok r)
        (is (= "version two" (-> r :body :text/body)))))

    (testing "as-of shows historical value"
      (let [r (api-call admin-request {:method :get
                                       :path (str "/api/v1/texts/" text-id "?as-of=" snapshot-time)})]
        (assert-ok r)
        (is (= "version one" (-> r :body :text/body)))))))

(deftest as-of-shows-deleted-entities
  (let [proj (create-test-project admin-request "AsOfDeleteProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "will be deleted")
        text-id (-> text-res :body :id)
        _ (assert-created text-res)
        _ (Thread/sleep 100)
        snapshot-time (java.time.Instant/now)
        _ (Thread/sleep 100)
        _ (assert-no-content (delete-text admin-request text-id))]

    (testing "Current state shows deleted"
      (assert-not-found (get-text admin-request text-id)))

    (testing "as-of before deletion shows entity"
      (let [r (api-call admin-request {:method :get
                                       :path (str "/api/v1/texts/" text-id "?as-of=" snapshot-time)})]
        (assert-ok r)
        (is (= "will be deleted" (-> r :body :text/body)))))))

(deftest as-of-rejected-on-non-get-methods
  (let [proj (create-test-project admin-request "AsOfRejectProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "test")
        text-id (-> text-res :body :id)
        _ (assert-created text-res)
        now (java.time.Instant/now)]

    (testing "PATCH with as-of returns 400"
      (let [r (api-call admin-request {:method :patch
                                       :path (str "/api/v1/texts/" text-id "?as-of=" now)
                                       :body {:body "sneaky"}})]
        (assert-status 400 r)))

    (testing "DELETE with as-of returns 400"
      (let [r (api-call admin-request {:method :delete
                                       :path (str "/api/v1/texts/" text-id "?as-of=" now)})]
        (assert-status 400 r)))

    (testing "POST with as-of returns 400"
      (let [doc2 (create-test-document admin-request proj "Doc2")
            r (api-call admin-request {:method :post
                                       :path (str "/api/v1/texts?as-of=" now)
                                       :body {:text-layer-id tl
                                              :document-id doc2
                                              :body "sneaky"}})]
        (assert-status 400 r)))))

(deftest as-of-respects-access-control
  (let [proj (create-test-project admin-request "AsOfACProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "secret")
        text-id (-> text-res :body :id)
        _ (assert-created text-res)
        _ (Thread/sleep 100)
        snapshot-time (java.time.Instant/now)
        _ (Thread/sleep 100)
        ;; Perform another write so snapshot-time is before the latest tx
        _ (assert-ok (update-text admin-request text-id "secret v2"))]

    (testing "Non-member still gets 403 with as-of"
      (let [r (api-call user1-request {:method :get
                                       :path (str "/api/v1/texts/" text-id "?as-of=" snapshot-time)})]
        (assert-forbidden r)))))
