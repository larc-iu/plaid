(ns plaid.rest-api.v1.middleware-test
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-xtdb
                                    with-mount-states with-rest-handler admin-request api-call
                                    assert-status assert-created assert-ok assert-no-content
                                    with-admin with-test-users]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-xtdb with-mount-states with-rest-handler with-admin with-test-users)

(deftest document-version-conflict-detection
  (let [proj (create-test-project admin-request "VersionConflictProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "original text")
        text-id (-> text-res :body :id)
        _ (assert-created text-res)]

    (testing "Write with current document-version succeeds"
      (let [doc-res (get-document admin-request doc)
            _ (assert-ok doc-res)
            version (-> doc-res :body :document/version)
            update-res (api-call admin-request {:method :patch
                                                :path (str "/api/v1/texts/" text-id "?document-version=" version)
                                                :body {:body "updated text"}})]
        (assert-ok update-res)))

    (testing "Write with stale document-version returns 409"
      (let [doc-res (get-document admin-request doc)
            _ (assert-ok doc-res)
            stale-version (-> doc-res :body :document/version)
            ;; Advance the version
            _ (assert-ok (update-text admin-request text-id "another update"))
            ;; Now try with stale version
            conflict-res (api-call admin-request {:method :patch
                                                   :path (str "/api/v1/texts/" text-id "?document-version=" stale-version)
                                                   :body {:body "should fail"}})]
        (assert-status 409 conflict-res)
        (is (some? (-> conflict-res :body :error)))))))

(deftest document-version-header-on-get
  (let [proj (create-test-project admin-request "VersionHeaderProj")
        doc (create-test-document admin-request proj "Doc")]

    (testing "GET document returns X-Document-Versions header"
      (let [res (get-document admin-request doc)]
        (assert-ok res)
        (is (some? (get-in res [:headers "X-Document-Versions"])))))))
