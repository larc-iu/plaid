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

    (let [r (acquire-lock admin-request doc)
          lock-id (-> r :body :lock-id)]
      (testing "Acquire lock returns 200 with lock info and the holder's id"
        (assert-ok r)
        (is (string? (-> r :body :user-id)))
        (is (some? (-> r :body :expires-at)))
        (is (string? lock-id)))

      (testing "Check lock returns 200 with lock info, and never the holder's id"
        (let [r (check-lock admin-request doc)]
          (assert-ok r)
          (is (string? (-> r :body :user-id)))
          (is (not (contains? (:body r) :lock-id)))))

      ;; Clean up
      (release-lock admin-request doc lock-id))))

(deftest lock-check-when-unlocked
  (let [proj (create-test-project admin-request "LockCheckProj")
        doc (create-test-document admin-request proj "Doc")]

    (testing "Check lock on unlocked document returns 204"
      (let [r (check-lock admin-request doc)]
        (assert-status 204 r)))))

(deftest a-second-acquire-by-the-same-user-is-refused
  ;; The lock is per holder, not per user. Two assistant turns, or a plan and
  ;; a service run under one person's delegated token, are two holders with
  ;; one user id. When the second acquire was a refresh, both went ahead, and
  ;; the first to finish released the lock under the other.
  (let [proj (create-test-project admin-request "LockSameUserProj")
        doc (create-test-document admin-request proj "Doc")
        first-id (-> (acquire-lock admin-request doc) :body :lock-id)]
    (is (string? first-id))

    (testing "A second acquire by the same user is a 423 that names no holder id"
      (let [r (acquire-lock admin-request doc)]
        (assert-status 423 r)
        (is (not (contains? (:body r) :lock-id)))))

    (testing "Releasing without the holder's id is refused and changes nothing"
      (assert-status 400 (release-lock admin-request doc))
      (assert-ok (check-lock admin-request doc)))

    (testing "Releasing with another id changes nothing"
      (assert-status 204 (release-lock admin-request doc "not-the-holder"))
      (assert-ok (check-lock admin-request doc)))

    (testing "Renewing with another id is a 423"
      (assert-status 423 (acquire-lock admin-request doc "not-the-holder")))

    (testing "The holder renews with its own id and keeps it"
      (let [r (acquire-lock admin-request doc first-id)]
        (assert-ok r)
        (is (= first-id (-> r :body :lock-id)))))

    (testing "Once the holder releases, the next acquire is a new holder"
      (assert-status 204 (release-lock admin-request doc first-id))
      (assert-status 204 (check-lock admin-request doc))
      (let [second-id (-> (acquire-lock admin-request doc) :body :lock-id)]
        (is (string? second-id))
        (is (not= first-id second-id))

        (testing "and the first holder can neither renew nor release it"
          (assert-status 423 (acquire-lock admin-request doc first-id))
          (assert-status 204 (release-lock admin-request doc first-id))
          (assert-ok (check-lock admin-request doc)))

        (release-lock admin-request doc second-id)))))

(deftest the-holding-users-writes-pass
  ;; A write carries no lock id. It is let through for the user who holds
  ;; the lock and refused for everyone else, as before.
  (let [proj (create-test-project admin-request "LockHolderWriteProj")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        tokl (-> (create-token-layer admin-request tl "Tokens") :body :id)
        sl (-> (create-span-layer admin-request tokl "Spans") :body :id)
        text (-> (create-text admin-request tl doc "ab cd") :body :id)
        tok (-> (create-token admin-request tokl text 0 2) :body :id)
        span (-> (create-span admin-request sl [tok] "A") :body :id)
        lock-id (-> (acquire-lock admin-request doc) :body :lock-id)]
    (assert-ok (update-span admin-request span :value "B"))
    (is (= "B" (-> (get-span admin-request span) :body :span/value)))
    (testing "and the write left the holder's id in place"
      (assert-ok (acquire-lock admin-request doc lock-id)))
    (release-lock admin-request doc lock-id)))

(deftest lock-conflict-different-user
  (let [proj (create-test-project admin-request "LockConflictProj")
        doc (create-test-document admin-request proj "Doc")
        ;; Make both users writers
        _ (assert-no-content (add-project-writer admin-request proj "user1@example.com"))
        _ (assert-no-content (add-project-writer admin-request proj "user2@example.com"))]

    (let [lock-id (-> (acquire-lock user1-request doc) :body :lock-id)]
      (testing "User1 acquires lock"
        (is (string? lock-id)))

      (testing "User2 gets 423 conflict"
        (let [r (acquire-lock user2-request doc)]
          (assert-status 423 r)
          (is (= "Document is locked" (-> r :body :error)))
          (is (= "user1@example.com" (-> r :body :user-id)))))

      (testing "User2 cannot renew or release it with user1's id"
        (assert-status 423 (acquire-lock user2-request doc lock-id))
        (assert-status 204 (release-lock user2-request doc lock-id))
        (assert-ok (check-lock user2-request doc)))

      ;; Clean up
      (release-lock user1-request doc lock-id))))

(deftest lock-release
  (let [proj (create-test-project admin-request "LockReleaseProj")
        doc (create-test-document admin-request proj "Doc")]

    (testing "Acquire then release"
      (let [lock-id (-> (acquire-lock admin-request doc) :body :lock-id)]
        (assert-status 204 (release-lock admin-request doc lock-id))))

    (testing "After release, check returns 204 (no lock)"
      (assert-status 204 (check-lock admin-request doc)))))

(deftest lock-release-not-held
  (let [proj (create-test-project admin-request "LockReleaseNotHeldProj")
        doc (create-test-document admin-request proj "Doc")]

    (testing "Release without acquiring returns 204 (idempotent)"
      (assert-status 204 (release-lock admin-request doc "never-taken")))))

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
        _ (assert-no-content (add-project-writer admin-request proj "user1@example.com"))
        lock-id (-> (acquire-lock user1-request doc) :body :lock-id)]

    (testing "user1 holds the lock"
      (is (string? lock-id)))

    (testing "admin's PATCH /spans/:id is a 423 and changes nothing"
      (let [r (update-span admin-request span :value "B")]
        (assert-status 423 r)
        (is (re-find #"locked by" (-> r :body :error))
            "the message says who holds it")
        (is (= "A" (-> (get-span admin-request span) :body :span/value))
            "nothing was written")))

    (testing "and it goes through once the lock is released"
      (assert-status 204 (release-lock user1-request doc lock-id))
      (assert-ok (update-span admin-request span :value "B"))
      (is (= "B" (-> (get-span admin-request span) :body :span/value))))))

(deftest lock-access-control
  (let [proj (create-test-project admin-request "LockACProj")
        doc (create-test-document admin-request proj "Doc")]

    (testing "Non-member cannot access lock endpoints"
      (assert-forbidden (check-lock user1-request doc))
      (assert-forbidden (acquire-lock user1-request doc))
      (assert-forbidden (release-lock user1-request doc "x")))

    (testing "Reader can check lock but not acquire or release"
      (assert-no-content (add-project-reader admin-request proj "user1@example.com"))
      (assert-status 204 (check-lock user1-request doc))
      (assert-forbidden (acquire-lock user1-request doc))
      (assert-forbidden (release-lock user1-request doc "x")))

    (testing "Writer can use all lock endpoints"
      (assert-no-content (add-project-writer admin-request proj "user2@example.com"))
      (assert-status 204 (check-lock user2-request doc))
      (let [lock-id (-> (acquire-lock user2-request doc) :body :lock-id)]
        (is (string? lock-id))
        (assert-status 204 (release-lock user2-request doc lock-id))))))
