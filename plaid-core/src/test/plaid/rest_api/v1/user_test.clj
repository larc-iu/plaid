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
                    (mock/json-body {:username "a@b.com" :password "fake-password" :is-admin true}))
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
                :user/username         "a@b.com"
                :user/is-admin         true}))))

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
        (is (some #(= (:user/username %) "a@b.com") (:entries body)))))

    #_(testing "Patch on password works"
        (let [req (-> (admin-request :patch "/api/v1/users/a@b.com")
                      (mock/json-body {:password "new-password123"}))
              resp (rest-handler req)
              body (parse-response-body resp)]
          (is (= 1 (:user/password-changes body)))))

    (testing "Delete user succeeds"
      (let [req (admin-request :delete "/api/v1/users/a@b.com")
            resp (rest-handler req)]
        (is (= (:status resp) 204)))

      (testing "User is actually deleted"
        (let [req (admin-request :get "/api/v1/users/a@b.com")
              resp (rest-handler req)]
          (is (= (:status resp) 404))))))

  (testing "Authentication"
    (testing "Create test user for login"
      (let [req (-> (admin-request :post "/api/v1/users")
                    (mock/json-body {:username "test@example.com" :password "test123" :is-admin false}))
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

(deftest user-list-search-and-auth
  ;; The roster list/search (GET /users) is admin-OR-maintainer only, with a
  ;; `?q=` username filter used by the project-permissions UI.
  (testing "?q= filters to matching usernames (case-insensitive substring)"
    (doseq [u ["alice@example.com" "bob@example.com"]]
      (rest-handler (-> (admin-request :post "/api/v1/users")
                        (mock/json-body {:username u :password "password1" :is-admin false}))))
    (let [resp (rest-handler (admin-request :get "/api/v1/users?q=ALIC"))
          body (parse-response-body resp)
          names (set (map :user/username (:entries body)))]
      (is (= 200 (:status resp)))
      (is (contains? names "alice@example.com"))
      (is (not (contains? names "bob@example.com")))))

  (testing "a non-admin, non-maintainer may NOT list users (403)"
    (let [resp (rest-handler (user1-request :get "/api/v1/users"))]
      (is (= 403 (:status resp)))))

  (testing "once user1 maintains a project, they MAY list users (200)"
    (let [created (rest-handler (-> (user1-request :post "/api/v1/projects")
                                    (mock/json-body {:name "user1 project"})))]
      (is (= 201 (:status created)))
      (let [resp (rest-handler (user1-request :get "/api/v1/users"))]
        (is (= 200 (:status resp)))))))