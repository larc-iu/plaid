(ns plaid.rest-api.v1.user-test
  (:require [clojure.test :refer :all]
            [clojure.string]
            [ring.mock.request :as mock]
            [plaid.fixtures :refer [with-db
                                    with-mount-states
                                    with-rest-handler
                                    rest-handler
                                    with-admin
                                    admin-token
                                    admin-request
                                    with-test-users
                                    user1-request with-clean-db]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn parse-response-body [response]
  (read-string (slurp (:body response))))

(deftest user-endpoints
  (testing "User creation and retrieval"
    (testing "Create user succeeds"
      (let [req (-> (admin-request :post "/api/v1/users")
                    (mock/json-body {:email "a@b.com" :password "fake-password" :is-admin true}))
            resp (rest-handler req)]
        (is (= (:status resp) 201))
        (is (= (parse-response-body resp) {:id "a@b.com"}))))

    (testing "Get user by ID succeeds"
      (let [req (admin-request :get "/api/v1/users/a@b.com")
            resp (rest-handler req)
            body (parse-response-body resp)]
        (is (= (:status resp) 200))
        (is (= body
               {:user/id               "a@b.com"
                ;; No display name supplied at creation -> the local part.
                :user/display-name     "a"
                :user/is-admin         true
                :user/deactivated-at   nil
                :user/avatar-hash      nil}))))

    (testing "Get non-existent user fails"
      (let [req (admin-request :get "/api/v1/users/nonexistent")
            resp (rest-handler req)
            body (parse-response-body resp)]
        (is (= (:status resp) 404))
        (is (= body {:error "User not found"}))))

    (testing "List all users"
      ;; GET /users returns the uniform {:entries :next-cursor} pagination
      ;; envelope (admin-only, task #95 + #99).
      (let [req (admin-request :get "/api/v1/users")
            resp (rest-handler req)
            body (parse-response-body resp)]
        (is (= (:status resp) 200))
        (is (contains? body :entries))
        (is (contains? body :next-cursor))
        (is (some #(= (:user/id %) "a@b.com") (:entries body)))))

    #_(testing "Patch on password works"
        (let [req (-> (admin-request :patch "/api/v1/users/a@b.com")
                      (mock/json-body {:password "new-password123"}))
              resp (rest-handler req)
              body (parse-response-body resp)]
          (is (= 1 (:user/password-changes body)))))

    (testing "Delete (= deactivate) user succeeds"
      (let [req (admin-request :delete "/api/v1/users/a@b.com")
            resp (rest-handler req)]
        (is (= (:status resp) 204)))

      (testing "User is deactivated, not deleted — still visible with deactivated-at"
        (let [req (admin-request :get "/api/v1/users/a@b.com")
              resp (rest-handler req)
              body (parse-response-body resp)]
          (is (= (:status resp) 200))
          (is (string? (:user/deactivated-at body)))))))

  (testing "Authentication"
    (testing "Create test user for login"
      (let [req (-> (admin-request :post "/api/v1/users")
                    (mock/json-body {:email "test@example.com" :password "test123" :is-admin false}))
            resp (rest-handler req)]
        (is (= (:status resp) 201))))

    (testing "Login succeeds with correct credentials"
      (let [req (-> (admin-request :post "/api/v1/login")
                    (mock/json-body {:user-id "test@example.com" :password "test123"}))
            resp (rest-handler req)
            body (parse-response-body resp)]
        (is (= (:status resp) 200))
        (is (contains? body :token))))

    (testing "Login fails with incorrect password"
      (let [req (-> (admin-request :post "/api/v1/login")
                    (mock/json-body {:user-id "test@example.com" :password "wrong-password"}))
            resp (rest-handler req)
            body (parse-response-body resp)]
        (is (= (:status resp) 401))
        ;; Generic message in both branches to avoid user-enumeration.
        (is (= body {:error "Invalid credentials"}))))

    (testing "Login fails with non-existent user"
      (let [req (-> (admin-request :post "/api/v1/login")
                    (mock/json-body {:user-id "nonexistent@example.com" :password "test123"}))
            resp (rest-handler req)
            body (parse-response-body resp)]
        (is (= (:status resp) 401))
        ;; Same generic message — must not leak that the user doesn't exist.
        (is (= body {:error "Invalid credentials"}))))))

(deftest user-ids-must-be-email-addresses
  ;; A user's ID IS their email address instance-wide. One rule, enforced at
  ;; the single chokepoint every account-creating path goes through
  ;; (`plaid.sql.user/assert-valid-email!`); invite redemption is exercised in
  ;; invite-test.
  (let [create (fn [email]
                 (rest-handler (-> (admin-request :post "/api/v1/users")
                                   (mock/json-body {:email email
                                                    :password "correcthorsebatterystaple"
                                                    :is-admin false}))))]

    (testing "a bare name is refused at creation"
      (doseq [bad ["jsmith" "has space@example.com" "no@dot" "@example.com" "trailing@"]]
        ;; `parse-response-body` slurps the body stream, so read it ONCE.
        (let [resp (create bad)
              body (parse-response-body resp)]
          (is (= 400 (:status resp)) (str "expected 400 for " (pr-str bad)))
          (is (re-find #"email" (:error body))
              (str "error should name the rule, got: " (pr-str body))))))

    (testing "an email address is accepted"
      (is (= 201 (:status (create "valid.user+tag@example.co.uk")))))))

(deftest display-names-are-the-only-mutable-label
  ;; The email/ID is what `POST /login` authenticates against, so nothing may
  ;; rewrite it — a PATCH that tried would lock the user out of their own
  ;; account. The display name is the label that CAN change.
  (let [create (fn [email body]
                 (rest-handler (-> (admin-request :post "/api/v1/users")
                                   (mock/json-body (clojure.core/merge
                                                    {:email email
                                                     :password "correcthorsebatterystaple"
                                                     :is-admin false}
                                                    body)))))
        patch  (fn [id body]
                 (rest-handler (-> (admin-request :patch (str "/api/v1/users/" id))
                                   (mock/json-body body))))
        fetch  (fn [id] (parse-response-body
                         (rest-handler (admin-request :get (str "/api/v1/users/" id)))))]

    (testing "creation defaults the display name to the email's local part"
      (is (= 201 (:status (create "nomen@example.com" {}))))
      (is (= "nomen" (:user/display-name (fetch "nomen@example.com")))))

    (testing "creation accepts an explicit display name"
      (is (= 201 (:status (create "explicit@example.com" {:display-name "Ada Lovelace"}))))
      (is (= "Ada Lovelace" (:user/display-name (fetch "explicit@example.com")))))

    (testing "the display name can be changed, and need not look like an email"
      (is (= 200 (:status (patch "nomen@example.com" {:display-name "Grace Hopper"}))))
      (is (= "Grace Hopper" (:user/display-name (fetch "nomen@example.com")))))

    (testing "a blank display name is refused"
      (is (= 400 (:status (patch "nomen@example.com" {:display-name "   "}))))
      (is (= "Grace Hopper" (:user/display-name (fetch "nomen@example.com")))))

    (testing "display names need not be unique"
      (is (= 200 (:status (patch "explicit@example.com" {:display-name "Grace Hopper"}))))
      (is (= "Grace Hopper" (:user/display-name (fetch "explicit@example.com")))))

    (testing "the ID/email is not a PATCHable field, and the account keeps it"
      ;; The body schema has no such field, and reitit's coercion strips what
      ;; it does not declare, so an attempt to sneak one in is a no-op rather
      ;; than a rename. This is the actual regression: the address the user
      ;; logs in with must survive anything the profile form can send.
      (doseq [body [{:email "elsewhere@example.com"}
                    {:username "elsewhere@example.com"}
                    {:id "elsewhere@example.com"}
                    {:user/id "elsewhere@example.com"}]]
        (patch "nomen@example.com" body)
        (is (= "nomen@example.com" (:user/id (fetch "nomen@example.com")))
            (str "id survives PATCH " (pr-str body)))
        (is (= 404 (:status (rest-handler (admin-request :get "/api/v1/users/elsewhere@example.com"))))
            (str "no account appeared at the address in " (pr-str body))))

      (testing "and the original address still logs in"
        (let [resp (rest-handler (-> (mock/request :post "/api/v1/login")
                                     (mock/header "accept" "application/edn")
                                     (mock/json-body {:user-id "nomen@example.com"
                                                      :password "correcthorsebatterystaple"})))]
          (is (= 200 (:status resp)))
          (is (string? (:token (parse-response-body resp)))))))))

(deftest user-deactivation-lifecycle
  ;; Users are never hard-deleted (operations.user_id / token_id FKs +
  ;; audit attribution must survive). DELETE deactivates; POST
  ;; /users/:id/activate restores login only. Before this, DELETE
  ;; hard-deleted the row and 500'd on the operations FK for any user
  ;; with write history.
  (let [login (fn [user pass]
                (rest-handler (-> (mock/request :post "/api/v1/login")
                                  (mock/header "accept" "application/edn")
                                  (mock/json-body {:user-id user :password pass}))))
        bearer-get (fn [token path]
                     (rest-handler (-> (mock/request :get path)
                                       (mock/header "accept" "application/edn")
                                       (mock/header "authorization" (str "Bearer " token)))))
        _ (is (= 201 (:status (rest-handler (-> (admin-request :post "/api/v1/users")
                                                (mock/json-body {:email "deact@example.com"
                                                                 :password "hunter22"
                                                                 :is-admin false}))))))
        token (-> (login "deact@example.com" "hunter22") parse-response-body :token)
        api-tok (-> (rest-handler (-> (mock/request :post "/api/v1/users/deact@example.com/tokens")
                                      (mock/header "accept" "application/edn")
                                      (mock/json-body {:name "svc"})
                                      (mock/header "authorization" (str "Bearer " token))))
                    parse-response-body
                    :token)]
    (is (string? token) "user can log in before deactivation")
    (is (= 200 (:status (bearer-get token "/api/v1/users/deact@example.com")))
        "session token works before deactivation")
    (is (= 200 (:status (bearer-get api-tok "/api/v1/users/deact@example.com")))
        "API token works before deactivation")

    (testing "deactivation rejects logins, kills live tokens, stays visible"
      (is (= 204 (:status (rest-handler (admin-request :delete "/api/v1/users/deact@example.com")))))
      (let [resp (login "deact@example.com" "hunter22")]
        (is (= 401 (:status resp)) "login rejected after deactivation")
        (is (= {:error "Invalid credentials"} (parse-response-body resp))
            "same generic message as a wrong password — no enumeration of deactivated accounts"))
      (is (= 401 (:status (bearer-get token "/api/v1/users/deact@example.com")))
          "pre-deactivation session token is dead immediately")
      (is (= 401 (:status (bearer-get api-tok "/api/v1/users/deact@example.com")))
          "API token is dead too (revoked by deactivation)")
      (let [body (parse-response-body (rest-handler (admin-request :get "/api/v1/users")))]
        (is (some #(and (= "deact@example.com" (:user/id %))
                        (string? (:user/deactivated-at %)))
                  (:entries body))
            "deactivated user remains listed, flagged with deactivated-at"))
      (is (= 400 (:status (rest-handler (admin-request :delete "/api/v1/users/deact@example.com"))))
          "double deactivation is a structured 400"))

    (testing "reactivation restores login only"
      (let [resp (rest-handler (admin-request :post "/api/v1/users/deact@example.com/activate"))
            body (parse-response-body resp)]
        (is (= 200 (:status resp)))
        (is (nil? (:user/deactivated-at body)) "deactivated-at cleared"))
      (is (= 200 (:status (login "deact@example.com" "hunter22")))
          "login works again with the same password")
      (is (= 401 (:status (bearer-get token "/api/v1/users/deact@example.com")))
          "the OLD token stays dead (password_changes is monotonic)")
      (is (= 401 (:status (bearer-get api-tok "/api/v1/users/deact@example.com")))
          "API tokens were REVOKED at deactivation, not suspended — reactivation does not resurrect them")
      (is (= 400 (:status (rest-handler (admin-request :post "/api/v1/users/deact@example.com/activate"))))
          "activating an active user is a structured 400"))

    (testing "non-admins can do neither"
      (is (= 403 (:status (rest-handler (user1-request :delete "/api/v1/users/deact@example.com")))))
      (is (= 403 (:status (rest-handler (user1-request :post "/api/v1/users/deact@example.com/activate"))))))

    (testing "the last-admin guard holds"
      ;; admin@example.com (the fixture admin) is the only admin here.
      (let [resp (rest-handler (admin-request :delete "/api/v1/users/admin@example.com"))]
        (is (= 400 (:status resp)))
        (is (re-find #"last admin" (:error (parse-response-body resp))))))))

(deftest user-list-search-and-auth
  ;; The roster list/search (GET /users) is admin-OR-maintainer only, with a
  ;; `?q=` filter used by the project-permissions UI. It matches display name
  ;; OR email, because the searcher may only know one of the two.
  (testing "?q= filters on the email (case-insensitive substring)"
    (doseq [u ["alice@example.com" "bob@example.com"]]
      (rest-handler (-> (admin-request :post "/api/v1/users")
                        (mock/json-body {:email u :password "password1" :is-admin false}))))
    (let [resp (rest-handler (admin-request :get "/api/v1/users?q=ALIC"))
          body (parse-response-body resp)
          ids (set (map :user/id (:entries body)))]
      (is (= 200 (:status resp)))
      (is (contains? ids "alice@example.com"))
      (is (not (contains? ids "bob@example.com")))))

  (testing "?q= also matches the display name"
    (rest-handler (-> (admin-request :post "/api/v1/users")
                      (mock/json-body {:email "cdarwin@example.com" :password "password1"
                                       :is-admin false :display-name "Charles Darwin"})))
    (let [body (parse-response-body (rest-handler (admin-request :get "/api/v1/users?q=darwin")))
          ids (set (map :user/id (:entries body)))]
      (is (contains? ids "cdarwin@example.com"))
      (is (not (contains? ids "bob@example.com")))))

  (testing "a non-admin, non-maintainer may NOT list users (403)"
    (let [resp (rest-handler (user1-request :get "/api/v1/users"))]
      (is (= 403 (:status resp)))))

  (testing "once user1 maintains a project, they MAY list users (200)"
    (let [created (rest-handler (-> (user1-request :post "/api/v1/projects")
                                    (mock/json-body {:name "user1 project"})))]
      (is (= 201 (:status created)))
      (let [resp (rest-handler (user1-request :get "/api/v1/users"))]
        (is (= 200 (:status resp)))))))

(deftest user-directory-vocab-maintainer-access
  ;; A vocab-only maintainer (maintains no project) can also read the directory:
  ;; they need it to find users to grant vocab maintainership. Fresh DB via the
  ;; :each fixture, so user1 maintains nothing at the start.
  (testing "a non-admin who maintains nothing may NOT list users (403)"
    (is (= 403 (:status (rest-handler (user1-request :get "/api/v1/users"))))))

  (testing "once user1 maintains a vocab layer, they MAY list users (200)"
    (let [created (rest-handler (-> (user1-request :post "/api/v1/vocab-layers")
                                    (mock/json-body {:name "user1 vocab"})))]
      (is (= 201 (:status created)))
      (is (= 200 (:status (rest-handler (user1-request :get "/api/v1/users"))))))))