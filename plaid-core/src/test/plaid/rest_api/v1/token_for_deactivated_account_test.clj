(ns plaid.rest-api.v1.token-for-deactivated-account-test
  "A named API token is not minted for a deactivated account: its tokens
  were revoked at deactivation and reactivation restores none, so one
  minted while it is deactivated came alive on reactivation (ACL6-3)."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-test-users with-clean-db admin-request api-call assert-status]]
            [plaid.rest-api.v1.job-helpers :as jh]
            [plaid.sql.common :as psc]
            [plaid.fixtures :as fix]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(deftest no-token-is-minted-for-a-deactivated-account
  (jh/user! "u@example.com")
  (assert-status 204 (api-call admin-request {:method :delete :path "/api/v1/users/u@example.com"}))
  (let [r (api-call admin-request {:method :post :path "/api/v1/users/u@example.com/tokens" :body {:name "script"}})]
    (assert-status 400 r)
    (is (nil? (-> r :body :token))))
  (is (empty? (psc/q fix/db {:select [:id] :from [:api_tokens] :where [:= :user_id "u@example.com"]})))
  (testing "after reactivation a token is minted as usual"
    (assert-status 200 (api-call admin-request {:method :post :path "/api/v1/users/u@example.com/activate"}))
    (is (string? (-> (api-call admin-request {:method :post :path "/api/v1/users/u@example.com/tokens"
                                              :body {:name "script"}})
                     :body :token)))))
