(ns plaid.rest-api.v1.entry-changes-admin-test
  "An admin asking what an account's audit entry changed row by row gets
  the empty list such an entry has, not a refusal saying they lack
  privileges (ACL6-6). Anyone else still gets the 403."
  (:require [clojure.test :refer [deftest is use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-test-users with-clean-db admin-request user1-request
                                    api-call assert-status]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(deftest an-accounts-entry-has-no-rows-for-an-admin
  (assert-status 200 (api-call admin-request {:method :patch :path "/api/v1/users/user1@example.com"
                                              :body {:display-name "Renamed"}}))
  (let [entry (-> (api-call admin-request {:method :get :path "/api/v1/audit?order=desc&limit=1"})
                  :body :entries first :audit/id)
        r (api-call admin-request {:method :get :path (str "/api/v1/audit/entries/" entry "/changes")})]
    (assert-status 200 r)
    (is (empty? (-> r :body :entries)))
    (assert-status 403 (api-call user1-request {:method :get :path (str "/api/v1/audit/entries/" entry "/changes")}))))
