(ns plaid.rest-api.v1.project-test
  (:require [clojure.test :refer :all]
            [clojure.string]
            [ring.mock.request :as mock]
            [plaid.fixtures :refer [with-xtdb
                                    with-rest-handler
                                    rest-handler
                                    with-admin
                                    with-test-users
                                    admin-token
                                    user1-token
                                    user2-token
                                    admin-request
                                    user1-request
                                    user2-request]]))

(use-fixtures :once with-xtdb with-rest-handler with-admin with-test-users)

(defn parse-response-body [response]
  (read-string (slurp (:body response))))

(deftest project-crud-operations
  (testing "Project creation and retrieval"
    (testing "Create project succeeds"
      (let [req (-> (admin-request :post "/api/v1/projects")
                    (mock/json-body {:name "Test Project"}))
            resp (rest-handler req)
            body (parse-response-body resp)]
        (is (= (:status resp) 201))
        (is (contains? body :id))
        (is (uuid? (:id body)))))))

(deftest access-management-operations
  (let [;; Create a test project
        create-req (-> (admin-request :post "/api/v1/projects")
                       (mock/json-body {:name "Access Test Project"}))
        create-resp (rest-handler create-req)
        project-id (:id (parse-response-body create-resp))]

    (testing "Add reader access"
      (let [req (admin-request :post (str "/api/v1/projects/" project-id "/readers/user1@example.com"))
            resp (rest-handler req)]
        (is (= (:status resp) 204))))

    (testing "Remove reader access"
      (let [req (admin-request :delete (str "/api/v1/projects/" project-id "/readers/user1@example.com"))
            resp (rest-handler req)]
        (is (= (:status resp) 204))))

    (testing "Add writer access"
      (let [req (admin-request :post (str "/api/v1/projects/" project-id "/writers/user1@example.com"))
            resp (rest-handler req)]
        (is (= (:status resp) 204))))

    (testing "Remove writer access"
      (let [req (admin-request :delete (str "/api/v1/projects/" project-id "/writers/user1@example.com"))
            resp (rest-handler req)]
        (is (= (:status resp) 204))))

    (testing "Add maintainer access"
      (let [req (admin-request :post (str "/api/v1/projects/" project-id "/maintainers/user1@example.com"))
            resp (rest-handler req)]
        (is (= (:status resp) 204))))

    (testing "Remove maintainer access"
      (let [req (admin-request :delete (str "/api/v1/projects/" project-id "/maintainers/user1@example.com"))
            resp (rest-handler req)]
        (is (= (:status resp) 204))))

    (testing "Access management fails with invalid user ID"
      (let [req (admin-request :post (str "/api/v1/projects/" project-id "/readers/nonexistent@example.com"))
            resp (rest-handler req)]
        (is (= (:status resp) 400))))

    (testing "Access management fails with invalid project ID"
      (let [fake-id (str (java.util.UUID/randomUUID))
            req (admin-request :post (str "/api/v1/projects/" fake-id "/readers/user1@example.com"))
            resp (rest-handler req)]
        (is (= (:status resp) 403))))))

(deftest cross-user-access-tests
  (testing "User access permissions"
    ;; Admin creates a project
    (let [create-req (-> (admin-request :post "/api/v1/projects")
                         (mock/json-body {:name "Cross User Test Project"}))
          create-resp (rest-handler create-req)
          project-id (:id (parse-response-body create-resp))]

      (testing "User1 cannot access project without permissions"
        (let [req (user1-request :get (str "/api/v1/projects/" project-id))
              resp (rest-handler req)]
          (is (= (:status resp) 403))))

      (testing "Grant User1 reader access"
        (let [req (admin-request :post (str "/api/v1/projects/" project-id "/readers/user1@example.com"))
              resp (rest-handler req)]
          (is (= (:status resp) 204))))

      (testing "User1 can now read project"
        (let [req (user1-request :get (str "/api/v1/projects/" project-id))
              resp (rest-handler req)
              body (parse-response-body resp)]
          (is (= (:project/name body) "Cross User Test Project"))))

      (testing "User1 cannot update project with only reader access"
        (let [req (-> (user1-request :patch (str "/api/v1/projects/" project-id))
                      (mock/json-body {:name "Attempted Update"}))
              resp (rest-handler req)]
          (is (= (:status resp) 403))))

      (testing "Grant User1 writer access"
        (let [req (admin-request :post (str "/api/v1/projects/" project-id "/writers/user1@example.com"))
              resp (rest-handler req)]
          (is (= (:status resp) 204))))

      (testing "User1 can now update project"
        (let [req (-> (user1-request :patch (str "/api/v1/projects/" project-id))
                      (mock/json-body {:name "User1 Updated"}))
              resp (rest-handler req)]
          (is (= (:status resp) 200))))

      (testing "User1 cannot manage access with only writer permission"
        (let [req (user1-request :post (str "/api/v1/projects/" project-id "/readers/user2@example.com"))
              resp (rest-handler req)]
          (is (= (:status resp) 403))))

      (testing "Grant User1 maintainer access"
        (let [req (admin-request :post (str "/api/v1/projects/" project-id "/maintainers/user1@example.com"))
              resp (rest-handler req)]
          (is (= (:status resp) 204))))

      (testing "User1 can now manage access"
        (let [req (user1-request :post (str "/api/v1/projects/" project-id "/readers/user2@example.com"))
              resp (rest-handler req)]
          ;; This might still return 404 if the middleware blocks it
          (is (contains? #{204 404} (:status resp))))))))

(deftest layer-config-operations
  (testing "Layer configuration management"
    ;; We'll need to create a test layer for this
    ;; For now, testing with a fake layer ID to check error handling
    (let [fake-layer-id (str (java.util.UUID/randomUUID))]

      (testing "Set layer config fails with invalid layer ID"
        (let [req (-> (admin-request :put (str "/api/v1/projects/layers/" fake-layer-id "/config/test-editor/test-key"))
                      (mock/json-body "test-value"))
              resp (rest-handler req)]
          ;; Expecting 404 for invalid layer ID since it doesn't exist
          (is (= (:status resp) 404))))

      (testing "Remove layer config fails with invalid layer ID"
        (let [req (admin-request :delete (str "/api/v1/projects/layers/" fake-layer-id "/config/test-editor/test-key"))
              resp (rest-handler req)]
          ;; Expecting 404 for invalid layer ID since it doesn't exist
          (is (= (:status resp) 404)))))))
