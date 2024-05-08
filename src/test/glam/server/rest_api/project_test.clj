(ns glam.server.rest-api.project-test
  (:require [clojure.test :refer :all]
            [clojure.string]
            [ring.mock.request :as mock]
            [glam.xtdb.easy :as gxe]
            [glam.server.rest-api.fixtures :refer [with-user-cookies admin-req user-req]]
            [glam.fixtures :refer [xtdb-node
                                   with-xtdb
                                   with-parser
                                   with-rest-handler
                                   rest-handler]]))

;; Get a fresh system set up for each test that only has two registered users
(use-fixtures :each with-xtdb with-parser with-rest-handler with-user-cookies)

(deftest projects-admin
  (let [prj-id (atom nil)]
    (testing "Admin can create projects"
      (let [req (-> (admin-req :post "/rest-api/v1/admin/layers/project")
                    (mock/json-body {:name "test-project"}))
            {:keys [status body]} (rest-handler req)
            body (read-string (slurp body))]
        (is (= 200 status))
        (reset! prj-id (:id body))))

    (testing "Creation respects name body parameter"
      (let [req (-> (admin-req :get (str "/rest-api/v1/admin/layers/project/" @prj-id))
                    (mock/query-string {:includeDocuments false}))
            {:keys [status body]} (rest-handler req)
            body (read-string (slurp body))]
        (is (= 200 status))
        (is (= "test-project" (:project/name body)))))

    (testing "User can not create projects"
      (let [req (-> (user-req :post "/rest-api/v1/admin/layers/project")
                    (mock/json-body {:name "test-project2"}))
            {:keys [status body]} (rest-handler req)
            body (read-string (slurp body))]
        (is (= 403 status))
        (reset! prj-id (:id body))))

    (testing "Admin can see all projects"
      (let [{:keys [status body]} (rest-handler (admin-req :get "/rest-api/v1/projects"))
            body (read-string (slurp body))]
        (is (= 1 (count body)))))

    (testing "User sees no projects by default"
      (let [{:keys [status body]} (rest-handler (user-req :get "/rest-api/v1/projects"))
            body (read-string (slurp body))]
        (is (= 0 (count body)))))))
