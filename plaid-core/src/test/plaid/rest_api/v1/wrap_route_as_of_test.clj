(ns plaid.rest-api.v1.wrap-route-as-of-test
  "Unit-level coverage of `plaid.rest-api.v1.middleware/wrap-route-as-of`.

  The integration coverage lives in `plaid.history.read-test` (parity,
  batch clamp, retention) — this namespace isolates the middleware
  itself: mock requests + a stub handler, so every branch (parse error,
  sub-route reject, method reject, pruned mapping, Throwable swallow)
  gets a direct assertion without standing up a REST handler.

  As-of reads are served from the audit log and are ALWAYS available —
  there is no disabled/node-nil/425-staleness branch to test anymore."
  (:require [clojure.test :refer :all]
            [plaid.rest-api.v1.middleware :as mw])
  (:import (java.time Instant)))

;; ============================================================
;; Helpers
;; ============================================================

(def ^:private valid-doc-uri
  "/api/v1/documents/11111111-2222-3333-4444-555555555555")

(def ^:private valid-ts "2026-05-28T10:00:00Z")

(defn- mock-req
  ([method uri] (mock-req method uri nil))
  ([method uri qs]
   (cond-> {:request-method method :uri uri}
     qs (assoc :query-string qs))))

(defn- echo-handler
  "Stub downstream: returns 200 with the injected :as-of-ts on the body
  so we can verify the middleware passed it through correctly."
  [request]
  {:status 200
   :body {:as-of-ts (:as-of-ts request)}})

(defn- throwing-handler
  [ex]
  (fn [_req] (throw ex)))

;; ============================================================
;; No as-of= → pass-through
;; ============================================================

(deftest no-as-of-param-passes-through-unchanged
  (let [handler (mw/wrap-route-as-of echo-handler)
        resp (handler (mock-req :get valid-doc-uri))]
    (is (= 200 (:status resp)))
    (is (nil? (-> resp :body :as-of-ts)))))

;; ============================================================
;; Request-shape rejections → 400
;; ============================================================

(deftest malformed-as-of-returns-400-with-error-body
  (let [handler (mw/wrap-route-as-of echo-handler)
        resp (handler (mock-req :get valid-doc-uri "as-of=yesterday-ish"))]
    (is (= 400 (:status resp)))
    (is (re-find #"ISO-8601" (-> resp :body :error)))))

(deftest as-of-on-doc-subroute-rejected-with-400
  (doseq [uri [(str valid-doc-uri "/media")
               (str valid-doc-uri "/lock")
               (str valid-doc-uri "/metadata/some-key")]]
    (let [handler (mw/wrap-route-as-of echo-handler)
          resp (handler (mock-req :get uri (str "as-of=" valid-ts)))]
      (is (= 400 (:status resp)) (str "sub-route " uri " must reject as-of"))
      (is (re-find #"top-level document GET" (-> resp :body :error))))))

(deftest as-of-on-non-get-method-rejected-with-400
  (doseq [method [:post :patch :put :delete :options]]
    (let [handler (mw/wrap-route-as-of echo-handler)
          resp (handler (mock-req method valid-doc-uri (str "as-of=" valid-ts)))]
      (is (= 400 (:status resp)) (str (name method) " must reject as-of"))
      (is (re-find #"GET or HEAD" (-> resp :body :error))))))

(deftest as-of-on-head-passes-through-like-get
  (let [handler (mw/wrap-route-as-of echo-handler)
        resp (handler (mock-req :head valid-doc-uri (str "as-of=" valid-ts)))]
    (is (= 200 (:status resp)))
    (is (= (Instant/parse valid-ts) (-> resp :body :as-of-ts)))))

;; ============================================================
;; Percent-encoding of the timestamp
;; ============================================================

(deftest as-of-percent-encoded-colons-decode-and-parse
  (let [handler (mw/wrap-route-as-of echo-handler)
        get-ts (fn [qs] (let [resp (handler (mock-req :get valid-doc-uri qs))]
                          [(:status resp) (-> resp :body :as-of-ts)]))]
    (testing "%3A-encoded colons (UTC Z) decode to the same instant"
      (is (= [200 (Instant/parse valid-ts)]
             (get-ts "as-of=2026-05-28T10%3A00%3A00Z"))))
    (testing "fractional seconds + encoded colons decode"
      (is (= [200 (Instant/parse "2026-05-28T10:00:00.123Z")]
             (get-ts "as-of=2026-05-28T10%3A00%3A00.123Z"))))
    (testing "%2B-encoded `+` offset decodes to a real offset (not a space)"
      (is (= [200 (Instant/parse "2026-05-28T10:00:00+02:00")]
             (get-ts "as-of=2026-05-28T10%3A00%3A00%2B02%3A00"))))
    (testing "LITERAL `+` offset is preserved (not form-decoded to space)"
      (is (= [200 (Instant/parse "2026-05-28T10:00:00+02:00")]
             (get-ts "as-of=2026-05-28T10:00:00+02:00"))))))

;; ============================================================
;; Happy path: :as-of-ts injected as a parsed Instant
;; ============================================================

(deftest as-of-happy-path-injects-parsed-ts
  (let [handler (mw/wrap-route-as-of echo-handler)
        resp (handler (mock-req :get valid-doc-uri (str "as-of=" valid-ts)))]
    (is (= 200 (:status resp)))
    (is (= (Instant/parse valid-ts) (-> resp :body :as-of-ts))
        ":as-of-ts is parsed once, in the middleware — handler gets an Instant")))

;; ============================================================
;; Error mapping
;; ============================================================

(deftest handler-pruned-maps-to-400-with-marker
  (let [handler (mw/wrap-route-as-of
                 (throwing-handler (ex-info "pruned"
                                            {:type :history/pruned
                                             :pruned-below-ts "2026-01-01T00:00:00.000000000Z"
                                             :requested-ts "2025-06-01T00:00:00.000000000Z"})))
        resp (handler (mock-req :get valid-doc-uri (str "as-of=" valid-ts)))]
    (is (= 400 (:status resp)))
    (is (re-find #"pruned" (-> resp :body :error)))
    (is (= "2026-01-01T00:00:00.000000000Z" (-> resp :body :pruned-below-ts)))
    (is (= "2025-06-01T00:00:00.000000000Z" (-> resp :body :requested-ts)))))

(deftest handler-unexpected-throwable-maps-to-500-no-stack-leak
  (let [handler (mw/wrap-route-as-of
                 (throwing-handler (RuntimeException. "secret internal detail")))
        resp (handler (mock-req :get valid-doc-uri (str "as-of=" valid-ts)))]
    (is (= 500 (:status resp)))
    (is (some? (-> resp :body :correlation-id)))
    (is (not (re-find #"secret" (str (:body resp))))
        "exception message must not leak to the client")))

(deftest handler-typed-ex-info-other-than-pruned-maps-to-500
  (let [handler (mw/wrap-route-as-of
                 (throwing-handler (ex-info "weird" {:type :something/else})))
        resp (handler (mock-req :get valid-doc-uri (str "as-of=" valid-ts)))]
    (is (= 500 (:status resp)))
    (is (some? (-> resp :body :correlation-id)))))
