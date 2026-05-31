(ns plaid.sql.monotonic-ts-test
  "Unit coverage for `plaid.sql.common/next-monotonic-ts!`'s strict-monotonic
  tie-break — the invariant the OLAP tailer's `(ts, id)` keyset depends on.

  Why this exists: the integration-level test
  `plaid.olap.full-coverage-test/operations-ts-strictly-monotonic-under-rapid-writes`
  drives writes through the REST stack, where every round-trip lets the wall
  clock advance — so it can only ever exercise the `(.isAfter now prev)` branch
  and NEVER the `(.plusNanos prev 1)` tie-break. Mutation testing confirmed a
  regression that makes the tie-break return `prev` (non-strict) survives that
  integration test. This test defeats wall-clock spacing by seeding the
  process-global instant to the future, so `Instant/now` is always BEFORE it
  and every call MUST take the tie-break branch.

  Safe to mutate the process-global atom here: the test runner is single-
  threaded (`:multithread? false`), and we restore the atom in a `finally`."
  (:require [clojure.test :refer :all]
            [plaid.sql.common :as psc])
  (:import (java.time Instant)))

(deftest next-monotonic-ts-strict-tie-break
  (let [atom* @#'psc/last-op-instant
        saved @atom*
        ;; Far-future seed → real Instant/now is always before it, so every
        ;; call is forced down the tie-break branch the integration test can't
        ;; reach. (db arg is unused once the atom is non-nil.)
        future (.plusSeconds (Instant/now) 3600)]
    (try
      (reset! atom* future)
      (let [results (vec (repeatedly 1000 #(psc/next-monotonic-ts! nil)))
            instants (mapv #(Instant/parse %) results)]
        (testing "1000 same-tick calls yield 1000 DISTINCT stamps (no ties)"
          ;; A non-strict tie-break (return prev) collapses these to 1 value —
          ;; this is the assertion that kills mutation #9.
          (is (= 1000 (count (distinct results)))))
        (testing "each stamp is STRICTLY greater than the previous"
          (is (every? true?
                      (map (fn [a b] (.isBefore ^Instant a ^Instant b))
                           instants (rest instants)))))
        (testing "the tie-break advances by exactly 1ns from the seed"
          (is (= (.plusNanos future 1) (first instants)))))
      (finally
        (reset! atom* saved)))))
