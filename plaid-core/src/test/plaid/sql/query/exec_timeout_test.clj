(ns plaid.sql.query.exec-timeout-test
  "Postgres's query time limit, pinned at the seam.

  The query language's 408 comes from two different mechanisms. On SQLite it
  is a watchdog thread that calls `interrupt()` on the connection (and
  interrupts the worker, for a runaway Java regex the SQLite VM cannot
  reach); `plaid.sql.query.exec-regex-test` exercises that with a
  catastrophic pattern. On Postgres it is server-side `statement_timeout`,
  raising SQLState 57014, which `run-bounded-postgres` translates.

  That Postgres path cannot be driven from the query language, because
  Postgres has no query the compiler can emit that is reliably slow. Its
  regex engine answers the catastrophic patterns in microseconds. So this
  test goes at the seam directly with `pg_sleep`, which is deterministic:
  a two-second statement under a one-second limit is aborted, every time.

  Also pins that the limit does not LEAK. `run-bounded-postgres` scopes it
  with `SET LOCAL` inside a transaction rather than a plain `SET` plus a
  reset, so no failure path can hand a connection back to the pool still
  carrying a tiny statement_timeout, which would silently start failing
  unrelated queries."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [next.jdbc :as jdbc]
            [next.jdbc.result-set :as rs]
            [plaid.fixtures :refer [db with-db postgres-only]]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once postgres-only with-db)

(def ^:private run-bounded
  "The private dispatcher under test. White-box on purpose: the point is the
  mechanism, and no public entry point can reach it deterministically."
  @#'qe/run-bounded)

(deftest statement-timeout-becomes-a-408
  (testing "a statement that overruns the limit is aborted and reported as 408"
    (binding [qe/*query-timeout-ms* 1000]
      (let [start (System/nanoTime)
            code (try (run-bounded db (fn [conn] (jdbc/execute! conn ["SELECT pg_sleep(2)"])))
                      nil
                      (catch clojure.lang.ExceptionInfo e (:code (ex-data e))))
            ms (/ (- (System/nanoTime) start) 1e6)]
        (is (= 408 code) "pg_sleep(2) under a 1s limit must abort with a 408")
        (is (< ms 2000) (str "must abort at the limit, not run to completion (took " (long ms) "ms)"))))))

(deftest a-query-inside-the-limit-is-untouched
  (testing "a fast statement runs normally under the same machinery"
    (binding [qe/*query-timeout-ms* 5000]
      (is (= 1 (:n (first (run-bounded db (fn [conn]
                                            (jdbc/execute! conn ["SELECT 1 AS n"]
                                                           {:builder-fn rs/as-unqualified-maps}))))))))))

(deftest the-timeout-does-not-follow-the-connection-back-to-the-pool
  (testing "after a timed-out query, no pooled connection still carries the limit"
    (binding [qe/*query-timeout-ms* 1000]
      (try (run-bounded db (fn [conn] (jdbc/execute! conn ["SELECT pg_sleep(2)"])))
           (catch clojure.lang.ExceptionInfo _ nil)))
    ;; Ask each connection what its statement_timeout is rather than timing a
    ;; slow query: instant, and it checks the property directly. Loop past the
    ;; pool size so we are not merely lucky in which connection we are handed.
    (doseq [_ (range 12)]
      (with-open [conn (jdbc/get-connection db)]
        (is (= "0" (:statement_timeout
                    (jdbc/execute-one! conn ["SHOW statement_timeout"]
                                       {:builder-fn rs/as-unqualified-maps})))
            "a pooled connection must come back with the server default, not the query limit")))))
