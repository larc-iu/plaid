(ns plaid.server.health-test
  "GET /health — unauthenticated liveness (regression for #80: 200 with
  an uptime payload, served before the rest-routes/static dispatch) +
  the :audit disk-visibility block (db file size via pragma +
  audit_writes row count; the audit log effectively IS the database and
  is the as-of read source)."
  (:require [clojure.data.json :as json]
            [clojure.test :refer :all]
            [plaid.fixtures :refer [db with-db]]
            [plaid.server.middleware :as mw]))

(use-fixtures :once with-db)

(defn- call [handler req]
  (handler req))

(deftest health-returns-200
  (with-redefs [mw/start-time-ms (- (System/currentTimeMillis) 1234)]
    (let [downstream (fn [_] {:status 404 :body "should-not-be-called"})
          handler (mw/wrap-health downstream)
          resp (call handler {:request-method :get :uri "/health"})]
      (is (= 200 (:status resp)))
      (is (= "application/json" (get-in resp [:headers "Content-Type"])))
      (let [body (:body resp)]
        (is (string? body))
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

(deftest health-audit-block-reports-size-and-rows
  (with-redefs [mw/start-time-ms (- (System/currentTimeMillis) 1)]
    (let [resp (#'mw/health-response db)
          body (json/read-str (:body resp) :key-fn keyword)]
      (is (= 200 (:status resp)))
      (is (true? (:ok body)))
      (let [audit (:audit body)]
        (is (map? audit))
        (is (number? (:db_size_mb audit)))
        (is (number? (:audit_rows audit)))
        (is (not (contains? audit :error)))))))

(deftest health-audit-block-degrades-on-probe-failure
  ;; A broken datasource must not tank /health — the block degrades to
  ;; {:error ...} and the response stays 200/ok.
  (with-redefs [mw/start-time-ms (- (System/currentTimeMillis) 1)]
    (let [resp (#'mw/health-response "not-a-datasource")
          body (json/read-str (:body resp) :key-fn keyword)]
      (is (= 200 (:status resp)))
      (is (true? (:ok body)))
      (is (some? (-> body :audit :error))))))
