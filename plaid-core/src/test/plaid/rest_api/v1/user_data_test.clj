(ns plaid.rest-api.v1.user-data-test
  "Private per-user key/value storage: round trip of arbitrary JSON, prefix
  listing with/without values, delete, the owner-or-admin ACL, and the size cap."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin with-test-users
                                    with-clean-db api-call admin-request user1-request user2-request]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

;; Values come back with STRING keys (the store is verbatim JSON, not a Plaid
;; entity): identical on the JSON wire, visible here because tests read EDN.

(def u1 "user1@example.com")
(defn- path [user-id & [key]] (str "/api/v1/users/" user-id "/data" (when key (str "/" key))))

(deftest put-get-list-delete-round-trip
  (let [value {:title "Chat 1" :messages [{:role "user" :content "hi"} {:role "assistant" :content nil
                                                                        :tool_calls [{:id "c1"}]}]
               :n 3 :flag true}]
    (testing "put returns the key and a timestamp; get returns the value verbatim"
      (let [resp (api-call user1-request {:method :put :path (path u1 "igt:assistant:p1:meta:c1") :body value})]
        (is (= 200 (:status resp)))
        (is (= "igt:assistant:p1:meta:c1" (:key (:body resp))))
        (is (string? (:updated-at (:body resp)))))
      (let [{:keys [status body]} (api-call user1-request {:method :get :path (path u1 "igt:assistant:p1:meta:c1")})]
        (is (= 200 status))
        (is (= "Chat 1" (get-in body [:value "title"])))
        (is (= 3 (get-in body [:value "n"])))
        (is (true? (get-in body [:value "flag"])))
        (is (nil? (get-in body [:value "messages" 1 "content"])))
        (is (= "c1" (get-in body [:value "messages" 1 "tool_calls" 0 "id"])))))
    (testing "put replaces"
      (api-call user1-request {:method :put :path (path u1 "igt:assistant:p1:meta:c1") :body {:title "Renamed"}})
      (is (= {"title" "Renamed"} (:value (:body (api-call user1-request {:method :get :path (path u1 "igt:assistant:p1:meta:c1")}))))))
    (testing "listing by prefix, keys only by default, values on request; underscores are literal"
      (api-call user1-request {:method :put :path (path u1 "igt:assistant:p1:msgs:c1") :body [1 2 3]})
      (api-call user1-request {:method :put :path (path u1 "igt:assistant:p2:meta:c9") :body "x"})
      (api-call user1-request {:method :put :path (path u1 "other_app:pref") :body {:dark true}})
      (let [{:keys [status body]} (api-call user1-request {:method :get :path (str (path u1) "?prefix=igt:assistant:p1:")})]
        (is (= 200 status))
        (is (= ["igt:assistant:p1:meta:c1" "igt:assistant:p1:msgs:c1"] (mapv :key body)))
        (is (every? #(not (contains? % :value)) body)))
      (let [{:keys [body]} (api-call user1-request {:method :get :path (str (path u1) "?prefix=igt:assistant:p1:meta:&include-values=true")})]
        (is (= [{"title" "Renamed"}] (mapv :value body))))
      (is (= 4 (count (:body (api-call user1-request {:method :get :path (path u1)})))))
      (is (= ["other_app:pref"] (mapv :key (:body (api-call user1-request {:method :get :path (str (path u1) "?prefix=other_app")})))))
      (is (= [] (:body (api-call user1-request {:method :get :path (str (path u1) "?prefix=otherXapp")})))))
    (testing "delete, then 404"
      (is (= 204 (:status (api-call user1-request {:method :delete :path (path u1 "igt:assistant:p1:msgs:c1")}))))
      (is (= 404 (:status (api-call user1-request {:method :delete :path (path u1 "igt:assistant:p1:msgs:c1")}))))
      (is (= 404 (:status (api-call user1-request {:method :get :path (path u1 "igt:assistant:p1:msgs:c1")})))))))

(deftest scalar-values-and-encoded-keys
  (let [key "igt:assistant:p1:weird%2Fkey"]
    (is (= 200 (:status (api-call user1-request {:method :put :path (path u1 key) :body 42}))))
    (is (= 42 (:value (:body (api-call user1-request {:method :get :path (path u1 key)})))))
    (is (= ["igt:assistant:p1:weird/key"] (mapv :key (:body (api-call user1-request {:method :get :path (path u1)})))))))

(deftest owner-or-admin-only
  (api-call user1-request {:method :put :path (path u1 "k") :body {:secret 1}})
  (testing "another user can neither read, list, write, nor delete"
    (is (= 403 (:status (api-call user2-request {:method :get :path (path u1 "k")}))))
    (is (= 403 (:status (api-call user2-request {:method :get :path (path u1)}))))
    (is (= 403 (:status (api-call user2-request {:method :put :path (path u1 "k") :body {}}))))
    (is (= 403 (:status (api-call user2-request {:method :delete :path (path u1 "k")})))))
  (testing "an admin can"
    (is (= {"secret" 1} (:value (:body (api-call admin-request {:method :get :path (path u1 "k")})))))
    (is (= 204 (:status (api-call admin-request {:method :delete :path (path u1 "k")})))))
  (testing "entries are per user: the same key on another user is a different entry"
    (api-call user2-request {:method :put :path (path "user2@example.com" "k") :body 2})
    (is (= 404 (:status (api-call user1-request {:method :get :path (path u1 "k")}))))))

(deftest value-size-cap
  (let [big (apply str (repeat 1000001 "a"))]
    (is (= 413 (:status (api-call user1-request {:method :put :path (path u1 "big") :body big}))))
    (is (= 404 (:status (api-call user1-request {:method :get :path (path u1 "big")}))))))
