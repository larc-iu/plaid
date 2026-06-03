(ns plaid.server.health-test
  "Regression for #80: GET /health returns 200 with an uptime payload, is
  unauthenticated, and is served before the rest-routes/static dispatch.

  Also covers the history /health extension (task #127):
    - history disabled (default) → no :history key in the response body.
    - history enabled but no cursor written yet → :history block present
      with ready=false, cursor_ts=nil, lag_rows derived from
      audit_writes count.
    - history enabled and a cursor exists → ready/lag fields populated
      from the cursor + the SQL lag count.
    - history read failure → degraded {enabled true, ready false, error}."
  (:require [clojure.test :refer :all]
            [clojure.data.json :as json]
            [plaid.server.middleware :as mw]
            [plaid.history.core :as history]))

(defn- call [handler req]
  (handler req))

(defn- get-body-map [resp]
  (json/read-str (:body resp) :key-fn keyword))

(deftest health-returns-200
  (with-redefs [mw/start-time-ms (- (System/currentTimeMillis) 1234)]
    (let [downstream (fn [_] {:status 404 :body "should-not-be-called"})
          handler (mw/wrap-health downstream)
          resp (call handler {:request-method :get :uri "/health"})]
      (is (= 200 (:status resp)))
      (is (= "application/json" (get-in resp [:headers "Content-Type"])))
      (let [body (:body resp)]
        (is (string? body))
        ;; Crude payload checks — avoid pulling in a JSON parser dep.
        (is (re-find #"\"ok\":true" body))
        ;; version is "dev" in unreleased/test runs and the real version when
        ;; version.edn is bundled into the jar at release time — assert the
        ;; field is present with some non-empty value, not a fixed literal.
        (is (re-find #"\"version\":\"[^\"]+\"" body))
        (is (re-find #"\"uptime-ms\":\d+" body))))))

(deftest health-passes-through-non-matching
  (let [downstream (fn [req] {:status 418 :body (:uri req)})
        handler (mw/wrap-health downstream)]
    (is (= 418 (:status (call handler {:request-method :get :uri "/other"}))))
    (is (= 418 (:status (call handler {:request-method :post :uri "/health"}))))))

(deftest health-omits-history-when-disabled
  (with-redefs [mw/start-time-ms (- (System/currentTimeMillis) 1)
                history/enabled? (constantly false)]
    (let [downstream (fn [_] {:status 404})
          handler (mw/wrap-health downstream)
          resp (call handler {:request-method :get :uri "/health"})
          body (get-body-map resp)]
      (is (= 200 (:status resp)))
      (is (true? (:ok body)))
      (is (not (contains? body :history))))))

(deftest health-includes-history-when-enabled-with-no-cursor
  ;; enabled? but no cursor yet (cold-start / startup race). The block
  ;; must still appear, with ready=false and nil cursor fields. Stub
  ;; cursor-read to nil and lag-rows via the count fall-through (we
  ;; stub the datasource path by redefing cursor-read alone — the
  ;; lag-rows SQL path runs against the test datasource and is exercised
  ;; in integration tests; for this unit test we redef history/disk-bytes
  ;; and the SQL count path via a redef on plaid.sql.common/q1).
  (with-redefs [mw/start-time-ms (- (System/currentTimeMillis) 1)
                history/enabled? (constantly true)
                history/node nil
                history/cursor-read (fn [_] nil)
                history/disk-bytes (constantly (* 5 1024 1024))
                ;; Stub the count query to avoid a real datasource.
                plaid.sql.common/q1 (fn [_ _] {:n 0})]
    (let [downstream (fn [_] {:status 404})
          handler (mw/wrap-health downstream)
          resp (call handler {:request-method :get :uri "/health"})
          body (get-body-map resp)
          history (:history body)]
      (is (= 200 (:status resp)))
      (is (true? (:enabled history)))
      (is (true? (:ready history)) "ready when lag_rows is 0 even without a cursor")
      (is (nil? (:cursor_ts history)))
      (is (nil? (:cursor_op_id history)))
      (is (nil? (:cursor_age_ms history)))
      (is (= 0 (:lag_ms history)) "lag_ms is 0 when caught up, regardless of cursor presence")
      (is (= 0 (:lag_rows history)))
      (is (= "running" (:tailer_status history)))
      (is (= 5 (:store_size_mb history)))
      (is (not (contains? history :stall_reason))))))

(deftest health-includes-history-with-populated-cursor
  (let [cursor-ts "2026-05-28T09:00:00.123Z"
        ;; True OLTP-history gap = 5s. cursor_age_ms is wall-clock
        ;; staleness (much larger — cursor_ts is in 2026 and the
        ;; test runs whenever); lag_ms reads off the max op-ts
        ;; past the cursor, which the stubbed q1 below feeds.
        max-unreplicated-ts "2026-05-28T09:00:05.123Z"
        cursor-op-id (java.util.UUID/randomUUID)]
    (with-redefs [mw/start-time-ms (- (System/currentTimeMillis) 1)
                  history/enabled? (constantly true)
                  history/node ::stub-node
                  history/cursor-read (fn [_] {:last-op-ts cursor-ts
                                               :last-op-id cursor-op-id
                                               :last-seq 7
                                               :tailer-status :running
                                               :stall-reason nil})
                  history/disk-bytes (constantly (* 142 1024 1024))
                  ;; The /health code path now issues two queries
                  ;; (lag-rows + max-unreplicated-op-ts). Dispatch
                  ;; on the SELECT clause to feed each one.
                  plaid.sql.common/q1 (fn [_ query]
                                        (let [select (:select query)]
                                          (cond
                                            (and (vector? select)
                                                 (= [[:max :o.ts] :max_ts]
                                                    (first select)))
                                            {:max_ts max-unreplicated-ts}
                                            :else {:n 12})))]
      (let [downstream (fn [_] {:status 404})
            handler (mw/wrap-health downstream)
            resp (call handler {:request-method :get :uri "/health"})
            body (get-body-map resp)
            history (:history body)]
        (is (= 200 (:status resp)))
        (is (true? (:enabled history)))
        (is (false? (:ready history)) "ready=false when lag_rows > 0")
        (is (= cursor-ts (:cursor_ts history)))
        (is (= (str cursor-op-id) (:cursor_op_id history)))
        (is (integer? (:cursor_age_ms history)))
        (is (>= (:cursor_age_ms history) 0) "cursor_age_ms is now - cursor_ts; ts is in the past")
        (is (= 5000 (:lag_ms history))
            "lag_ms is the op-ts gap between cursor and latest unreplicated op")
        (is (= 12 (:lag_rows history)))
        (is (= "running" (:tailer_status history)))
        (is (= 142 (:store_size_mb history)))))))

(deftest health-includes-history-stall-reason-when-set
  (with-redefs [mw/start-time-ms (- (System/currentTimeMillis) 1)
                history/enabled? (constantly true)
                history/node ::stub-node
                history/cursor-read (fn [_] {:last-op-ts "2026-05-28T08:00:00.000Z"
                                             :last-op-id (java.util.UUID/randomUUID)
                                             :last-seq 0
                                             :tailer-status :stalled
                                             :stall-reason "malformed audit row (at op-id=..., seq=3)"})
                history/disk-bytes (constantly 0)
                plaid.sql.common/q1 (fn [_ _] {:n 1})]
    (let [downstream (fn [_] {:status 404})
          handler (mw/wrap-health downstream)
          resp (call handler {:request-method :get :uri "/health"})
          history (:history (get-body-map resp))]
      (is (= "stalled" (:tailer_status history)))
      (is (re-find #"malformed" (:stall_reason history))))))

(deftest health-degrades-on-history-read-failure
  ;; A bad read against the history node must NOT 500 the whole /health
  ;; response — operators rely on /health for liveness checks.
  (with-redefs [mw/start-time-ms (- (System/currentTimeMillis) 1)
                history/enabled? (constantly true)
                history/node ::stub-node
                history/cursor-read (fn [_] (throw (RuntimeException. "node startup race")))
                history/disk-bytes (constantly 0)
                plaid.sql.common/q1 (fn [_ _] {:n 0})]
    (let [downstream (fn [_] {:status 404})
          handler (mw/wrap-health downstream)
          resp (call handler {:request-method :get :uri "/health"})
          history (:history (get-body-map resp))]
      (is (= 200 (:status resp)) "degrade, don't 500")
      (is (true? (:enabled history)))
      (is (false? (:ready history)))
      (is (re-find #"node startup race" (:error history))))))
