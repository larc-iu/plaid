(ns plaid.rest-api.v1.error-status-mapping-test
  "Round-3 play-house findings: two error-mapping bugs the client fuzzers hit.

  BUG-B: a request body muuntaja/Jackson can't decode (e.g. a
  supplementary-plane char in a JSON object KEY, which the standard client
  emits as an escaped surrogate pair Jackson's field-name decoder rejects)
  was surfacing as HTTP 500. It's malformed client input -> 400. Fixed by
  `wrap-malformed-json-400`, sited between format-response (outer) and
  format-request (inner) in the reitit stack (reitit's exception-middleware
  is intentionally off, so nothing else catches the decode throw).

  BUG-C: SQLite write contention that outlasts busy_timeout was 503 for the
  common direct case, but a busy MASKED by a 'cannot rollback - no
  transaction is active' exception on top fell through to 500.
  `submit-operation*` now walks the cause/suppressed chain
  (`sqlite-busy-in-chain?`) so a masked busy still maps to a retryable 503."
  (:require [clojure.java.io :as io]
            [clojure.test :refer :all]
            [plaid.fixtures :as fix :refer [with-db with-mount-states
                                            with-rest-handler with-admin]]
            [plaid.rest-api.v1.middleware :as mw]
            [plaid.sql.operation :as op]
            [ring.mock.request :as mock])
  (:import (java.sql SQLException)))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)

;; ============================================================
;; BUG-B: wrap-malformed-json-400 unit
;; ============================================================

(deftest wrap-malformed-json-400-maps-decode-to-400
  (let [h (mw/wrap-malformed-json-400
           (fn [_] (throw (ex-info "Malformed application/json request."
                                   {:type :muuntaja/decode}))))
        resp (h {})]
    (is (= 400 (:status resp)) "a decode failure is a client error -> 400")
    (is (= "Malformed application/json request." (get-in resp [:body :error]))
        "the decode message is preserved")))

(deftest wrap-malformed-json-400-passes-through-other-exceptions
  ;; Guard the negative: a non-decode throw must propagate unchanged (so the
  ;; downstream 500 path still applies), NOT be swallowed as a 400.
  (let [boom (ex-info "boom" {:type :something-else})
        h (mw/wrap-malformed-json-400 (fn [_] (throw boom)))]
    (is (thrown? clojure.lang.ExceptionInfo (h {}))
        "non-decode exceptions are re-thrown, not masked as 400")))

(deftest wrap-malformed-json-400-passes-through-success
  (let [h (mw/wrap-malformed-json-400 (constantly {:status 200 :body "ok"}))]
    (is (= 200 (:status (h {}))) "happy path is untouched")))

;; ============================================================
;; BUG-C: sqlite-busy-in-chain? unit
;; ============================================================

(deftest sqlite-busy-in-chain?-walks-cause-and-suppressed
  (let [busy? @#'op/sqlite-busy-in-chain?]
    (testing "direct busy / locked"
      (is (true? (busy? (SQLException. "[SQLITE_BUSY] The database file is locked (database is locked)"))))
      (is (true? (busy? (SQLException. "[SQLITE_LOCKED] database table is locked")))))
    (testing "busy wrapped as a cause"
      (is (true? (busy? (RuntimeException. "wrap" (SQLException. "database is locked"))))))
    (testing "busy attached as SUPPRESSED behind a rollback-failure on top (the BUG-C case)"
      (let [e (doto (SQLException. "cannot rollback - no transaction is active")
                (.addSuppressed (SQLException. "[SQLITE_BUSY] database is locked")))]
        (is (true? (busy? e))
            "rollback-failure masks busy on top, but the chain walk finds it")))
    (testing "non-busy is not misclassified"
      (is (false? (busy? (SQLException. "UNIQUE constraint failed: projects.id"))))
      (is (false? (busy? (RuntimeException.))) "nil message")
      (is (false? (busy? nil))))))

;; ============================================================
;; BUG-B end-to-end: full handler returns 400, not 500
;; ============================================================

(defn- raw-admin-post
  [path ^String json-text]
  (let [req (-> (mock/request :post path)
                (assoc :body (io/input-stream (.getBytes json-text "UTF-8")))
                (mock/content-type "application/json")
                (mock/header "Authorization" (str "Bearer " fix/admin-token)))]
    (fix/rest-handler req)))

(deftest astral-key-escaped-surrogate-in-body-returns-400-not-500
  ;; {"name":"x","metadata":{"<U+1F600>":"v"}} with the emoji as a LITERAL
  ;; escaped surrogate pair — exactly what json.dumps(ensure_ascii=True)
  ;; emits. Drives the real stack; confirms muuntaja throws :muuntaja/decode
  ;; and the new middleware maps it to 400.
  (let [body "{\"name\":\"x\",\"metadata\":{\"\\ud83d\\ude00\":\"v\"}}"
        resp (raw-admin-post "/api/v1/projects" body)]
    (is (= 400 (:status resp)) "undecodable JSON body -> 400, not 500")))

(deftest valid-utf8-astral-value-body-routes-normally
  ;; Control: a well-formed body (raw-UTF-8 astral char in a VALUE) is not
  ;; caught by the 400 branch — proves the mapping keys on decode failure.
  (let [resp (raw-admin-post "/api/v1/projects" "{\"name\":\"ok-é-😀\"}")]
    (is (not= 400 (:status resp)) "valid body is not rejected as malformed")
    (is (contains? #{200 201} (:status resp)) "it creates normally")))
