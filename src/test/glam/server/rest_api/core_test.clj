(ns glam.server.rest-api.core-test
  (:require [clojure.test :refer :all]
            [clojure.string]
            [ring.mock.request :as mock]
            [glam.server.rest-api.fixtures :refer [get-session-cookie add-session]]
            [glam.fixtures :refer [with-xtdb
                                   with-parser
                                   with-rest-handler
                                   rest-handler]]))

(use-fixtures :once with-xtdb with-parser with-rest-handler)

(deftest register-user
  (let [cookie (atom nil)]
    (testing "Registration succeeds"
      (let [req (-> (mock/request :post "/rest-api/v1/session/register")
                    (mock/json-body {:username "a@b.com" :password "fake-password"}))
            {:keys [status]} (rest-handler req)]
        (is (= status 200))))

    (testing "Login succeeds"
      (let [req (-> (mock/request :post "/rest-api/v1/session/login")
                    (mock/json-body {:username "a@b.com" :password "fake-password"}))
            {:keys [status body] :as resp} (rest-handler req)]
        (reset! cookie (get-session-cookie resp))
        (is (= status 200))))

    (testing "Getting own info succeeds"
      (let [req (-> (mock/request :get "/rest-api/v1/user/1")
                    (add-session @cookie))
            {:keys [status body]} (rest-handler req)]
        (is (= status 200))))))