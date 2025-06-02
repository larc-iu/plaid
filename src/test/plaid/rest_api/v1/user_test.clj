(ns plaid.rest-api.v1.user-test
  (:require [clojure.test :refer :all]
            [clojure.string]
            [ring.mock.request :as mock]
            [plaid.fixtures :refer [with-xtdb
                                    with-rest-handler
                                    rest-handler
                                    with-admin
                                    admin-token
                                    admin-request]]))

(use-fixtures :once with-xtdb with-rest-handler with-admin)

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
      (let [req (admin-request :get "/api/v1/users")
            resp (rest-handler req)
            body (parse-response-body resp)]
        (is (= (:status resp) 200))
        (is (seq? body))
        (is (some #(= (:user/username %) "a@b.com") body))))

    (testing "Patch on password works"
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
                    (mock/json-body {:username "test@example.com" :password "test123"}))
            resp (rest-handler req)
            body (parse-response-body resp)]
        (is (= (:status resp) 200))
        (is (contains? body :token))))

    (testing "Login fails with incorrect password"
      (let [req (-> (admin-request :post "/api/v1/login")
                    (mock/json-body {:username "test@example.com" :password "wrong-password"}))
            resp (rest-handler req)
            body (parse-response-body resp)]
        (is (= (:status resp) 401))
        (is (= body {:error "Invalid password"}))))

    (testing "Login fails with non-existent user"
      (let [req (-> (admin-request :post "/api/v1/login")
                    (mock/json-body {:username "nonexistent@example.com" :password "test123"}))
            resp (rest-handler req)
            body (parse-response-body resp)]
        (is (= (:status resp) 401))
        (is (= body {:error "User not found"}))))))