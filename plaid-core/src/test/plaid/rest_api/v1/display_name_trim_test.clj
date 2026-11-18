(ns plaid.rest-api.v1.display-name-trim-test
  "A display name is stored trimmed when it is changed, as when the account
  is made, so the same typed name is one stored name (ACL6-5)."
  (:require [clojure.test :refer [deftest is use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-test-users with-clean-db admin-request user1-request
                                    api-call assert-status]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(deftest a-changed-display-name-is-trimmed
  (assert-status 201 (api-call admin-request {:method :post :path "/api/v1/users"
                                              :body {:email "ana@example.com" :password "password-ana-1"
                                                     :is-admin false :display-name "  Ana  "}}))
  (assert-status 200 (api-call user1-request {:method :patch :path "/api/v1/users/user1@example.com"
                                              :body {:display-name "  Ana  "}}))
  (is (= "Ana" (-> (api-call admin-request {:method :get :path "/api/v1/users/ana@example.com"}) :body :user/display-name)))
  (is (= "Ana" (-> (api-call admin-request {:method :get :path "/api/v1/users/user1@example.com"}) :body :user/display-name))))
