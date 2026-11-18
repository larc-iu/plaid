(ns plaid.rest-api.v1.invite-unknown-id-test
  "An invite route tells nobody but an admin whether a project or invite id
  is real (ACL5-1, invite part of ACL10-4): a non-admin minting for a
  project they do not maintain, or revoking an invite not theirs, gets one
  403 whether or not the id exists. An admin hears 404 for an unknown one."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-test-users with-clean-db admin-request user1-request
                                    user2-request api-call assert-status]]
            [plaid.test-helpers :refer [create-test-project]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- same-but-id? [a b real unknown]
  (and (= (:status a) (:status b))
       (= (str/replace (str (dissoc (:body a) :unresolved)) (str real) "ID")
          (str/replace (str (dissoc (:body b) :unresolved)) (str unknown) "ID"))))

(deftest a-stranger-learns-nothing-from-an-invite-route
  (let [p (create-test-project user2-request "P")
        _ (create-test-project user1-request "Stranger's own")
        invite (-> (api-call user2-request {:method :post :path "/api/v1/invites"
                                            :body {:project-id p :project-role "reader"}})
                   :body :id)
        unknown-project (random-uuid)
        unknown-invite "01a03f68-0000-7000-8000-000000000000"]
    (is (some? invite))
    (testing "minting for a project the caller does not maintain"
      (let [mint #(api-call user1-request {:method :post :path "/api/v1/invites"
                                           :body {:project-id % :project-role "reader"}})
            a (mint p) b (mint unknown-project)]
        (assert-status 403 a)
        (is (same-but-id? a b p unknown-project) (pr-str a b))))
    (testing "revoking an invite of another person"
      (let [revoke #(api-call user1-request {:method :delete :path (str "/api/v1/invites/" %)})
            a (revoke invite) b (revoke unknown-invite)]
        (assert-status 403 a)
        (is (same-but-id? a b invite unknown-invite) (pr-str a b))
        (is (true? (-> b :body :unresolved)))))
    (testing "an admin hears 404 for unknown ids"
      (assert-status 404 (api-call admin-request {:method :post :path "/api/v1/invites"
                                                  :body {:project-id unknown-project :project-role "reader"}}))
      (assert-status 404 (api-call admin-request {:method :delete :path (str "/api/v1/invites/" unknown-invite)})))))
