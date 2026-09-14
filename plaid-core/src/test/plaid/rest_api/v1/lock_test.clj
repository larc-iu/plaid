(ns plaid.rest-api.v1.lock-test
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db
                                    with-mount-states with-rest-handler admin-request api-call
                                    assert-status assert-created assert-ok assert-no-content assert-forbidden
                                    with-admin with-test-users user1-request user2-request with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

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

(deftest a-locked-document-refuses-an-ordinary-write
  ;; `plaid.sql.operation/check-locks!` is what makes a document lock mean
  ;; anything: every operation carrying a :document runs it before the tx
  ;; opens. Only the bulk path covered it, so deleting check-locks! left the
  ;; suite green. This drives one single-entity write.
  (let [proj (create-test-project admin-request "LockOrdinaryWriteProj")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        tokl (-> (create-token-layer admin-request tl "Tokens") :body :id)
        sl (-> (create-span-layer admin-request tokl "Spans") :body :id)
        text (-> (create-text admin-request tl doc "ab cd") :body :id)
        tok (-> (create-token admin-request tokl text 0 2) :body :id)
        span (-> (create-span admin-request sl [tok] "A") :body :id)
        _ (assert-no-content (add-project-writer admin-request proj "user1@example.com"))]

    (testing "user1 holds the lock"
      (assert-ok (acquire-lock user1-request doc)))

    (testing "admin's PATCH /spans/:id is a 423 and changes nothing"
      (let [r (update-span admin-request span :value "B")]
        (assert-status 423 r)
        (is (re-find #"locked by" (-> r :body :error))
            "the message says who holds it")
        (is (= "A" (-> (get-span admin-request span) :body :span/value))
            "nothing was written")))

    (testing "and it goes through once the lock is released"
      (assert-status 204 (release-lock user1-request doc))
      (assert-ok (update-span admin-request span :value "B"))
      (is (= "B" (-> (get-span admin-request span) :body :span/value))))))

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
