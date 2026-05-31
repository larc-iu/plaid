(ns plaid.rest-api.v1.wrap-route-as-of-test
  "Unit-level coverage of `plaid.rest-api.v1.middleware/wrap-route-as-of`.

  The integration suite in `plaid.olap.integration-test` covers the
  REST-wired happy path (200 OK at-time GET) and a handful of error
  branches (425 future-ts, 400 malformed, 503 disabled). This namespace
  isolates the middleware itself: mock requests + redefs for the OLAP
  state + a stub handler, so every branch (parse error, sub-route
  reject, method reject, disabled, node-nil, not-caught-up, stalled,
  Throwable swallow) gets a direct assertion without standing up a real
  XTDB node or REST handler.

  Why unit-level matters: a refactor that breaks one branch (e.g. swaps
  the order of the parse and route-shape checks) might still pass the
  integration suite because the catch-all returns 400/503 through a
  different path. These tests pin the EXACT response for each branch."
  (:require [clojure.test :refer :all]
            [plaid.olap.core :as olap]
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
  "Stub downstream: returns 200 with the injected :as-of-node /
  :as-of-ts on the body so we can verify the middleware passed them
  through correctly."
  [request]
  {:status 200
   :body {:as-of-node (:as-of-node request)
          :as-of-ts (:as-of-ts request)}})

(defn- throwing-handler
  "Stub downstream that throws the given ex-info. Used to verify how
  the middleware maps `:olap/not-caught-up` / `:olap/stalled` /
  unexpected throws to HTTP statuses."
  [ex]
  (fn [_req] (throw ex)))

;; ============================================================
;; No as-of= → pass-through
;; ============================================================

(deftest no-as-of-param-passes-through-unchanged
  ;; The middleware must be transparent when ?as-of= is absent — no
  ;; injection of :as-of-node, no extra response handling. The handler
  ;; sees the raw request.
  (let [handler (mw/wrap-route-as-of echo-handler)
        resp (handler (mock-req :get valid-doc-uri))]
    (is (= 200 (:status resp)))
    (is (nil? (-> resp :body :as-of-node)))
    (is (nil? (-> resp :body :as-of-ts)))))

;; ============================================================
;; Malformed as-of= → 400
;; ============================================================

(deftest malformed-as-of-returns-400-with-error-body
  (let [handler (mw/wrap-route-as-of echo-handler)
        resp (handler (mock-req :get valid-doc-uri "as-of=not-an-iso"))]
    (is (= 400 (:status resp)))
    (is (re-find #"Invalid as-of" (-> resp :body :error))
        "error body names the field so the caller knows what to fix")))

;; ============================================================
;; as-of= on a non-top-level doc route → 400
;; ============================================================

(deftest as-of-on-doc-subroute-rejected-with-400
  ;; Lock / media / metadata sub-routes don't honor :as-of-node — without
  ;; this guard they'd silently serve CURRENT state, which is a worse
  ;; failure mode than 400ing the caller. Verify every sub-shape rejects.
  (let [handler (mw/wrap-route-as-of echo-handler)]
    (doseq [sub ["/lock" "/media" "/metadata" "/metadata/foo"]]
      (let [uri (str valid-doc-uri sub)
            resp (handler (mock-req :get uri (str "as-of=" valid-ts)))]
        (is (= 400 (:status resp)) (str "sub-route: " sub))
        (is (re-find #"not supported on this endpoint" (-> resp :body :error))
            (str "error body explains the restriction for sub-route: " sub))))))

;; ============================================================
;; as-of= with a non-GET method → 400
;; ============================================================

(deftest as-of-on-non-get-method-rejected-with-400
  ;; A PATCH/DELETE with ?as-of= would otherwise mutate OLTP while
  ;; appearing to operate at `ts` — a permission-bypass shape if the
  ;; caller thought they were operating against historical state. OPTIONS
  ;; is rejected too: it's CORS preflight, never a time-travel probe.
  ;; HEAD is allowed and covered in a separate test below.
  (let [handler (mw/wrap-route-as-of echo-handler)]
    (doseq [method [:patch :delete :post :put :options]]
      (let [resp (handler (mock-req method valid-doc-uri (str "as-of=" valid-ts)))]
        (is (= 400 (:status resp)) (str "method: " method))
        (is (re-find #"only allowed with GET or HEAD" (-> resp :body :error))
            (str "error body explains the restriction for method: " method))))))

(deftest as-of-on-head-passes-through-like-get
  ;; HEAD is a legitimate "does this exist at T?" probe — it must route
  ;; exactly like GET. The handler produces a body; ring's HEAD-handling
  ;; downstream strips it. We verify here that the middleware injects
  ;; :as-of-node + :as-of-ts and DOESN'T 400 the HEAD itself.
  (with-redefs [olap/enabled? (constantly true)
                olap/node ::stub-node]
    (let [handler (mw/wrap-route-as-of echo-handler)
          resp (handler (mock-req :head valid-doc-uri (str "as-of=" valid-ts)))]
      (is (= 200 (:status resp)) "HEAD routes through the wrapped handler, no 400")
      (is (= ::stub-node (-> resp :body :as-of-node))
          "HEAD gets the same :as-of-node injection as GET")
      (is (= (Instant/parse valid-ts) (-> resp :body :as-of-ts))
          "HEAD gets the same parsed :as-of-ts as GET"))))

;; ============================================================
;; Percent-encoded as-of value → decoded before parse (regression)
;; ============================================================

(deftest as-of-percent-encoded-colons-decode-and-parse
  ;; Regression for the play-house F1 bug: the official Python and JS
  ;; clients percent-encode the `:` separators of an ISO-8601 instant
  ;; (`%3A`). The middleware reads the RAW query string (malli would
  ;; otherwise strip the undeclared param); if it doesn't percent-decode,
  ;; `Instant/parse` chokes on the `%3A` and every real-client time-travel
  ;; GET 400s. These pin the decode behavior.
  (with-redefs [olap/enabled? (constantly true)
                olap/node ::stub-node]
    (let [handler (mw/wrap-route-as-of echo-handler)]
      (testing "%3A-encoded colons (UTC Z) decode to the same instant"
        (let [resp (handler (mock-req :get valid-doc-uri
                                      "as-of=2026-05-28T10%3A00%3A00Z"))]
          (is (= 200 (:status resp)) "must not 400 on encoded colons")
          (is (= (Instant/parse valid-ts) (-> resp :body :as-of-ts)))))
      (testing "fractional seconds + encoded colons decode"
        (let [resp (handler (mock-req :get valid-doc-uri
                                      "as-of=2026-05-29T19%3A23%3A56.419138504Z"))]
          (is (= 200 (:status resp)))
          (is (= (Instant/parse "2026-05-29T19:23:56.419138504Z")
                 (-> resp :body :as-of-ts)))))
      (testing "%2B-encoded `+` offset decodes to a real offset (not a space)"
        (let [resp (handler (mock-req :get valid-doc-uri
                                      "as-of=2026-05-28T10%3A00%3A00%2B00%3A00"))]
          (is (= 200 (:status resp)))
          (is (= (Instant/parse "2026-05-28T10:00:00+00:00")
                 (-> resp :body :as-of-ts)))))
      (testing "LITERAL `+` offset is preserved (not form-decoded to space)"
        (let [resp (handler (mock-req :get valid-doc-uri
                                      "as-of=2026-05-28T10:00:00+00:00"))]
          (is (= 200 (:status resp)) "literal + must survive, not become a space")
          (is (= (Instant/parse "2026-05-28T10:00:00+00:00")
                 (-> resp :body :as-of-ts))))))))

;; ============================================================
;; OLAP disabled → 503
;; ============================================================

(deftest as-of-with-olap-disabled-returns-503-olap-disabled
  (with-redefs [olap/enabled? (constantly false)]
    (let [handler (mw/wrap-route-as-of echo-handler)
          resp (handler (mock-req :get valid-doc-uri (str "as-of=" valid-ts)))]
      (is (= 503 (:status resp)))
      (is (= "olap disabled" (-> resp :body :error))
          "operators need to see this exact string so the dashboard can map it"))))

;; ============================================================
;; OLAP enabled but node nil → 503 (startup race)
;; ============================================================

(deftest as-of-with-nil-olap-node-returns-503-olap-not-ready
  ;; The node defstate can legitimately be nil during a startup race —
  ;; enabled? is true but the defstate hasn't reached :start yet. We
  ;; surface this as 503 "olap not ready" rather than crashing.
  (with-redefs [olap/enabled? (constantly true)
                olap/node nil]
    (let [handler (mw/wrap-route-as-of echo-handler)
          resp (handler (mock-req :get valid-doc-uri (str "as-of=" valid-ts)))]
      (is (= 503 (:status resp)))
      (is (= "olap not ready" (-> resp :body :error))))))

;; ============================================================
;; Happy path: handler receives :as-of-node + :as-of-ts
;; ============================================================

(deftest as-of-happy-path-injects-node-and-parsed-ts
  ;; Both :as-of-node and :as-of-ts must reach the handler — the handler
  ;; dispatches on :as-of-node to route through the OLAP read API, and
  ;; uses :as-of-ts as the snapshot anchor.
  (with-redefs [olap/enabled? (constantly true)
                olap/node ::stub-node]
    (let [handler (mw/wrap-route-as-of echo-handler)
          resp (handler (mock-req :get valid-doc-uri (str "as-of=" valid-ts)))]
      (is (= 200 (:status resp)))
      (is (= ::stub-node (-> resp :body :as-of-node))
          "the live olap/node var is forwarded so the handler can query it")
      (is (= (Instant/parse valid-ts) (-> resp :body :as-of-ts))
          ":as-of-ts is parsed once, in the middleware — handler gets an Instant"))))

;; ============================================================
;; Handler throws :olap/not-caught-up → 425
;; ============================================================

(deftest handler-not-caught-up-maps-to-425-with-cursor
  (let [ex (ex-info "olap not caught up"
                    {:type :olap/not-caught-up
                     :olap-cursor {:last-op-ts "2026-05-28T09:00:00Z"
                                   :last-op-id (random-uuid)}
                     :requested-ts "2026-05-28T10:00:00Z"})]
    (with-redefs [olap/enabled? (constantly true)
                  olap/node ::stub-node]
      (let [handler (mw/wrap-route-as-of (throwing-handler ex))
            resp (handler (mock-req :get valid-doc-uri (str "as-of=" valid-ts)))]
        (is (= 425 (:status resp)) "425 Too Early is the canonical response for not-caught-up")
        (is (= "olap not caught up" (-> resp :body :error)))
        (is (= "2026-05-28T09:00:00Z" (-> resp :body :olap-cursor))
            "cursor's last-op-ts is exposed so the caller knows when to retry")
        (is (some? (-> resp :body :requested-ts))
            "requested-ts is echoed so the caller can correlate")))))

;; ============================================================
;; 425 body-shape contract pin
;; ============================================================
;;
;; The 425 body has `:error` / `:olap-cursor` / `:requested-ts`. These
;; are part of the wire contract — frontends/dashboards parse them. Two
;; pins below cover the FULL ex-data shape and the MINIMAL shape (just
;; `:type`), to lock the contract for both cases.
;;
;; Convention chosen: when ex-data is missing `:olap-cursor` /
;; `:requested-ts`, the response keys are PRESENT-AS-NIL rather than
;; absent. Reason: callers writing `(:olap-cursor body)` then comparing
;; against nil already work; flipping to absent would require them to
;; `contains?`-check first. Cheaper to make the shape constant.

(deftest not-caught-up-body-shape-with-full-ex-data-pins-all-fields
  ;; Full ex-data → all three contract keys populated. This pins the
  ;; happy 425 case so a refactor that drops one of `:olap-cursor` /
  ;; `:requested-ts` fails loud.
  (let [cursor-ts "2026-05-28T09:00:00Z"
        requested-ts "2026-05-28T10:00:00Z"
        ex (ex-info "olap not caught up"
                    {:type :olap/not-caught-up
                     :olap-cursor {:last-op-ts cursor-ts
                                   :last-op-id (random-uuid)
                                   :last-seq 42}
                     :requested-ts requested-ts})]
    (with-redefs [olap/enabled? (constantly true)
                  olap/node ::stub-node]
      (let [handler (mw/wrap-route-as-of (throwing-handler ex))
            resp (handler (mock-req :get valid-doc-uri (str "as-of=" valid-ts)))
            body (:body resp)]
        (is (= 425 (:status resp)))
        (is (= "olap not caught up" (:error body)))
        (is (= cursor-ts (:olap-cursor body))
            ":olap-cursor extracts the cursor's :last-op-ts as a string")
        (is (= requested-ts (:requested-ts body))
            ":requested-ts is echoed verbatim from ex-data")
        (is (= #{:error :olap-cursor :requested-ts} (set (keys body)))
            "exactly these three keys on the 425 body — no more, no less")))))

(deftest not-caught-up-body-shape-with-minimal-ex-data-keys-present-as-nil
  ;; Minimal ex-data (only `:type`) → contract keys are PRESENT-AS-NIL
  ;; rather than absent. See the convention note above the previous
  ;; test. A producer that forgets to attach `:olap-cursor` /
  ;; `:requested-ts` still mints a 425 with the canonical key set, so
  ;; consumer code stays simple.
  (let [ex (ex-info "olap not caught up" {:type :olap/not-caught-up})]
    (with-redefs [olap/enabled? (constantly true)
                  olap/node ::stub-node]
      (let [handler (mw/wrap-route-as-of (throwing-handler ex))
            resp (handler (mock-req :get valid-doc-uri (str "as-of=" valid-ts)))
            body (:body resp)]
        (is (= 425 (:status resp)))
        (is (= "olap not caught up" (:error body)))
        (is (contains? body :olap-cursor)
            ":olap-cursor key is PRESENT (as nil) when ex-data omits it")
        (is (nil? (:olap-cursor body)))
        (is (contains? body :requested-ts)
            ":requested-ts key is PRESENT (as nil) when ex-data omits it")
        (is (nil? (:requested-ts body)))
        (is (= #{:error :olap-cursor :requested-ts} (set (keys body)))
            "same three-key shape regardless of ex-data completeness")))))

(deftest not-caught-up-cursor-string-passes-through-as-canonical-iso
  ;; Fix #14: the 425 body's `:olap-cursor` must be a canonical ISO-8601
  ;; string. The common case — cursor stores `:last-op-ts` as an ISO
  ;; string already — must pass through verbatim (no re-formatting, no
  ;; precision loss).
  (let [cursor-ts "2026-05-28T09:00:00Z"
        ex (ex-info "olap not caught up"
                    {:type :olap/not-caught-up
                     :olap-cursor {:last-op-ts cursor-ts
                                   :last-op-id (random-uuid)}
                     :requested-ts "2026-05-28T10:00:00Z"})]
    (with-redefs [olap/enabled? (constantly true)
                  olap/node ::stub-node]
      (let [handler (mw/wrap-route-as-of (throwing-handler ex))
            resp (handler (mock-req :get valid-doc-uri (str "as-of=" valid-ts)))
            body (:body resp)]
        (is (= 425 (:status resp)))
        (is (= cursor-ts (:olap-cursor body))
            "string cursor passes through verbatim as canonical ISO-8601")
        (is (string? (:olap-cursor body)))))))

(deftest not-caught-up-cursor-non-string-coerced-to-canonical-iso
  ;; Fix #14: if a future code path stores `:last-op-ts` as a non-string
  ;; (Instant / Date / ZonedDateTime), the body must still be canonical
  ;; ISO-8601 — NOT a bare `(str instant)` that happens to match for
  ;; Instant but emits garbage for Date. We coerce via olap/->instant
  ;; then .toString. Verify with an Instant and a java.util.Date that
  ;; both render to the same canonical string.
  (let [iso "2026-05-28T09:00:00Z"
        inst (Instant/parse iso)
        date (java.util.Date/from inst)]
    (doseq [[label cursor-val] [["Instant" inst] ["Date" date]]]
      (let [ex (ex-info "olap not caught up"
                        {:type :olap/not-caught-up
                         :olap-cursor {:last-op-ts cursor-val}
                         :requested-ts iso})]
        (with-redefs [olap/enabled? (constantly true)
                      olap/node ::stub-node]
          (let [handler (mw/wrap-route-as-of (throwing-handler ex))
                resp (handler (mock-req :get valid-doc-uri (str "as-of=" valid-ts)))
                body (:body resp)]
            (is (= 425 (:status resp)) label)
            (is (= iso (:olap-cursor body))
                (str label " cursor coerces to canonical ISO-8601, not (str ...)"))))))))

;; ============================================================
;; Handler throws :olap/read-timeout → 503 (Fix #16)
;; ============================================================

(deftest handler-read-timeout-maps-to-503-with-timeout-ms
  ;; Fix #16: a hung XTDB read is bounded by the handler's per-read
  ;; timeout, which throws `{:type :olap/read-timeout :timeout-ms N}`.
  ;; The middleware must map it to a 503 in the same family as
  ;; :olap/stalled — a dedicated error string + the timeout value, NOT
  ;; the generic correlation-id 503 (so operators can tell a timeout
  ;; apart from an arbitrary failure).
  (let [ex (ex-info "olap read timed out"
                    {:type :olap/read-timeout :timeout-ms 30000})]
    (with-redefs [olap/enabled? (constantly true)
                  olap/node ::stub-node]
      (let [handler (mw/wrap-route-as-of (throwing-handler ex))
            resp (handler (mock-req :get valid-doc-uri (str "as-of=" valid-ts)))]
        (is (= 503 (:status resp)))
        (is (= "olap read timed out" (-> resp :body :error))
            "dedicated error string, not the generic correlation-id 503")
        (is (= 30000 (-> resp :body :timeout-ms))
            "timeout-ms is surfaced so operators can confirm the cap")
        (is (nil? (-> resp :body :correlation-id))
            "read-timeout is a KNOWN type — no correlation-id fallthrough")))))

;; ============================================================
;; Handler throws :olap/stalled → 503 with stall reason
;; ============================================================

(deftest handler-stalled-maps-to-503-with-stall-reason
  (let [ex (ex-info "olap tailer stalled"
                    {:type :olap/stalled
                     :stall-reason "malformed audit row (at op-id=abc, seq=3)"})]
    (with-redefs [olap/enabled? (constantly true)
                  olap/node ::stub-node]
      (let [handler (mw/wrap-route-as-of (throwing-handler ex))
            resp (handler (mock-req :get valid-doc-uri (str "as-of=" valid-ts)))]
        (is (= 503 (:status resp)))
        (is (= "olap tailer stalled" (-> resp :body :error)))
        (is (re-find #"malformed" (-> resp :body :stall-reason))
            "stall-reason propagates to the client so operators can grep it")))))

;; ============================================================
;; Handler throws unexpected Throwable → 503 without stack leak
;; ============================================================

(deftest handler-unexpected-throwable-maps-to-503-no-stack-leak
  ;; Defensive: the OLAP read stack could throw anything (XTDB driver
  ;; exception, NPE on a malformed cursor, JDBC blip). We must NOT
  ;; leak the stack trace or the bare exception message — instead,
  ;; return a stable error string + a correlation id so the operator
  ;; can grep the log without the client ever seeing internals.
  (with-redefs [olap/enabled? (constantly true)
                olap/node ::stub-node]
    (let [handler (mw/wrap-route-as-of (throwing-handler
                                        (RuntimeException. "internal-detail-do-not-leak")))
          resp (handler (mock-req :get valid-doc-uri (str "as-of=" valid-ts)))]
      (is (= 503 (:status resp)))
      (is (= "olap read failed" (-> resp :body :error))
          "exception message is NOT leaked — fixed string only")
      (is (re-matches #"olap-[0-9a-f]+" (-> resp :body :correlation-id))
          "correlation-id format pins the log grep contract"))))

(deftest handler-typed-ex-info-other-than-known-cases-maps-to-503
  ;; Unknown typed ex-infos must NOT escape the middleware — they'd
  ;; leak `.getMessage` to the caller via the default ring 500 handler.
  ;; The single-Throwable-catch shape routes them to the same
  ;; 503/correlation-id response as any other unexpected error.
  (let [ex (ex-info "some-other-error-with-private-detail" {:type :totally-unknown})]
    (with-redefs [olap/enabled? (constantly true)
                  olap/node ::stub-node]
      (let [handler (mw/wrap-route-as-of (throwing-handler ex))
            resp (handler (mock-req :get valid-doc-uri (str "as-of=" valid-ts)))]
        (is (= 503 (:status resp))
            "unknown typed ex-info maps to the generic 503, not propagated")
        (is (= "olap read failed" (-> resp :body :error))
            "response body uses the generic error string, not the ex-info's message")
        (is (re-matches #"olap-[0-9a-f]+" (-> resp :body :correlation-id))
            "correlation-id is included for log grep")
        (is (not (re-find #"private-detail" (str (:body resp))))
            "the ex-info's private message is not leaked anywhere in the body")))))
