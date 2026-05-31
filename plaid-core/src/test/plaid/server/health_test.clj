(ns plaid.server.health-test
  "Regression for #80: GET /health returns 200 with an uptime payload, is
  unauthenticated, and is served before the rest-routes/static dispatch.

  Also covers the OLAP /health extension (task #127):
    - OLAP disabled (default) → no :olap key in the response body.
    - OLAP enabled but no cursor written yet → :olap block present
      with ready=false, cursor_ts=nil, lag_rows derived from
      audit_writes count.
    - OLAP enabled and a cursor exists → ready/lag fields populated
      from the cursor + the SQL lag count.
    - OLAP read failure → degraded {enabled true, ready false, error}."
  (:require [clojure.test :refer :all]
            [clojure.data.json :as json]
            [plaid.server.middleware :as mw]
            [plaid.olap.core :as olap]))

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
        (is (re-find #"\"version\":\"\?\"" body))
        (is (re-find #"\"uptime-ms\":\d+" body))))))

(deftest health-passes-through-non-matching
  (let [downstream (fn [req] {:status 418 :body (:uri req)})
        handler (mw/wrap-health downstream)]
    (is (= 418 (:status (call handler {:request-method :get :uri "/other"}))))
    (is (= 418 (:status (call handler {:request-method :post :uri "/health"}))))))

(deftest health-omits-olap-when-disabled
  (with-redefs [mw/start-time-ms (- (System/currentTimeMillis) 1)
                olap/enabled? (constantly false)]
    (let [downstream (fn [_] {:status 404})
          handler (mw/wrap-health downstream)
          resp (call handler {:request-method :get :uri "/health"})
          body (get-body-map resp)]
      (is (= 200 (:status resp)))
      (is (true? (:ok body)))
      (is (not (contains? body :olap))))))

(deftest health-includes-olap-when-enabled-with-no-cursor
  ;; enabled? but no cursor yet (cold-start / startup race). The block
  ;; must still appear, with ready=false and nil cursor fields. Stub
  ;; cursor-read to nil and lag-rows via the count fall-through (we
  ;; stub the datasource path by redefing cursor-read alone — the
  ;; lag-rows SQL path runs against the test datasource and is exercised
  ;; in integration tests; for this unit test we redef olap/disk-bytes
  ;; and the SQL count path via a redef on plaid.sql.common/q1).
  (with-redefs [mw/start-time-ms (- (System/currentTimeMillis) 1)
                olap/enabled? (constantly true)
                olap/node nil
                olap/cursor-read (fn [_] nil)
                olap/disk-bytes (constantly (* 5 1024 1024))
                ;; Stub the count query to avoid a real datasource.
                plaid.sql.common/q1 (fn [_ _] {:n 0})]
    (let [downstream (fn [_] {:status 404})
          handler (mw/wrap-health downstream)
          resp (call handler {:request-method :get :uri "/health"})
          body (get-body-map resp)
          olap (:olap body)]
      (is (= 200 (:status resp)))
      (is (true? (:enabled olap)))
      (is (true? (:ready olap)) "ready when lag_rows is 0 even without a cursor")
      (is (nil? (:cursor_ts olap)))
      (is (nil? (:cursor_op_id olap)))
      (is (nil? (:cursor_age_ms olap)))
      (is (= 0 (:lag_ms olap)) "lag_ms is 0 when caught up, regardless of cursor presence")
      (is (= 0 (:lag_rows olap)))
      (is (= "running" (:tailer_status olap)))
      (is (= 5 (:store_size_mb olap)))
      (is (not (contains? olap :stall_reason))))))

(deftest health-includes-olap-with-populated-cursor
  (let [cursor-ts "2026-05-28T09:00:00.123Z"
        ;; True OLTP-OLAP gap = 5s. cursor_age_ms is wall-clock
        ;; staleness (much larger — cursor_ts is in 2026 and the
        ;; test runs whenever); lag_ms reads off the max op-ts
        ;; past the cursor, which the stubbed q1 below feeds.
        max-unreplicated-ts "2026-05-28T09:00:05.123Z"
        cursor-op-id (java.util.UUID/randomUUID)]
    (with-redefs [mw/start-time-ms (- (System/currentTimeMillis) 1)
                  olap/enabled? (constantly true)
                  olap/node ::stub-node
                  olap/cursor-read (fn [_] {:last-op-ts cursor-ts
                                            :last-op-id cursor-op-id
                                            :last-seq 7
                                            :tailer-status :running
                                            :stall-reason nil})
                  olap/disk-bytes (constantly (* 142 1024 1024))
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
            olap (:olap body)]
        (is (= 200 (:status resp)))
        (is (true? (:enabled olap)))
        (is (false? (:ready olap)) "ready=false when lag_rows > 0")
        (is (= cursor-ts (:cursor_ts olap)))
        (is (= (str cursor-op-id) (:cursor_op_id olap)))
        (is (integer? (:cursor_age_ms olap)))
        (is (>= (:cursor_age_ms olap) 0) "cursor_age_ms is now - cursor_ts; ts is in the past")
        (is (= 5000 (:lag_ms olap))
            "lag_ms is the op-ts gap between cursor and latest unreplicated op")
        (is (= 12 (:lag_rows olap)))
        (is (= "running" (:tailer_status olap)))
        (is (= 142 (:store_size_mb olap)))))))

(deftest health-includes-olap-stall-reason-when-set
  (with-redefs [mw/start-time-ms (- (System/currentTimeMillis) 1)
                olap/enabled? (constantly true)
                olap/node ::stub-node
                olap/cursor-read (fn [_] {:last-op-ts "2026-05-28T08:00:00.000Z"
                                          :last-op-id (java.util.UUID/randomUUID)
                                          :last-seq 0
                                          :tailer-status :stalled
                                          :stall-reason "malformed audit row (at op-id=..., seq=3)"})
                olap/disk-bytes (constantly 0)
                plaid.sql.common/q1 (fn [_ _] {:n 1})]
    (let [downstream (fn [_] {:status 404})
          handler (mw/wrap-health downstream)
          resp (call handler {:request-method :get :uri "/health"})
          olap (:olap (get-body-map resp))]
      (is (= "stalled" (:tailer_status olap)))
      (is (re-find #"malformed" (:stall_reason olap))))))

(deftest health-degrades-on-olap-read-failure
  ;; A bad read against the OLAP node must NOT 500 the whole /health
  ;; response — operators rely on /health for liveness checks.
  (with-redefs [mw/start-time-ms (- (System/currentTimeMillis) 1)
                olap/enabled? (constantly true)
                olap/node ::stub-node
                olap/cursor-read (fn [_] (throw (RuntimeException. "node startup race")))
                olap/disk-bytes (constantly 0)
                plaid.sql.common/q1 (fn [_ _] {:n 0})]
    (let [downstream (fn [_] {:status 404})
          handler (mw/wrap-health downstream)
          resp (call handler {:request-method :get :uri "/health"})
          olap (:olap (get-body-map resp))]
      (is (= 200 (:status resp)) "degrade, don't 500")
      (is (true? (:enabled olap)))
      (is (false? (:ready olap)))
      (is (re-find #"node startup race" (:error olap))))))
