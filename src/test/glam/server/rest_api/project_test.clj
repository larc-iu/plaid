(ns glam.server.rest-api.project-test
  (:require [clojure.test :refer :all]
            [clojure.string]
            [ring.mock.request :as mock]
            [glam.xtdb.easy :as gxe]
            [glam.server.rest-api.fixtures :refer [with-user-cookies admin-req user-req]]
            [glam.fixtures :refer [with-xtdb
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
        (is (= "test-project" (:project/name body)))))))
