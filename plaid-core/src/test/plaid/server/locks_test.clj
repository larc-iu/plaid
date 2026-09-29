(ns plaid.server.locks-test
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.server.locks :as locks]))

(defn- clean-locks [f]
  (locks/reset-state!)
  (try (f) (finally (locks/reset-state!))))

(use-fixtures :each clean-locks)

(deftest acquire-result-reflects-the-atomic-transition
  (is (= :acquired (locks/acquire-lock! :document :first-user "a")))
  (is (= :refreshed (locks/acquire-lock! :document :first-user "a")))
  (is (= :conflict (locks/acquire-lock! :document :second-user "b")))
  (is (= :first-user (:user-id (locks/get-lock-info :document))))
  (is (= "a" (:lock-id (locks/get-lock-info :document)))))

(deftest the-lock-is-per-holder-not-per-user
  (is (= :acquired (locks/acquire-lock! :document :user "first")))
  (testing "a second holder with the same user id is refused"
    (is (= :conflict (locks/acquire-lock! :document :user "second")))
    (is (= :conflict (locks/acquire-lock! :document :user))
        "a fresh acquire is a new holder")
    (is (= "first" (:lock-id (locks/get-lock-info :document)))))
  (testing "only the holder's id releases it"
    (is (= :not-held (locks/release-lock! :document :user "second")))
    (is (some? (locks/get-lock-info :document)))
    (is (= :released (locks/release-lock! :document :user "first")))
    (is (nil? (locks/get-lock-info :document))))
  (testing "a holder's id held by another user does not release it"
    (is (= :acquired (locks/acquire-lock! :document :user "third")))
    (is (= :not-held (locks/release-lock! :document :other "third")))
    (is (= :conflict (locks/acquire-lock! :document :other "third")))))

(deftest a-released-id-takes-nothing-again
  (testing "released after it held the lock"
    (is (= :acquired (locks/acquire-lock! :document :user "first")))
    (is (= :released (locks/release-lock! :document :user "first")))
    (is (= :lapsed (locks/acquire-lock! :document :user "first")))
    (is (nil? (locks/get-lock-info :document))))
  (testing "released before its acquire arrived"
    (is (= :not-held (locks/release-lock! :document :user "second")))
    (is (= :lapsed (locks/acquire-lock! :document :user "second")))
    (is (nil? (locks/get-lock-info :document))))
  (testing "while another holder has the document it is a conflict, as for anyone"
    (is (= :acquired (locks/acquire-lock! :document :other "x")))
    (is (= :conflict (locks/acquire-lock! :document :user "first"))))
  (testing "the same id under another user is not spent"
    (is (= :released (locks/release-lock! :document :other "x")))
    (is (= :acquired (locks/acquire-lock! :document :user "x")))))

(deftest a-write-by-the-holding-user-extends-the-lock-and-keeps-its-holder
  (is (= :acquired (locks/acquire-lock! :document :user "first")))
  (let [before (:expires-at (locks/get-lock-info :document))]
    (Thread/sleep 5)
    (locks/refresh-locks! [:document] :user)
    (is (< before (:expires-at (locks/get-lock-info :document))))
    (is (= "first" (:lock-id (locks/get-lock-info :document)))))
  (testing "another user's write does not touch it"
    (let [before (locks/get-lock-info :document)]
      (locks/refresh-locks! [:document] :other)
      (is (= before (locks/get-lock-info :document))))))

(deftest a-fresh-acquire-names-a-new-holder
  (is (= :acquired (locks/acquire-lock! :document :user)))
  (let [id (:lock-id (locks/get-lock-info :document))]
    (is (string? id))
    (is (= :released (locks/release-lock! :document :user id)))))

(deftest a-renewal-extends-only-a-live-lock-its-holder-has
  (is (= :acquired (locks/acquire-lock! :document :user "first")))
  (let [before (:expires-at (locks/get-lock-info :document))]
    (Thread/sleep 5)
    (is (= :refreshed (locks/renew-lock! :document :user "first")))
    (is (< before (:expires-at (locks/get-lock-info :document))))
    (is (= "first" (:lock-id (locks/get-lock-info :document)))))
  (testing "another holder, of the same user or not, is a conflict and changes nothing"
    (let [before (locks/get-lock-info :document)]
      (is (= :conflict (locks/renew-lock! :document :user "second")))
      (is (= :conflict (locks/renew-lock! :document :other "first")))
      (is (= before (locks/get-lock-info :document)))))
  (testing "once released, the renewal has lapsed and takes nothing"
    (is (= :released (locks/release-lock! :document :user "first")))
    (is (= :lapsed (locks/renew-lock! :document :user "first")))
    (is (nil? (locks/get-lock-info :document))))
  (testing "once expired, the renewal has lapsed and takes nothing"
    (with-redefs [locks/lock-expiration-ms (constantly 1)]
      (is (= :acquired (locks/acquire-lock! :document :user "third"))))
    (Thread/sleep 5)
    (is (= :lapsed (locks/renew-lock! :document :user "third")))
    (is (nil? (locks/get-lock-info :document)))))
