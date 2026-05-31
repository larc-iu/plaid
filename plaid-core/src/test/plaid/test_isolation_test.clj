(ns plaid.test-isolation-test
  "Regression coverage for task #113: `with-clean-db` must wipe the
  in-process state atoms (locks, rate-limit buckets) between deftests,
  not just the DB tables. The two pairs of deftests below would have
  flapped under the pre-#113 fixture (atom leftover from test 1 visible
  in test 2). Test ordering matters — keep the `-a` / `-b` suffixes so
  clojure.test runs them in alphabetical order within the namespace."
  (:require [clojure.test :refer [deftest is use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    with-clean-db]]
            [plaid.server.locks :as locks]
            [plaid.rest-api.v1.rate-limit :as rl]))

(use-fixtures :once with-db with-mount-states with-rest-handler)
(use-fixtures :each with-clean-db)

;; ---------------------------------------------------------------------------
;; Locks
;; ---------------------------------------------------------------------------

(def ^:private leaky-doc-id "isolation-doc-leak-locks")
(def ^:private leaky-user-id "isolation-user-leak-locks")

(deftest locks-isolation-a-acquire
  (is (= :acquired (locks/acquire-lock! leaky-doc-id leaky-user-id)))
  (is (some? (locks/get-lock-info leaky-doc-id))
      "Sanity: the lock we just took should be visible inside the same test."))

(deftest locks-isolation-b-cleared
  (is (nil? (locks/get-lock-info leaky-doc-id))
      "Lock acquired in `locks-isolation-a-acquire` must NOT survive into
       the next deftest — that's exactly what `with-clean-db` now
       guarantees via `reset-in-memory-state!`."))

;; ---------------------------------------------------------------------------
;; Rate limiter
;; ---------------------------------------------------------------------------

(def ^:private leaky-username "isolation-user-leak-rate-limit")

(defn- fake-request
  "Minimal Ring request shape — `client-ip` only reads :remote-addr."
  []
  {:remote-addr "127.0.0.99"})

(deftest rate-limit-isolation-a-spam
  ;; Five failures is well under the 10-failure limit, so we shouldn't
  ;; trip the bucket *during* this test — just leave it dirty so the
  ;; next deftest can prove the fixture cleared it.
  (dotimes [_ 5]
    (rl/record-failure! (fake-request) leaky-username))
  (is (false? (rl/over-limit? (fake-request) leaky-username))
      "Sanity: 5 failures is under the limit, so we're not over yet.")
  (is (= 5 (count (get @(#'rl/buckets-atom) [(:remote-addr (fake-request)) leaky-username])))
      "Sanity: all 5 failures landed in the bucket."))

(deftest rate-limit-isolation-b-cleared
  (is (empty? (get @(#'rl/buckets-atom) [(:remote-addr (fake-request)) leaky-username]))
      "Failures recorded in `rate-limit-isolation-a-spam` must NOT survive
       into the next deftest. If this fails, `with-clean-db` is not
       wiping the rate-limit fallback atom — see task #113."))
