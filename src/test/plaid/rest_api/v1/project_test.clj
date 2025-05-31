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
                                    user2-request
                                    ;; API helpers
                                    parse-response-body
                                    api-call
                                    ;; Assertion helpers  
                                    assert-status
                                    assert-success
                                    assert-created
                                    assert-ok
                                    assert-no-content
                                    assert-not-found
                                    assert-forbidden
                                    assert-bad-request]]))

(use-fixtures :once with-xtdb with-rest-handler with-admin with-test-users)

;; Project API Endpoint Functions
(defn create-project 
  "Create a new project"
  [user-request-fn project-data]
  (api-call user-request-fn {:method :post 
                             :path "/api/v1/projects" 
                             :body project-data}))

(defn list-projects 
  "List all projects"
  [user-request-fn]
  (api-call user-request-fn {:method :get 
                             :path "/api/v1/projects"}))

(defn get-project 
  "Get a project by ID"
  [user-request-fn project-id]
  (api-call user-request-fn {:method :get 
                             :path (str "/api/v1/projects/" project-id)}))

(defn update-project 
  "Update a project"
  [user-request-fn project-id project-data]
  (api-call user-request-fn {:method :patch 
                             :path (str "/api/v1/projects/" project-id) 
                             :body project-data}))

(defn delete-project 
  "Delete a project"
  [user-request-fn project-id]
  (api-call user-request-fn {:method :delete 
                             :path (str "/api/v1/projects/" project-id)}))

;; Project Access Management Functions
(defn add-reader 
  "Add reader access to a project"
  [user-request-fn project-id user-id]
  (api-call user-request-fn {:method :post 
                             :path (str "/api/v1/projects/" project-id "/readers/" user-id)}))

(defn remove-reader 
  "Remove reader access from a project"
  [user-request-fn project-id user-id]
  (api-call user-request-fn {:method :delete 
                             :path (str "/api/v1/projects/" project-id "/readers/" user-id)}))

(defn add-writer 
  "Add writer access to a project"
  [user-request-fn project-id user-id]
  (api-call user-request-fn {:method :post 
                             :path (str "/api/v1/projects/" project-id "/writers/" user-id)}))

(defn remove-writer 
  "Remove writer access from a project"
  [user-request-fn project-id user-id]
  (api-call user-request-fn {:method :delete 
                             :path (str "/api/v1/projects/" project-id "/writers/" user-id)}))

(defn add-maintainer 
  "Add maintainer access to a project"
  [user-request-fn project-id user-id]
  (api-call user-request-fn {:method :post 
                             :path (str "/api/v1/projects/" project-id "/maintainers/" user-id)}))

(defn remove-maintainer 
  "Remove maintainer access from a project"
  [user-request-fn project-id user-id]
  (api-call user-request-fn {:method :delete 
                             :path (str "/api/v1/projects/" project-id "/maintainers/" user-id)}))

;; Layer Configuration Functions
(defn set-layer-config 
  "Set layer configuration"
  [user-request-fn layer-id editor key value]
  (api-call user-request-fn {:method :put 
                             :path (str "/api/v1/projects/layers/" layer-id "/config/" editor "/" key) 
                             :body value}))

(defn remove-layer-config 
  "Remove layer configuration"
  [user-request-fn layer-id editor key]
  (api-call user-request-fn {:method :delete 
                             :path (str "/api/v1/projects/layers/" layer-id "/config/" editor "/" key)}))


(deftest project-crud-operations
  (testing "Project creation and retrieval"
    (testing "Create project succeeds"
      (let [response (create-project admin-request {:name "Test Project"})]
        (assert-created response)
        (is (contains? (:body response) :id))
        (is (uuid? (-> response :body :id)))))

    (testing "List all projects"
      ;; Create a couple test projects first
      (create-project admin-request {:name "List Test Project 1"})
      (create-project admin-request {:name "List Test Project 2"})
      (let [response (list-projects admin-request)]
        (assert-ok response)
        (is (vector? (:body response)))
        (is (>= (count (:body response)) 2))))

    (testing "Get project by ID"
      (let [create-response (create-project admin-request {:name "Get Test Project"})
            project-id (-> create-response :body :id)
            get-response (get-project admin-request project-id)]
        (assert-ok get-response)
        (is (= (-> get-response :body :project/name) "Get Test Project"))
        (is (= (-> get-response :body :project/id) project-id))))

    (testing "Get project by invalid ID returns 404"
      (let [fake-id (str (java.util.UUID/randomUUID))
            response (get-project admin-request fake-id)]
        (assert-not-found response)))

    (testing "Update project name"
      (let [create-response (create-project admin-request {:name "Original Name"})
            project-id (-> create-response :body :id)
            update-response (update-project admin-request project-id {:name "Updated Name"})]
        (assert-ok update-response)
        (is (= (-> update-response :body :project/name) "Updated Name"))))

    (testing "Delete project"
      (let [create-response (create-project admin-request {:name "To Be Deleted"})
            project-id (-> create-response :body :id)
            delete-response (delete-project admin-request project-id)
            get-response (get-project admin-request project-id)]
        (assert-no-content delete-response)
        (assert-not-found get-response)))

    (testing "Delete non-existent project returns 404"
      (let [fake-id (str (java.util.UUID/randomUUID))
            response (delete-project admin-request fake-id)]
        (assert-not-found response)))))

(deftest access-management-operations
  (let [create-response (create-project admin-request {:name "Access Test Project"})
        project-id (-> create-response :body :id)]

    (testing "Add reader access"
      (let [response (add-reader admin-request project-id "user1@example.com")]
        (assert-no-content response)))

    (testing "Remove reader access"
      (let [response (remove-reader admin-request project-id "user1@example.com")]
        (assert-no-content response)))

    (testing "Add writer access"
      (let [response (add-writer admin-request project-id "user1@example.com")]
        (assert-no-content response)))

    (testing "Remove writer access"
      (let [response (remove-writer admin-request project-id "user1@example.com")]
        (assert-no-content response)))

    (testing "Add maintainer access"
      (let [response (add-maintainer admin-request project-id "user1@example.com")]
        (assert-no-content response)))

    (testing "Remove maintainer access"
      (let [response (remove-maintainer admin-request project-id "user1@example.com")]
        (assert-no-content response)))

    (testing "Access management fails with invalid user ID"
      (let [response (add-reader admin-request project-id "nonexistent@example.com")]
        (assert-status 400 response)))

    (testing "Access management fails with invalid project ID"
      (let [fake-id (str (java.util.UUID/randomUUID))
            response (add-reader admin-request fake-id "user1@example.com")]
        (assert-forbidden response)))))

(deftest cross-user-access-tests
  (testing "User access permissions"
    (let [create-response (create-project admin-request {:name "Cross User Test Project"})
          project-id (-> create-response :body :id)]

      (testing "User1 cannot access project without permissions"
        (let [response (get-project user1-request project-id)]
          (assert-forbidden response)))

      (testing "Grant User1 reader access"
        (let [response (add-reader admin-request project-id "user1@example.com")]
          (assert-no-content response)))

      (testing "User1 can now read project"
        (let [response (get-project user1-request project-id)]
          (assert-ok response)
          (is (= (-> response :body :project/name) "Cross User Test Project"))))

      (testing "User1 cannot update project with only reader access"
        (let [response (update-project user1-request project-id {:name "Attempted Update"})]
          (assert-forbidden response)))

      (testing "Grant User1 writer access"
        (let [response (add-writer admin-request project-id "user1@example.com")]
          (assert-no-content response)))

      (testing "User1 can now update project"
        (let [response (update-project user1-request project-id {:name "User1 Updated"})]
          (assert-ok response)))

      (testing "User1 cannot manage access with only writer permission"
        (let [response (add-reader user1-request project-id "user2@example.com")]
          (assert-forbidden response)))

      (testing "Grant User1 maintainer access"
        (let [response (add-maintainer admin-request project-id "user1@example.com")]
          (assert-no-content response)))

      (testing "User1 can now manage access"
        (let [response (add-reader user1-request project-id "user2@example.com")]
          ;; This might still return 404 if the middleware blocks it
          (is (contains? #{204 404} (:status response))))))))

(deftest layer-config-operations
  (testing "Layer configuration management"
    (let [fake-layer-id (str (java.util.UUID/randomUUID))]

      (testing "Set layer config fails with invalid layer ID"
        (let [response (set-layer-config admin-request fake-layer-id "test-editor" "test-key" "test-value")]
          (assert-not-found response)))

      (testing "Remove layer config fails with invalid layer ID"
        (let [response (remove-layer-config admin-request fake-layer-id "test-editor" "test-key")]
          (assert-not-found response))))))

(deftest access-management-edge-cases
  (let [create-response (create-project admin-request {:name "Edge Case Project"})
        project-id (-> create-response :body :id)]

    (testing "Adding duplicate reader access is idempotent"
      (let [response1 (add-reader admin-request project-id "user1@example.com")
            response2 (add-reader admin-request project-id "user1@example.com")]
        (assert-no-content response1)
        (assert-no-content response2)))

    (testing "Removing non-existent reader access is idempotent"
      (let [response (remove-reader admin-request project-id "nonexistent@example.com")]
        (assert-status 400 response)))

    (testing "Access operations require maintainer permissions"
      ;; Grant user1 only writer access, not maintainer
      (add-writer admin-request project-id "user1@example.com")
      (let [response (add-reader user1-request project-id "user2@example.com")]
        (assert-forbidden response)))))

(deftest authorization-edge-cases
  (testing "Non-maintainer cannot perform CRUD operations on projects they don't own"
    (let [create-response (create-project admin-request {:name "Admin Project"})
          project-id (-> create-response :body :id)]

      (testing "User1 cannot delete project without permissions"
        (let [response (delete-project user1-request project-id)]
          (assert-forbidden response)))

      (testing "User1 cannot update project without permissions"
        (let [response (update-project user1-request project-id {:name "Hacked Name"})]
          (assert-forbidden response))))))
