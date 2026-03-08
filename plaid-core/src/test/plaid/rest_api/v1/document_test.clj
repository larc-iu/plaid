(ns plaid.rest-api.v1.document-test
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-xtdb
                                    with-mount-states with-rest-handler admin-request api-call
                                    assert-status assert-created assert-ok assert-no-content assert-forbidden
                                    with-admin with-test-users user1-request user2-request]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-xtdb with-mount-states with-rest-handler with-admin with-test-users)

(deftest document-metadata-functionality
  (let [proj (create-test-project admin-request "DocMetaProj")
        doc (create-test-document admin-request proj "MetaDoc")]

    (testing "Set metadata on a document"
      (let [metadata {"source" "archive" "language" "en"}
            res (update-document-metadata admin-request doc metadata)]
        (assert-ok res)
        (is (= metadata (-> res :body :metadata)))))

    (testing "Get document returns metadata"
      (let [res (get-document admin-request doc)]
        (assert-ok res)
        (is (= {"source" "archive" "language" "en"} (-> res :body :metadata)))))

    (testing "Replace metadata entirely"
      (let [new-metadata {"reviewer" "human" "status" "reviewed"}
            res (update-document-metadata admin-request doc new-metadata)]
        (assert-ok res)
        (is (= new-metadata (-> res :body :metadata)))
        ;; Old keys should be gone
        (is (nil? (get (-> res :body :metadata) "source")))))

    (testing "Delete all metadata"
      (let [res (delete-document-metadata admin-request doc)]
        (assert-ok res)
        (is (nil? (-> res :body :metadata)))))

    (testing "Delete metadata when none exists is idempotent"
      (let [res (delete-document-metadata admin-request doc)]
        (assert-ok res)
        (is (nil? (-> res :body :metadata)))))))

(deftest document-metadata-access-control
  (let [proj (create-test-project admin-request "DocMetaACProj")
        doc (create-test-document admin-request proj "ACDoc")]

    (testing "Non-member cannot set metadata"
      (assert-forbidden (update-document-metadata user1-request doc {"key" "val"})))

    (testing "Non-member cannot delete metadata"
      (assert-forbidden (delete-document-metadata user1-request doc)))

    (testing "Reader cannot write metadata"
      (assert-no-content (add-project-reader admin-request proj "user1@example.com"))
      (assert-forbidden (update-document-metadata user1-request doc {"key" "val"}))
      (assert-forbidden (delete-document-metadata user1-request doc)))

    (testing "Writer can set and delete metadata"
      (assert-no-content (add-project-writer admin-request proj "user2@example.com"))
      (let [res (update-document-metadata user2-request doc {"writer-key" "val"})]
        (assert-ok res)
        (is (= {"writer-key" "val"} (-> res :body :metadata))))
      (assert-ok (delete-document-metadata user2-request doc)))))
