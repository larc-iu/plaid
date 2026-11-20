(ns plaid.rest-api.v1.admin-usage-test
  "Usage facts the admin area reads: how much of a person's activity a job
  or a service wrote for them, one person's tally, when a named API token
  last wrote, and how much private data each account holds."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db
                                            with-rest-handler with-admin with-test-users
                                            api-call admin-request user1-request]]
            [plaid.rest-api.v1.auth :as auth]
            [plaid.test-helpers :as h :refer [with-rpc-state-started]]
            [ring.mock.request :as mock]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users
  with-rpc-state-started)
(use-fixtures :each with-clean-db)

(defn- as [token]
  (fn [method path]
    (-> (mock/request method path)
        (mock/header "accept" "application/edn")
        (mock/header "Authorization" (str "Bearer " token)))))

(defn- create-doc! [who p name]
  (api-call who {:method :post :path "/api/v1/documents" :body {:project-id p :name name}}))

(defn- row-of [rows user-id]
  (first (filter #(= user-id (:user/id (:user %))) rows)))

;; A job's token and a service's token for its requester are both delegated
;; (`credential` "delegated"). A person's own script on a named token is
;; their own work, as is the browser.
(deftest the-tally-counts-delegated-changes-apart
  (let [p (h/create-test-project admin-request "Usage P")
        _ (api-call admin-request {:method :post :path (str "/api/v1/projects/" p "/writers/user1@example.com")})
        named (auth/issue-api-token! fix/db "fake-secret" "user1@example.com" "pipeline" "user1@example.com")
        delegated (auth/issue-delegated-token! fix/db "fake-secret" "user1@example.com" [p])]
    (is (= 201 (:status (create-doc! user1-request p "by login"))))
    (is (= 201 (:status (create-doc! (as (:token named)) p "by script"))))
    (is (= 201 (:status (create-doc! (as delegated) p "by delegation one"))))
    (is (= 201 (:status (create-doc! (as delegated) p "by delegation two"))))
    (doseq [[label scope] [["instance" nil] ["project" p]]]
      (testing label
        (let [rows (:entries (:body (h/get-audit-tally admin-request scope)))
              mine (row-of rows "user1@example.com")
              admin (row-of rows "admin@example.com")]
          ;; The instance scope also holds the account's own setup.
          (is ((if scope = <=) 4 (:changes mine)) "changes stays the total")
          (is (= 2 (:delegated-changes mine)))
          (is (= 0 (:delegated-changes admin))))))))
