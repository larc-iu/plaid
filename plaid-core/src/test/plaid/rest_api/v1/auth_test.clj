(ns plaid.rest-api.v1.auth-test
  "Tests for the auth surface owned by `rest_api.v1.auth` and friends:
  /login redaction, JWT exp claim, /logout, login rate limiting, and
  batch op cap."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [clojure.string :as str]
            [buddy.sign.jwt :as jwt]
            [ring.mock.request :as mock]
            [taoensso.timbre :as log]
            [plaid.fixtures :as fixtures
             :refer [with-db with-mount-states with-rest-handler
                     rest-handler with-admin with-clean-db
                     admin-token admin-request parse-response-body]]
            [plaid.rest-api.v1.auth :as auth]
            [plaid.rest-api.v1.middleware :as middleware]
            [plaid.rest-api.v1.rate-limit :as rl]))

(defn- with-clean-rate-limit
  "Each-test fixture: start every test with empty rate-limit buckets so
  one test's failed-login spam doesn't leak into the next."
  [f]
  (rl/reset-all!)
  (f))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db with-clean-rate-limit)

;; ----------------------------------------------------------------------------
;; #88 — password and JWT must not appear in logs
;; ----------------------------------------------------------------------------

(defn- capture-logs
  "Run `f` while a custom timbre appender stashes every emitted log
  line into a vector. Returns the vector of stringified messages so
  the test can scan for forbidden substrings."
  [f]
  (let [lines (atom [])
        ;; Force a debug min-level for the duration of capture so we
        ;; pick up the wrap-logging request-shape line.
        appender-key ::test-capture]
    (log/merge-config!
     {:min-level :debug
      :appenders {appender-key
                  {:enabled? true
                   :fn (fn [data]
                         (swap! lines conj
                                (str (force (:msg_ data))
                                     " "
                                     (pr-str (:vargs data)))))}}})
    (try
      (f)
      (finally
        (log/merge-config! {:appenders {appender-key nil}
                            :min-level :info})))
    @lines))

(deftest password-not-in-logs
  (let [captured (capture-logs
                  (fn []
                    (let [req (-> (mock/request :post "/api/v1/login")
                                  (mock/header "accept" "application/edn")
                                  (mock/json-body {:user-id "admin@example.com"
                                                   :password "supersecret-PLAINTEXT-PW"}))]
                      (rest-handler req))))
        blob (str/join "\n" captured)]
    (is (false? (str/includes? blob "supersecret-PLAINTEXT-PW"))
        "Plaintext password must never appear in any log line.")
    (is (true? (str/includes? blob "<redacted>"))
        "Sensitive fields should appear as <redacted> in the debug log.")))

;; ----------------------------------------------------------------------------
;; #95 — JWT exp claim is set + verified on unsign
;; ----------------------------------------------------------------------------

(deftest jwt-has-exp-claim
  (let [req (-> (mock/request :post "/api/v1/login")
                (mock/header "accept" "application/edn")
                (mock/json-body {:user-id "admin@example.com" :password "password"}))
        token (-> (rest-handler req) :body slurp read-string :token)
        claims (jwt/unsign token "fake-secret")]
    (is (some? (:exp claims)) "Issued JWT must carry an :exp claim")
    (is (> (:exp claims) (quot (System/currentTimeMillis) 1000))
        "Issued :exp must be in the future")))

(deftest jwt-expired-token-rejected
  ;; Sign a token with an :exp already in the past. buddy verifies
  ;; :exp on unsign, so wrap-read-jwt should reject this with 401.
  ;; (We sign directly instead of issuing through /login because the
  ;; login route always picks a future exp.)
  (let [past-exp (- (quot (System/currentTimeMillis) 1000) 60)
        bad-token (jwt/sign {:user/id "admin@example.com"
                             :version 0
                             :exp past-exp}
                            "fake-secret")
        resp (rest-handler (-> (mock/request :get "/api/v1/users")
                               (mock/header "accept" "application/edn")
                               (mock/header "Authorization" (str "Bearer " bad-token))))]
    (is (= 401 (:status resp))
        "Expired JWT must be rejected with 401")))

(deftest missing-token-rejected-with-401
  ;; Play-house D3: a request with NO Authorization header to a
  ;; login-required endpoint must return 401 (authentication failure),
  ;; consistent with the 401 a malformed/expired token gets — not 403.
  ;; 403 is reserved for an authenticated user who lacks permission.
  (let [resp (rest-handler (-> (mock/request :get "/api/v1/projects")
                               (mock/header "accept" "application/edn")))]
    (is (= 401 (:status resp))
        "Missing credentials must be 401 (auth failure), not 403"))
  (testing "a garbage Bearer token is likewise 401 (consistency)"
    (let [resp (rest-handler (-> (mock/request :get "/api/v1/projects")
                                 (mock/header "accept" "application/edn")
                                 (mock/header "Authorization" "Bearer not-a-real-jwt")))]
      (is (= 401 (:status resp))))))

;; ----------------------------------------------------------------------------
;; #95 — /logout bumps password_changes; old token is rejected after
;; ----------------------------------------------------------------------------

(deftest logout-invalidates-token
  ;; Get a fresh token for admin, hit /logout with it, then verify the
  ;; same token can no longer access protected endpoints.
  (let [login (-> (mock/request :post "/api/v1/login")
                  (mock/header "accept" "application/edn")
                  (mock/json-body {:user-id "admin@example.com" :password "password"}))
        token (-> (rest-handler login) :body slurp read-string :token)
        auth-h (str "Bearer " token)
        ;; Sanity-check the token works first.
        pre (rest-handler (-> (mock/request :get "/api/v1/users")
                              (mock/header "accept" "application/edn")
                              (mock/header "Authorization" auth-h)))
        _ (is (= 200 (:status pre)))
        logout (rest-handler (-> (mock/request :post "/api/v1/logout")
                                 (mock/header "accept" "application/edn")
                                 (mock/header "Authorization" auth-h)))
        post (rest-handler (-> (mock/request :get "/api/v1/users")
                               (mock/header "accept" "application/edn")
                               (mock/header "Authorization" auth-h)))]
    (is (= 204 (:status logout)) "Logout must succeed with 204")
    (is (= 401 (:status post))
        "Old token must be rejected after /logout bumps password_changes")))

;; ----------------------------------------------------------------------------
;; #95 — login rate limiting kicks in after 10 failures
;; ----------------------------------------------------------------------------

(deftest login-rate-limited-after-10-failures
  ;; 10 failures should all return 401; the 11th must return 429.
  (let [bad-login (fn []
                    (rest-handler
                     (-> (mock/request :post "/api/v1/login")
                         (mock/header "accept" "application/edn")
                         (mock/json-body {:user-id "admin@example.com"
                                          :password "wrong-pw"}))))]
    (dotimes [_ 10]
      (let [resp (bad-login)]
        (is (= 401 (:status resp)) "First 10 bad attempts must return 401")))
    (let [resp (bad-login)]
      (is (= 429 (:status resp)) "11th bad attempt must return 429")
      (let [body (read-string (slurp (:body resp)))]
        (is (= "Too many login attempts, retry later" (:error body)))))))

;; ----------------------------------------------------------------------------
;; #111 — per-IP bucket catches credential spray (rotating usernames)
;; ----------------------------------------------------------------------------

(deftest login-rate-limited-per-ip-on-credential-spray
  ;; #111 regression: before this fix, the rate limiter was keyed by
  ;; (IP, username) only, so a single IP could keep hammering /login
  ;; indefinitely as long as it cycled the username on every attempt
  ;; (no single per-(IP, username) bucket ever reached the 10-failure
  ;; threshold). The new per-IP bucket caps total failures from one IP
  ;; at 100 per 15 min, regardless of how many distinct usernames the
  ;; attacker rotates through.
  (let [bad-login (fn [n]
                    ;; Build a fresh, ENV-invalid username on every attempt
                    ;; so no per-(IP, user) bucket ever fills. ring.mock
                    ;; gives every request the same :remote-addr by
                    ;; default, so all attempts share the per-IP bucket.
                    (rest-handler
                     (-> (mock/request :post "/api/v1/login")
                         (mock/header "accept" "application/edn")
                         (mock/json-body {:user-id (str "attacker-" n "@example.com")
                                          :password "wrong-pw"}))))]
    ;; 100 distinct failed attempts: every one returns 401 because no
    ;; single per-(IP, user) bucket reaches its 10-failure cap, and the
    ;; per-IP bucket is at exactly the threshold (100) AT the boundary
    ;; — `over-limit?` is `>=` so the 100th is the last 401.
    (dotimes [n 100]
      (let [resp (bad-login n)]
        (is (= 401 (:status resp))
            (str "Attempt #" (inc n) " must still be 401 (rotating usernames)"))))
    ;; The 101st attempt — still a fresh username, still wrong password
    ;; — must now hit the per-IP cap and return 429 even though no per-
    ;; (IP, user) bucket has more than 1 failure in it.
    (let [resp (bad-login 100)]
      (is (= 429 (:status resp))
          "101st attempt from the same IP (rotating usernames) must hit per-IP cap")
      (let [body (read-string (slurp (:body resp)))]
        (is (= "Too many login attempts, retry later" (:error body)))))))

;; ----------------------------------------------------------------------------
;; #95 — batch op cap rejects > 1000 sub-ops at the door
;; ----------------------------------------------------------------------------

(deftest batch-rejects-oversize-payload
  ;; Build a 1001-op batch of trivially valid GETs. The handler should
  ;; reject the whole thing with 400 before touching any DB tx.
  (let [ops (vec (repeat 1001 {:path "/api/v1/users" :method "GET"}))
        req (-> (mock/request :post "/api/v1/batch")
                (mock/header "accept" "application/edn")
                (mock/header "Authorization" (str "Bearer " admin-token))
                (mock/json-body ops))
        resp (rest-handler req)]
    (is (= 400 (:status resp))
        "Batch over the per-request cap must be rejected with 400")
    (let [body (read-string (slurp (:body resp)))]
      (is (string? (:error body)))
      (is (re-find #"(?i)max|exceeds" (:error body))))))

;; ----------------------------------------------------------------------------
;; #116 — redact-sensitive matches by local name, catches namespaced variants
;; ----------------------------------------------------------------------------

(deftest redact-sensitive-catches-namespaced-keys
  ;; Pre-fix the matcher used a literal set so :user/password,
  ;; :plaid.auth/token and :secret-key all slipped past. Verify each
  ;; namespaced variant is now redacted.
  (testing "Namespaced sensitive keys are redacted on name match"
    (let [redacted (middleware/redact-sensitive
                    {:user/password "PLAINTEXT"
                     :plaid.auth/token "eyJlong.jwt"
                     :secret-key "TOPSECRET"
                     :nested {:authorization "Bearer x"}
                     :ok-key "visible"})]
      (is (= "<redacted>" (:user/password redacted)))
      (is (= "<redacted>" (:plaid.auth/token redacted)))
      (is (= "<redacted>" (:secret-key redacted)))
      (is (= "<redacted>" (get-in redacted [:nested :authorization])))
      (is (= "visible" (:ok-key redacted)))))

  (testing "Plain string keys also match by name"
    (let [redacted (middleware/redact-sensitive
                    {"password" "x" "Authorization" "y" "ok" "visible"})]
      (is (= "<redacted>" (get redacted "password")))
      (is (= "<redacted>" (get redacted "Authorization")))
      (is (= "visible" (get redacted "ok"))))))

;; ----------------------------------------------------------------------------
;; #117 — JWT TTL reads from config; expired-token test honors a configurable TTL
;; ----------------------------------------------------------------------------

(deftest jwt-ttl-honors-config-override
  ;; The TTL is read at call time from `config`, defaulting to 30 days.
  ;; Stubbing a 60-second override should make freshly-issued tokens
  ;; carry an :exp roughly 60 seconds in the future, not 30 days.
  (with-redefs [auth/jwt-ttl-seconds (constantly 60)]
    (let [req (-> (mock/request :post "/api/v1/login")
                  (mock/header "accept" "application/edn")
                  (mock/json-body {:user-id "admin@example.com" :password "password"}))
          token (-> (rest-handler req) :body slurp read-string :token)
          {:keys [exp]} (jwt/unsign token "fake-secret")
          now (quot (System/currentTimeMillis) 1000)
          ttl (- exp now)]
      (is (some? exp))
      ;; Allow some slop for test runtime.
      (is (<= 50 ttl 70)
          (str "Issued :exp must be within ~60s when configured TTL is 60s; got "
               ttl " seconds")))))
