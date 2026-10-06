(ns plaid.rest-api.v1.operation-credential-test
  "Every operation records what kind of credential made it (`operations.credential`):
  a session from signing in, a named API token, a named token holding a
  service connection, or a delegated token. Set by the server from the
  validated token, so a script run on a person's named token can be told
  from that person's own edits in the browser. The audit read returns it on
  the entry and on each operation."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [mount.core :as mount]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db
                                            with-rest-handler with-admin with-test-users
                                            api-call admin-request user1-request]]
            [plaid.rest-api.v1.auth :as auth]
            [plaid.server.events :as events]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :as h]
            [ring.mock.request :as mock]))

(defn- with-rpc-state-started [f]
  (mount/start #'plaid.server.events/service-channels
               #'plaid.server.events/inflight-requests)
  (f))

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

(defn- credential-of [name]
  (:credential (psc/q1 fix/db {:select [:o.credential]
                               :from [[:operations :o]]
                               :join [[:documents :d] [:= :d.id :o.document_id]]
                               :where [:and [:= :d.name name] [:= :o.op_type "document/create"]]})))

(defn- entry-of [p name]
  (->> (:entries (:body (h/get-project-audit admin-request p)))
       (filter #(= name (-> % :audit/documents first :document/name)))
       first))

(deftest each-credential-is-recorded-on-its-operations
  (events/reset-state!)
  (let [p (h/create-test-project admin-request "Cred P")
        _ (api-call admin-request {:method :post :path (str "/api/v1/projects/" p "/writers/user1@example.com")})
        named (auth/issue-api-token! fix/db "fake-secret" "user1@example.com" "pipeline" "user1@example.com")
        svc (auth/issue-api-token! fix/db "fake-secret" "user1@example.com" "my service" "user1@example.com")
        delegated (auth/issue-delegated-token! fix/db "fake-secret" "user1@example.com" [p])]
    (events/register-service-channel! (parse-uuid (str p)) "svc" (Object.)
                                      {:service-name "S" :db fix/db :token-id (:id svc)}
                                      "user1@example.com")
    (is (= 201 (:status (create-doc! user1-request p "by login"))))
    (is (= 201 (:status (create-doc! (as (:token named)) p "by script"))))
    (is (= 201 (:status (create-doc! (as (:token svc)) p "by service"))))
    (is (= 201 (:status (create-doc! (as delegated) p "by delegation"))))
    (testing "the operations row says which kind of credential made it"
      (is (= "login" (credential-of "by login")))
      (is (= "named-token" (credential-of "by script")))
      (is (= "service" (credential-of "by service")))
      (is (= "delegated" (credential-of "by delegation"))))
    (testing "all four are the same person"
      (is (= #{"user1@example.com"}
             (set (map :user_id (psc/q fix/db {:select [:user_id] :from [:operations]
                                               :where [:= :op_type "document/create"]}))))))
    (testing "the audit read returns it on the entry and on each op, beside the token's name"
      (let [e (entry-of p "by script")]
        (is (= "named-token" (:audit/credential e)))
        (is (= "named-token" (-> e :audit/ops first :op/credential)))
        (is (= "pipeline" (-> e :audit/api-token :token/name))))
      (let [e (entry-of p "by login")]
        (is (= "login" (:audit/credential e)))
        (is (nil? (:audit/api-token e))))
      (is (= "service" (:audit/credential (entry-of p "by service"))))
      (is (= "delegated" (:audit/credential (entry-of p "by delegation")))))
    (testing "the token itself is stored nowhere in the log"
      (is (empty? (psc/q fix/db {:select [:id] :from [:operations]
                                 :where [:or [:like :credential (str "%" (:token named) "%")]
                                         [:like :token_id (str "%" (:token named) "%")]]}))))
    (testing "once the service's connection is gone, its token writes as a named token"
      (events/reset-state!)
      (is (= 201 (:status (create-doc! (as (:token svc)) p "after the service left"))))
      (is (= "named-token" (credential-of "after the service left"))))))

(deftest batched-writes-carry-their-credential
  (let [named (auth/issue-api-token! fix/db "fake-secret" "user1@example.com" "batchbot" "user1@example.com")
        resp (fix/rest-handler (-> (mock/request :post "/api/v1/batch")
                                   (mock/header "accept" "application/edn")
                                   (mock/json-body [{:path "/api/v1/projects" :method "post" :body {:name "B1"}}
                                                    {:path "/api/v1/projects" :method "post" :body {:name "B2"}}])
                                   (mock/header "authorization" (str "Bearer " (:token named)))))
        rows (psc/q fix/db {:select [:credential :token_id] :from [:operations]
                            :where [:and [:= :op_type "project/create"] [:not= :batch_id nil]]})]
    (is (= 200 (:status resp)))
    (is (= 2 (count rows)))
    (is (every? #(= "named-token" (:credential %)) rows))
    (is (every? #(= (:id named) (:token_id %)) rows))))
