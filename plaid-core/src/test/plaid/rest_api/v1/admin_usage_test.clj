(ns plaid.rest-api.v1.admin-usage-test
  "Usage facts the admin area reads: how much of a person's activity a job
  or a service wrote for them, one person's tally, when a named API token
  last wrote, and how much private data each account holds."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db
                                            with-rest-handler with-admin with-test-users
                                            api-call admin-request user1-request]]
            [plaid.rest-api.v1.auth :as auth]
            [plaid.sql.common :as psc]
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

;; The user page asks for one person's row, not every person's.
(deftest the-tally-answers-one-person
  (let [p (h/create-test-project admin-request "Usage One")
        _ (api-call admin-request {:method :post :path (str "/api/v1/projects/" p "/writers/user1@example.com")})]
    (is (= 201 (:status (create-doc! user1-request p "theirs"))))
    (doseq [[label scope] [["instance" nil] ["project" p]]]
      (testing label
        (let [all (:entries (:body (h/get-audit-tally admin-request scope)))
              one (:entries (:body (h/get-audit-tally admin-request scope {:user-id "user1@example.com"})))]
          (is (< 1 (count all)))
          (is (= [(row-of all "user1@example.com")] one)))))
    (testing "a person with nothing in the scope has no row"
      (is (= [] (:entries (:body (h/get-audit-tally admin-request p {:user-id "user2@example.com"}))))))
    (testing "it is still the admin's alone across every project"
      (is (= 403 (:status (h/get-audit-tally user1-request nil {:user-id "user1@example.com"})))))))

;; When each named token last wrote: the newest operation carrying its id.
(deftest a-token-says-when-it-last-wrote
  (let [p (h/create-test-project admin-request "Usage Tokens")
        _ (api-call admin-request {:method :post :path (str "/api/v1/projects/" p "/writers/user1@example.com")})
        used (auth/issue-api-token! fix/db "fake-secret" "user1@example.com" "used" "user1@example.com")
        idle (auth/issue-api-token! fix/db "fake-secret" "user1@example.com" "idle" "user1@example.com")
        _ (is (= 201 (:status (create-doc! (as (:token used)) p "first"))))
        _ (Thread/sleep 5)
        _ (is (= 201 (:status (create-doc! (as (:token used)) p "second"))))
        _ (is (= 201 (:status (create-doc! user1-request p "by login"))))
        newest (:ts (psc/q1 fix/db {:select [[[:max :ts] :ts]] :from [:operations]
                                    :where [:= :token_id (:id used)]}))
        listed (:entries (:body (api-call admin-request {:method :get :path "/api/v1/users/user1@example.com/tokens"})))
        by-name (into {} (map (juxt :api-token/name identity)) listed)]
    (is (some? newest))
    (is (= newest (:api-token/last-write-at (by-name "used"))))
    (testing "a token that never wrote has no time"
      (is (contains? by-name "idle"))
      (is (nil? (:api-token/last-write-at (by-name "idle")))))))

;; How much private data each account holds, in bytes of its stored JSON.
(deftest private-data-is-summed-by-user
  (let [put! (fn [who user k v]
               (api-call who {:method :put :path (str "/api/v1/users/" user "/data/" k) :body v}))
        stored (fn [user] (:n (psc/q1 fix/db {:select [[[:sum [:octet_length :value]] :n]]
                                              :from [:user_data] :where [:= :user_id user]})))]
    (is (= 200 (:status (put! user1-request "user1@example.com" "igt:a" {:title "ə ŋ"}))))
    (is (= 200 (:status (put! user1-request "user1@example.com" "igt:b" [1 2 3]))))
    (let [resp (api-call admin-request {:method :get :path "/api/v1/admin/user-data/sizes"})
          rows (:entries (:body resp))
          mine (first (filter #(= "user1@example.com" (:user-id %)) rows))]
      (is (= 200 (:status resp)))
      (is (= {:user-id "user1@example.com" :entries 2 :bytes (stored "user1@example.com")} mine))
      (is (< (:n (psc/q1 fix/db {:select [[[:sum [:length :value]] :n]] :from [:user_data]
                                 :where [:= :user_id "user1@example.com"]}))
             (:bytes mine))
          "bytes, not characters: ə and ŋ are two each")
      (is (not-any? #(= "user2@example.com" (:user-id %)) rows) "an account with none has no row"))
    (testing "an admin's alone"
      (is (= 403 (:status (api-call user1-request {:method :get :path "/api/v1/admin/user-data/sizes"})))))))
