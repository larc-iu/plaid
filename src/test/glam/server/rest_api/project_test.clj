(ns glam.server.rest-api.project-test
  (:require [clojure.test :refer :all]
            [clojure.string]
            [ring.mock.request :as mock]
            [glam.xtdb.easy :as gxe]
            [glam.server.rest-api.fixtures :refer [with-user-cookies
                                                   admin-req user-req
                                                   admin-id user-id
                                                   project-ids with-project-and-doc]]
            [glam.fixtures :refer [xtdb-node
                                   with-xtdb
                                   with-parser
                                   with-rest-handler
                                   rest-handler]]))

;; Get a fresh system set up for each test that only has two registered users
(use-fixtures :each with-xtdb with-parser with-rest-handler with-user-cookies with-project-and-doc)

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
        (is (= 403 status))))

    (testing "Admin can see all projects"
      (let [{:keys [status body]} (rest-handler (admin-req :get "/rest-api/v1/projects"))
            body (read-string (slurp body))]
        ;; 2 because of the fixture
        (is (= 2 (count body))))
      (let [{:keys [status body]} (rest-handler (-> (admin-req :get (str "/rest-api/v1/project/" @prj-id))
                                                    (mock/query-string {:includeDocuments false})))]
        (is (= 200 status))))

    (testing "User sees no projects by default"
      (let [{:keys [status body]} (rest-handler (user-req :get "/rest-api/v1/projects"))
            body (read-string (slurp body))]
        (is (= 0 (count body))))
      (let [{:keys [status body] :as resp} (rest-handler (-> (user-req :get (str "/rest-api/v1/project/" @prj-id))
                                                             (mock/query-string {:includeDocuments false})))]
        (is (= 404 status))))

    (testing "User can see a project after being granted read access"
      (let [{:keys [status]} (rest-handler (-> (admin-req :patch (str "/rest-api/v1/admin/layers/project/" @prj-id))
                                               (mock/json-body {:action "setPrivileges"
                                                                :userId user-id
                                                                :privileges "reader"})))]
        (is (= 200 status)))
      (let [{:keys [status body]} (rest-handler (user-req :get "/rest-api/v1/projects"))
            body (read-string (slurp body))]
        (is (= 200 status))
        (is (= 1 (count body))))
      (let [{:keys [status body]} (rest-handler (-> (user-req :get (str "/rest-api/v1/project/" @prj-id))
                                                    (mock/query-string {:includeDocuments false})))]
        (is (= 200 status))))

    (testing "User cannot delete projects"
      (let [{:keys [status body]} (rest-handler (user-req :delete (str "/rest-api/v1/admin/layers/project/" @prj-id)))]
        (is (= 403 status))))

    (testing "Admin can delete projects"
      (let [{:keys [status body]} (rest-handler (admin-req :delete (str "/rest-api/v1/admin/layers/project/" @prj-id)))]
        (is (= 200 status)))
      (let [{:keys [status body]} (rest-handler (admin-req :get "/rest-api/v1/projects"))
            body (read-string (slurp body))]
        ;; 1 because of the fixture
        (is (= 1 (count body))))
      (let [{:keys [status body]} (rest-handler (-> (admin-req :get (str "/rest-api/v1/project/" @prj-id))
                                                    (mock/query-string {:includeDocuments false})))]
        (is (= 404 status))))))

(deftest project-deletion
  (testing "Deleting a project deletes *everything*!"
    (let [url (str "/rest-api/v1/admin/layers/project/" (:project-id project-ids))
          {:keys [status]} (rest-handler (admin-req :delete url))
          db-entities (gxe/find-entities xtdb-node [[:xt/id '_]])]
      (is (= 200 status))
      (is (= (:before-db-count project-ids) (count db-entities))))))