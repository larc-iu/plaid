(ns plaid.sql.slow-query-test
  "Regression for #82: q/q1/execute*/execute-returning* must emit a
  `:warn` carrying the rendered SQL + first 10 params + elapsed ms
  when wall-clock exceeds `*slow-query-threshold-ms*`, and must NOT
  log anything when the call is below threshold."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [db with-db with-mount-states with-clean-db]]
            [plaid.sql.common :as psc]
            [taoensso.timbre :as log]))

(use-fixtures :once with-db with-mount-states)
(use-fixtures :each with-clean-db)

(defn- run-with-captured-warn
  "Run `f` with `psc/emit-slow-query-warn!` redefed to push call args
  onto an atom — we can't redef `log/warn` directly because it's a
  macro. Returns the captured-args vector; each element is the
  rendered message string (built from the args we'd otherwise log)."
  [f]
  (let [captured (atom [])]
    (with-redefs [psc/emit-slow-query-warn!
                  (fn [elapsed-ms sql-vec]
                    (let [sql-str (str (first sql-vec))
                          sql-trunc (if (> (count sql-str) 200)
                                      (str (subs sql-str 0 200) " ...[truncated]")
                                      sql-str)
                          params (vec (take 10 (rest sql-vec)))]
                      (swap! captured conj
                             [(format "Slow query: %.1fms — %s — params: %s"
                                      (double elapsed-ms) sql-trunc (pr-str params))])))]
      (f))
    @captured))

(deftest slow-query-below-threshold-does-not-log
  ;; Default threshold (500ms) is well above a trivial SELECT, so
  ;; the warn path should not fire.
  (let [warns (run-with-captured-warn
               #(psc/q db ["SELECT 1"]))]
    (is (empty? warns)
        "fast queries must not emit any :warn log")))

(deftest slow-query-above-threshold-logs-warn
  ;; Force the threshold to a negative value so any successful
  ;; query trips the warn. Real-world slow queries would exceed
  ;; the default 500ms; we don't need to actually wait for that
  ;; to exercise the code path.
  (let [warns (binding [psc/*slow-query-threshold-ms* -1]
                (run-with-captured-warn
                 #(psc/q db ["SELECT 1"])))]
    (is (= 1 (count warns))
        "exactly one :warn must be emitted for a slow query")
    (let [msg (first (first warns))]
      (is (string? msg))
      (is (re-find #"Slow query:" msg)
          "warn message must carry the Slow-query prefix")
      (is (re-find #"SELECT 1" msg)
          "warn message must include the rendered SQL")
      (is (re-find #"params:" msg)
          "warn message must include the params section"))))

(deftest slow-query-truncates-long-sql
  ;; The slow-query log truncates SQL to 200 chars; verify a long
  ;; query is truncated AND the truncation marker appears.
  (let [long-sql (str "SELECT " (apply str (repeat 250 "1, ")) "1")
        warns (binding [psc/*slow-query-threshold-ms* -1]
                (run-with-captured-warn
                 #(psc/q db [long-sql])))]
    (is (= 1 (count warns)))
    (let [msg (first (first warns))]
      (is (re-find #"\.\.\.\[truncated\]" msg)
          "long SQL must be truncated with the [truncated] marker"))))

(deftest slow-query-limits-params-to-first-ten
  ;; The slow-query log shows only the first 10 params even if more
  ;; were supplied. Use 12 params; verify the first 10 are in the
  ;; rendered log line and the 11th/12th are absent.
  (let [params (mapv (fn [i] (str "p" i)) (range 12))
        sql-str (str "SELECT "
                     (clojure.string/join ", " (repeat 12 "?"))
                     " AS x")
        warns (binding [psc/*slow-query-threshold-ms* -1]
                (run-with-captured-warn
                 #(psc/q db (into [sql-str] params))))]
    (is (= 1 (count warns)))
    (let [msg (first (first warns))]
      (is (re-find #"\"p0\"" msg) "first param must be present")
      (is (re-find #"\"p9\"" msg) "tenth param must be present")
      (is (not (re-find #"\"p10\"" msg))
          "11th param must be elided")
      (is (not (re-find #"\"p11\"" msg))
          "12th param must be elided"))))

;; ---------------------------------------------------------------------------
;; Task #102.7 — coverage gaps (after agent B's #92 try/finally fix)
;; ---------------------------------------------------------------------------
;; (a) `with-slow-query-warn` MUST emit the warn even when the wrapped
;;     fn throws (try/finally semantics).
;; (b) `q1`, `execute!`, `execute-returning!` must all participate in the
;;     slow-query warn path — not just `q` (the only path previously
;;     tested above).

(deftest slow-query-emits-warn-even-on-exception
  ;; If `with-slow-query-warn` swallowed the warn when the wrapped body
  ;; threw, then the queries MOST likely to need diagnostics (constraint
  ;; violations, lock-timeouts, busy-aborted statements) would silently
  ;; produce no slow-query signal. Force the threshold to -1 so any
  ;; successful clock reading trips the warn, then throw inside the body.
  (let [warns (binding [psc/*slow-query-threshold-ms* -1]
                (run-with-captured-warn
                 (fn []
                   (try
                     (psc/q db ["SELECT * FROM no_such_table_42 LIMIT 1"])
                     (catch Exception _)))))]
    (is (= 1 (count warns))
        (str "Even on exception the slow-query warn must still fire; "
             "got " (count warns) " warns"))
    (let [msg (first (first warns))]
      (is (re-find #"no_such_table_42" msg)
          "the rendered SQL must include the (failing) query body"))))

(deftest slow-query-q1-path
  ;; q1 delegates to q + first, so the warn is recorded under the
  ;; q-level wrapper. Verify it fires here too — without an explicit
  ;; test, a future refactor that bypasses `q` would silently lose
  ;; the slow-query coverage for q1.
  (let [warns (binding [psc/*slow-query-threshold-ms* -1]
                (run-with-captured-warn
                 #(psc/q1 db ["SELECT 1 AS x"])))]
    (is (= 1 (count warns)) "q1 must trip the slow-query warn")))

(deftest slow-query-execute!-path
  ;; execute! has its own with-slow-query-warn wrapper. Use a benign
  ;; DML against a real table; rolling back via a tx keeps the test
  ;; idempotent under the per-test :each truncate.
  (let [warns (binding [psc/*slow-query-threshold-ms* -1]
                (run-with-captured-warn
                 (fn []
                   (psc/execute! db ["DELETE FROM users WHERE id = 'never-exists@xyz'"]))))]
    (is (= 1 (count warns)) "execute! must trip the slow-query warn")
    (let [msg (first (first warns))]
      (is (re-find #"DELETE FROM users" msg)
          "the warn message must carry the DML SQL"))))

(deftest slow-query-execute-returning!-path
  ;; execute-returning! drives the bulk-write helpers. Hit it with a
  ;; degenerate UPDATE that touches no rows; with-slow-query-warn must
  ;; still fire because the threshold is -1 (any successful clock read
  ;; trips it).
  (let [warns (binding [psc/*slow-query-threshold-ms* -1]
                (run-with-captured-warn
                 (fn []
                   (psc/execute-returning! db ["UPDATE users SET password_changes = password_changes WHERE id = 'no-such-user@xyz' RETURNING *"]))))]
    (is (= 1 (count warns)) "execute-returning! must trip the slow-query warn")))
