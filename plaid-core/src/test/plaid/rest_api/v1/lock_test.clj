(ns plaid.rest-api.v1.lock-test
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-xtdb
                                    with-mount-states with-rest-handler admin-request api-call
                                    assert-status assert-created assert-ok assert-no-content assert-forbidden
                                    with-admin with-test-users user1-request user2-request]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-xtdb with-mount-states with-rest-handler with-admin with-test-users)

(deftest lock-acquire-and-check
  (let [proj (create-test-project admin-request "LockAcquireProj")
        doc (create-test-document admin-request proj "Doc")]

    (testing "Acquire lock returns 200 with lock info"
      (let [r (acquire-lock admin-request doc)]
        (assert-ok r)
        (is (string? (-> r :body :user-id)))
        (is (some? (-> r :body :expires-at)))))

    (testing "Check lock returns 200 with lock info"
      (let [r (check-lock admin-request doc)]
        (assert-ok r)
        (is (string? (-> r :body :user-id)))))

    ;; Clean up
    (release-lock admin-request doc)))

(deftest lock-check-when-unlocked
  (let [proj (create-test-project admin-request "LockCheckProj")
        doc (create-test-document admin-request proj "Doc")]

    (testing "Check lock on unlocked document returns 204"
      (let [r (check-lock admin-request doc)]
        (assert-status 204 r)))))

(deftest lock-refresh-by-same-user
  (let [proj (create-test-project admin-request "LockRefreshProj")
        doc (create-test-document admin-request proj "Doc")]

    (testing "Same user can acquire twice (refresh)"
      (let [r1 (acquire-lock admin-request doc)
            r2 (acquire-lock admin-request doc)]
        (assert-ok r1)
        (assert-ok r2)))

    ;; Clean up
    (release-lock admin-request doc)))

(deftest lock-conflict-different-user
  (let [proj (create-test-project admin-request "LockConflictProj")
        doc (create-test-document admin-request proj "Doc")
        ;; Make both users writers
        _ (assert-no-content (add-project-writer admin-request proj "user1@example.com"))
        _ (assert-no-content (add-project-writer admin-request proj "user2@example.com"))]

    (testing "User1 acquires lock"
      (assert-ok (acquire-lock user1-request doc)))

    (testing "User2 gets 423 conflict"
      (let [r (acquire-lock user2-request doc)]
        (assert-status 423 r)
        (is (= "Document is locked by another user" (-> r :body :error)))))

    ;; Clean up
    (release-lock user1-request doc)))

(deftest lock-release
  (let [proj (create-test-project admin-request "LockReleaseProj")
        doc (create-test-document admin-request proj "Doc")]

    (testing "Acquire then release"
      (assert-ok (acquire-lock admin-request doc))
      (let [r (release-lock admin-request doc)]
        (assert-status 204 r)))

    (testing "After release, check returns 204 (no lock)"
      (assert-status 204 (check-lock admin-request doc)))))

(deftest lock-release-not-held
  (let [proj (create-test-project admin-request "LockReleaseNotHeldProj")
        doc (create-test-document admin-request proj "Doc")]

    (testing "Release without acquiring returns 204 (idempotent)"
      (assert-status 204 (release-lock admin-request doc)))))

(deftest lock-access-control
  (let [proj (create-test-project admin-request "LockACProj")
        doc (create-test-document admin-request proj "Doc")]

    (testing "Non-member cannot access lock endpoints"
      (assert-forbidden (check-lock user1-request doc))
      (assert-forbidden (acquire-lock user1-request doc))
      (assert-forbidden (release-lock user1-request doc)))

    (testing "Reader can check lock but not acquire or release"
      (assert-no-content (add-project-reader admin-request proj "user1@example.com"))
      (assert-status 204 (check-lock user1-request doc))
      (assert-forbidden (acquire-lock user1-request doc))
      (assert-forbidden (release-lock user1-request doc)))

    (testing "Writer can use all lock endpoints"
      (assert-no-content (add-project-writer admin-request proj "user2@example.com"))
      (assert-status 204 (check-lock user2-request doc))
      (assert-ok (acquire-lock user2-request doc))
      (assert-status 204 (release-lock user2-request doc)))))
