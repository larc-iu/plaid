(ns plaid.rest-api.v1.email-case-test
  "A user id is an email address, stored and compared trimmed and lowercased
  wherever it enters core: account creation, invites and their redemption,
  login, the login rate limit, member and maintainer grants, user search,
  named tokens, private data, the audit and every other route that names a
  user. Two accounts can never differ only in case."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [ring.mock.request :as mock]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-test-users with-clean-db rest-handler db api-call
                                    admin-request user1-request
                                    assert-ok assert-created assert-no-content assert-status]]
            [plaid.sql.user :as user]
            [plaid.test-helpers :as h]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- anon-request [method path]
  (-> (mock/request method path)
      (mock/header "accept" "application/edn")))

(defn- login [user-id password]
  (api-call anon-request {:method :post :path "/api/v1/login"
                          :body {:user-id user-id :password password}}))

(defn- token-request [token]
  (fn [method path]
    (-> (mock/request method path)
        (mock/header "accept" "application/edn")
        (mock/header "Authorization" (str "Bearer " token)))))

(deftest normalize-id-trims-and-lowercases
  (is (= "b@x.com" (user/normalize-id "  B@X.Com ")))
  (is (= "i@x.com" (user/normalize-id "I@X.COM")) "no locale-dependent dotless i")
  (is (nil? (user/normalize-id nil))))

(deftest account-creation-stores-one-spelling
  (testing "POST /users stores the lowercased, trimmed email"
    (let [resp (api-call admin-request {:method :post :path "/api/v1/users"
                                        :body {:email "  New.Person@Example.COM "
                                               :password "long-enough-1" :is-admin false}})]
      (assert-created resp)
      (is (= "new.person@example.com" (-> resp :body :id)))
      (is (= "new.person" (:user/display-name (user/get db "new.person@example.com"))))))
  (testing "the same address in another case is the same account"
    (let [resp (api-call admin-request {:method :post :path "/api/v1/users"
                                        :body {:email "NEW.PERSON@example.com"
                                               :password "long-enough-1" :is-admin false}})]
      (assert-status 409 resp)))
  (testing "the bootstrap path (first-run prompt and PLAID_ADMIN_EMAIL) lowercases too"
    (let [{:keys [success extra]} (user/create db "Boot@Example.COM" true "long-enough-1" nil)]
      (is success)
      (is (= "boot@example.com" extra))
      (is (some? (user/get db "boot@example.com")))
      (is (false? (:success (user/create db "boot@EXAMPLE.com" true "long-enough-1" nil)))))))

(deftest login-takes-any-case
  (testing "a login typed in another case signs in to the account"
    (let [resp (login " User1@Example.COM" "password1")]
      (assert-ok resp)
      (is (string? (-> resp :body :token)))
      (let [me (api-call (token-request (-> resp :body :token))
                         {:method :get :path "/api/v1/users/user1@example.com"})]
        (assert-ok me)
        (is (= "user1@example.com" (-> me :body :user/id))))))
  (testing "failed logins in different cases count against one bucket"
    (login "Locked@Example.com" "wrong-password")
    (login "LOCKED@example.com" "wrong-password")
    (let [snap (api-call admin-request {:method :get :path "/api/v1/admin/rate-limits"})
          buckets (filter #(= "locked@example.com" (:user-id %)) (-> snap :body :logins))]
      (is (= 1 (count buckets)))
      (is (= 2 (:failures (first buckets))))
      (testing "and clearing it by another case clears it"
        (assert-ok (api-call admin-request {:method :delete
                                            :path (str "/api/v1/admin/rate-limits?ip=" (:ip (first buckets))
                                                       "&user-id=LOCKED@Example.com")}))
        (let [snap (api-call admin-request {:method :get :path "/api/v1/admin/rate-limits"})]
          (is (empty? (filter #(= "locked@example.com" (:user-id %)) (-> snap :body :logins)))))))))

(deftest user-routes-take-any-case
  (testing "GET /users/:id finds the account"
    (let [resp (api-call admin-request {:method :get :path "/api/v1/users/USER1@Example.com"})]
      (assert-ok resp)
      (is (= "user1@example.com" (-> resp :body :user/id)))))
  (testing "a user names themselves in another case and is still themselves"
    (let [resp (api-call user1-request {:method :patch :path "/api/v1/users/User1@EXAMPLE.com"
                                        :body {:display-name "Uno"}})]
      (assert-ok resp)
      (is (= "Uno" (:user/display-name (user/get db "user1@example.com"))))))
  (testing "named tokens"
    (assert-ok (api-call user1-request {:method :get :path "/api/v1/users/USER1@example.com/tokens"})))
  (testing "private data"
    (assert-ok (api-call user1-request {:method :get :path "/api/v1/users/USER1@example.com/data"})))
  (testing "an admin reads the user's audit"
    (assert-ok (api-call admin-request {:method :get :path "/api/v1/users/USER1@example.com/audit"})))
  (testing "search trims and ignores case"
    (let [resp (api-call admin-request {:method :get :path "/api/v1/users?q=%20USER1@EXAMPLE%20"})]
      (assert-ok resp)
      (is (= ["user1@example.com"] (map :user/id (-> resp :body :entries)))))))

(deftest grants-take-any-case
  (let [pid (h/create-test-project admin-request "Case Project")]
    (testing "a member added by another case is the account"
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" pid "/writers/User2@Example.COM")}))
      (is (= ["user2@example.com"] (-> (h/get-test-project admin-request pid) :body :project/writers))))
    (testing "and removed by another case"
      (assert-no-content (api-call admin-request {:method :delete
                                                  :path (str "/api/v1/projects/" pid "/writers/USER2@example.com")}))
      (is (empty? (-> (h/get-test-project admin-request pid) :body :project/writers)))))
  (let [vid (-> (h/create-vocab-layer admin-request "Case Vocab") :body :id)]
    (testing "a vocabulary maintainer added by another case is the account"
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/vocab-layers/" vid "/maintainers/USER2@Example.com")}))
      (is (some #{"user2@example.com"} (-> (h/get-vocab-layer admin-request vid) :body :vocab/maintainers))))))

(deftest invites-take-any-case
  (let [pid (h/create-test-project admin-request "Invite Case")
        mint (fn [body] (api-call admin-request {:method :post :path "/api/v1/invites" :body body}))
        redeem (fn [body] (api-call anon-request {:method :post :path "/api/v1/invites/redeem" :body body}))
        code1 (-> (mint {:project-id pid :project-role "writer" :max-uses 5}) :body :code)]
    (testing "a signup redeemed with a mixed-case email makes the lowercased account"
      (let [resp (redeem {:code code1 :email " Invitee@Example.COM " :password "long-enough-1"})]
        (assert-ok resp)
        (is (= "invitee@example.com" (-> resp :body :user-id)))
        (is (some? (user/get db "invitee@example.com")))
        (is (some #{"invitee@example.com"} (-> (h/get-test-project admin-request pid) :body :project/writers)))
        (assert-ok (login "invitee@example.com" "long-enough-1"))))
    (testing "the same address in another case is refused as taken"
      (assert-status 409 (redeem {:code code1 :email "INVITEE@example.com" :password "long-enough-1"})))
    (testing "a reset link minted for another case names the account"
      (let [resp (mint {:target-user-id "INVITEE@Example.com"})]
        (assert-created resp)
        (let [r (redeem {:code (-> resp :body :code) :password "another-long-1"})]
          (assert-ok r)
          (is (= "invitee@example.com" (-> r :body :user-id))))
        (assert-ok (login "Invitee@example.com" "another-long-1"))))))
