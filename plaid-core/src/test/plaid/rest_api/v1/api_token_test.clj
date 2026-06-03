(ns plaid.rest-api.v1.api-token-test
  "End-to-end tests for named per-user API tokens: minting via REST,
  authenticating with a minted token, revocation, the survives-password-
  change / survives-logout invariants, ACL on the management endpoints, and
  server-authoritative audit attribution (`:audit/api-token`)."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [ring.mock.request :as mock]
            [plaid.fixtures :as fixtures
             :refer [with-db with-mount-states with-rest-handler with-admin with-test-users
                     with-clean-db rest-handler db api-call
                     admin-request user1-request user2-request
                     assert-ok assert-created assert-no-content assert-forbidden assert-not-found]]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :as h]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

;; ---------------------------------------------------------------------------
;; helpers
;; ---------------------------------------------------------------------------

(defn- tokens-path [user-id] (str "/api/v1/users/" user-id "/tokens"))

(defn- mint!
  "Mint a token via REST. Returns the parsed response."
  [request-fn user-id name]
  (api-call request-fn {:method :post :path (tokens-path user-id) :body {:name name}}))

(defn- token-req-fn
  "A `user-request-fn` (method, path -> ring request) that authenticates with
  the given raw token string (a minted API token JWT)."
  [token]
  (fn [method path]
    (-> (mock/request method path)
        (mock/header "accept" "application/edn")
        (mock/header "Authorization" (str "Bearer " token)))))

(defn- create-and-login!
  "Create a throwaway non-admin user (wiped by with-clean-db next test, so it
  never poisons the standing user1/user2 session tokens) and return a fresh
  session token for it."
  [user-id password]
  (api-call admin-request {:method :post :path "/api/v1/users"
                           :body {:username user-id :password password :is-admin false}})
  (let [resp (rest-handler (-> (mock/request :post "/api/v1/login")
                               (mock/header "accept" "application/edn")
                               (mock/json-body {:user-id user-id :password password})))]
    (-> resp :body slurp read-string :token)))

;; ---------------------------------------------------------------------------
;; mint / list / revoke
;; ---------------------------------------------------------------------------

(deftest mint-list-and-use
  (let [resp (mint! user1-request "user1@example.com" "svc")]
    (assert-created resp)
    (testing "mint returns id + name + the signed token (once)"
      ;; :id is a string on the JSON wire; the EDN test harness round-trips
      ;; it as a #uuid object (psc coerces id columns), so assert presence.
      (is (some? (-> resp :body :id)))
      (is (= "svc" (-> resp :body :name)))
      (is (string? (-> resp :body :token))))
    (let [tok (-> resp :body :token)
          tid (-> resp :body :id)]
      (testing "list shows the token but never the signed secret"
        (let [lr (api-call user1-request {:method :get :path (tokens-path "user1@example.com")})]
          (assert-ok lr)
          (is (= 1 (count (:entries (:body lr)))))
          (let [t (first (:entries (:body lr)))]
            (is (= tid (:api-token/id t)))
            (is (= "svc" (:api-token/name t)))
            (is (nil? (:api-token/revoked-at t)))
            (is (not (contains? t :token))))))
      (testing "the minted token authenticates real requests"
        (assert-ok (api-call (token-req-fn tok)
                             {:method :get :path (tokens-path "user1@example.com")}))))))

(deftest revoke-then-401
  (let [resp (mint! user1-request "user1@example.com" "svc")
        tok (-> resp :body :token)
        tid (-> resp :body :id)]
    (testing "works before revoke"
      (assert-ok (api-call (token-req-fn tok) {:method :get :path (tokens-path "user1@example.com")})))
    (testing "owner revokes"
      (assert-no-content (api-call user1-request {:method :delete
                                                  :path (str (tokens-path "user1@example.com") "/" tid)})))
    (testing "revoked token is rejected"
      (is (= 401 (:status (api-call (token-req-fn tok)
                                    {:method :get :path (tokens-path "user1@example.com")})))))
    (testing "revoked token still listed with revoked-at set"
      (let [t (first (:entries (:body (api-call user1-request {:method :get :path (tokens-path "user1@example.com")}))))]
        (is (some? (:api-token/revoked-at t)))))))

(deftest revoke-unknown-404
  (assert-not-found (api-call user1-request {:method :delete
                                             :path (str (tokens-path "user1@example.com") "/no-such-id")})))

;; ---------------------------------------------------------------------------
;; lifecycle invariants: survive password change AND logout
;; ---------------------------------------------------------------------------

(deftest survives-password-change
  (let [session (create-and-login! "pw-user@example.com" "origpw")
        tok (-> (mint! (token-req-fn session) "pw-user@example.com" "svc") :body :token)]
    (testing "both session + API token work initially"
      (assert-ok (api-call (token-req-fn session) {:method :get :path (tokens-path "pw-user@example.com")}))
      (assert-ok (api-call (token-req-fn tok) {:method :get :path (tokens-path "pw-user@example.com")})))
    ;; Change the password (bumps password_changes → invalidates session tokens).
    (api-call (token-req-fn session) {:method :patch :path "/api/v1/users/pw-user@example.com"
                                      :body {:password "newpw123"}})
    (testing "session token now invalid (control)"
      (is (= 401 (:status (api-call (token-req-fn session)
                                    {:method :get :path (tokens-path "pw-user@example.com")})))))
    (testing "API token survives the password change"
      (assert-ok (api-call (token-req-fn tok) {:method :get :path (tokens-path "pw-user@example.com")})))))

(deftest survives-logout
  (let [session (create-and-login! "lo-user@example.com" "origpw")
        tok (-> (mint! (token-req-fn session) "lo-user@example.com" "svc") :body :token)]
    (testing "logout bumps password_changes → session token dies"
      (assert-no-content (api-call (token-req-fn session) {:method :post :path "/api/v1/logout"}))
      (is (= 401 (:status (api-call (token-req-fn session)
                                    {:method :get :path (tokens-path "lo-user@example.com")})))))
    (testing "API token survives /logout"
      (assert-ok (api-call (token-req-fn tok) {:method :get :path (tokens-path "lo-user@example.com")})))))

;; ---------------------------------------------------------------------------
;; ACL on the management endpoints
;; ---------------------------------------------------------------------------

(deftest acl-self-or-admin
  (testing "a user cannot mint tokens for another user"
    (assert-forbidden (mint! user2-request "user1@example.com" "evil")))
  (testing "a user cannot list another user's tokens"
    (assert-forbidden (api-call user2-request {:method :get :path (tokens-path "user1@example.com")})))
  (testing "admin can mint for any user"
    (assert-created (mint! admin-request "user1@example.com" "admin-minted"))))

;; ---------------------------------------------------------------------------
;; audit attribution
;; ---------------------------------------------------------------------------

(deftest audit-attributes-named-token
  (let [tok (-> (mint! user1-request "user1@example.com" "auditbot") :body :token)
        ;; user1 creates a project USING the API token → op user_id=user1,
        ;; token_id set; user1 becomes maintainer so can read the audit log.
        proj (h/create-test-project (token-req-fn tok) "TokAuditProj")
        ;; control: a project created via the session token
        sess-proj (h/create-test-project user1-request "SessionProj")]
    ;; Read the audit log as admin (admin bypasses project ACL); the token_id
    ;; enrichment is independent of who reads it.
    (testing "token-created project's create op carries :audit/api-token"
      (let [entries (:entries (:body (h/get-project-audit admin-request proj)))
            create-entry (first (filter #(= :project/create (-> % :audit/ops first :op/type)) entries))]
        (is (some? create-entry))
        (is (= "auditbot" (-> create-entry :audit/api-token :token/name)))))
    (testing "session-created project's create op has NO :audit/api-token"
      (let [entries (:entries (:body (h/get-project-audit admin-request sess-proj)))
            create-entry (first (filter #(= :project/create (-> % :audit/ops first :op/type)) entries))]
        (is (some? create-entry))
        (is (nil? (:audit/api-token create-entry)))))))

(deftest batch-ops-attributed-to-token
  (let [resp (mint! user1-request "user1@example.com" "batchbot")
        tok (-> resp :body :token)
        tid (-> resp :body :id)
        operations [{:path "/api/v1/projects" :method "post" :body {:name "BatchP1"}}
                    {:path "/api/v1/projects" :method "post" :body {:name "BatchP2"}}]
        batch-req (-> (mock/request :post "/api/v1/batch")
                      (mock/header "accept" "application/edn")
                      (mock/json-body operations)
                      (mock/header "authorization" (str "Bearer " tok)))
        _ (rest-handler batch-req)
        rows (psc/q db {:select [:token_id]
                        :from [:operations]
                        :where [:and
                                [:= :op_type "project/create"]
                                [:not= :batch_id nil]]})]
    (testing "every batched create op is attributed to the minting token"
      (is (= 2 (count rows)))
      (is (every? #(= tid (:token_id %)) rows)))))
