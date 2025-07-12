(ns plaid.rest-api.v1.batch-test
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [clojure.string]
            [ring.mock.request :as mock]
            [plaid.fixtures :refer [with-xtdb
                                    with-mount-states
                                    with-rest-handler
                                    rest-handler
                                    with-admin
                                    admin-token
                                    admin-request
                                    parse-response-body]]
            [muuntaja.core :as m]))

(use-fixtures :once with-xtdb with-mount-states with-rest-handler with-admin)

(defn make-batch-request [operations token]
  (let [req (cond-> (mock/request :post "/api/v1/batch")
              true (mock/header "accept" "application/edn")
              true (mock/json-body operations)
              token (mock/header "authorization" (str "Bearer " token)))]
    (rest-handler req)))

(deftest test-batch-operations
  (let [;; Create test project
        create-project-req (-> (admin-request :post "/api/v1/projects")
                               (mock/json-body {:name "Test Project"}))
        project-resp (rest-handler create-project-req)
        project-id (:id (parse-response-body project-resp))]

    (testing "Multiple GET requests"
      (let [operations [{:path "/api/v1/users/admin@example.com" :method "get" :body nil}
                        {:path (str "/api/v1/projects/" project-id) :method "get" :body nil}]
            response (make-batch-request operations admin-token)
            response-body (parse-response-body response)]
        (is (= 200 (:status response)))
        (is (= 2 (count response-body)))
        (is (= 200 (get-in response-body [0 :status])))
        (is (= "admin@example.com" (get-in response-body [0 :body :user/username])))
        (is (= 200 (get-in response-body [1 :status])))
        (is (= "Test Project" (get-in response-body [1 :body :project/name])))))

    (testing "Multiple GET operations"
      (let [operations [{:path (str "/api/v1/projects/" project-id) :method "get" :body nil}
                        {:path "/api/v1/users/admin@example.com" :method "get" :body nil}
                        {:path (str "/api/v1/projects/" project-id) :method "get" :body nil}]
            response (make-batch-request operations admin-token)
            response-body (parse-response-body response)]
        (is (= 200 (:status response)))
        (is (= 3 (count response-body)))
        ;; First op: GET project
        (is (= 200 (get-in response-body [0 :status])))
        (is (= "Test Project" (get-in response-body [0 :body :project/name])))
        ;; Second op: GET user
        (is (= 200 (get-in response-body [1 :status])))
        (is (= "admin@example.com" (get-in response-body [1 :body :user/username])))
        ;; Third op: GET project again
        (is (= 200 (get-in response-body [2 :status])))
        (is (= "Test Project" (get-in response-body [2 :body :project/name])))))

    (testing "Atomic error handling - batch fails on first error"
      (let [operations [{:path "/api/v1/users/admin@example.com" :method "get" :body nil}
                        {:path "/api/v1/users/nonexistent@example.com" :method "get" :body nil}
                        {:path (str "/api/v1/projects/" project-id) :method "get" :body nil}]
            response (make-batch-request operations admin-token)
            response-body (parse-response-body response)]
        ;; With atomic behavior, batch fails immediately on second operation (404)
        ;; and returns just the error response, not an array
        (is (= 404 (:status response)))
        ;; Response body should be the error from the failed operation
        (is (map? response-body)) ; Single error object, not array
        (is (contains? response-body :error))))

    (testing "Empty batch request"
      (let [response (make-batch-request [] admin-token)
            response-body (parse-response-body response)]
        (is (= 200 (:status response)))
        (is (= [] response-body))))

    (testing "Invalid method"
      (let [operations [{:path "/api/v1/users/admin@example.com" :method "invalid" :body nil}]
            response (make-batch-request operations admin-token)]
        (is (= 400 (:status response)))))

    (testing "Unauthenticated request"
      (let [operations [{:path "/api/v1/users/admin@example.com" :method "get" :body nil}]
            response (make-batch-request operations nil)]
        (is (= 403 (:status response)))))))