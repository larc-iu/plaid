(ns plaid.rest-api.v1.deactivation-in-project-history-test
  "Deactivating an account removes it from every project, and each
  project's History says so, as it says a maintainer's removal of a member
  (ACL6-1). Before, the removal was written under the deactivation, which
  names no project, so a project's maintainer saw the member vanish with no
  entry."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-test-users with-clean-db admin-request user1-request
                                    api-call assert-status]]
            [plaid.rest-api.v1.job-helpers :as jh]
            [plaid.test-helpers :refer [create-test-project get-project-audit]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- role! [method project role email]
  (assert-status 204 (api-call admin-request {:method method
                                              :path (str "/api/v1/projects/" project "/" role "/" email)})))

(defn- ops [who project]
  (mapcat :audit/ops (:entries (:body (get-project-audit who project)))))

(deftest a-deactivation-is-in-the-history-of-every-project-the-account-left
  (let [p (create-test-project admin-request "P")
        q (create-test-project admin-request "Q")]
    (jh/user! "x@example.com")
    (jh/user! "y@example.com")
    (role! :post p "maintainers" "user1@example.com")
    (role! :post q "maintainers" "user1@example.com")
    (role! :post p "writers" "x@example.com")
    (role! :post p "writers" "y@example.com")
    (role! :post q "maintainers" "x@example.com")
    (role! :delete p "writers" "y@example.com")
    (assert-status 204 (api-call admin-request {:method :delete :path "/api/v1/users/x@example.com"}))
    (testing "x is gone from both projects"
      (let [pr (:body (api-call user1-request {:method :get :path (str "/api/v1/projects/" p)}))]
        (is (not (some #{"x@example.com"} (:project/writers pr))))))
    (testing "P's History, read by its maintainer, names x's removal as it names y's"
      (let [removals (filter #(= :project/remove-writer (:op/type %)) (ops user1-request p))]
        (is (some #(str/includes? (:op/description %) "y@example.com") removals))
        (is (some #(str/includes? (:op/description %) "x@example.com") removals))))
    (testing "Q's History names x's removal as a maintainer"
      (is (some #(and (= :project/remove-maintainer (:op/type %))
                      (str/includes? (:op/description %) "x@example.com"))
                (ops user1-request q))))
    (testing "the account's own deactivation is still in the instance log"
      (is (some #(= :user/deactivate (:op/type %))
                (mapcat :audit/ops (:entries (:body (api-call admin-request {:method :get :path "/api/v1/audit"}))))))
      (is (some? (-> (api-call admin-request {:method :get :path "/api/v1/users/x@example.com"})
                     :body :user/deactivated-at))))))
