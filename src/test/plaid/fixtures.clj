(ns plaid.fixtures
  (:require [buddy.hashers :as hashers]
            [clojure.test :refer :all]
            [plaid.xtdb.user :as pxu]
            [ring.middleware.defaults :refer [wrap-defaults]]
            [ring.mock.request :as mock]
            [xtdb.api :as xt]
            [taoensso.timbre :as log]
            [plaid.rest-api.v1.core :as rest]))

(log/set-min-level! :info)

(def xtdb-node nil)
(def config nil)
(def rest-handler nil)
(def admin-token nil)
(def user1-token nil)
(def user2-token nil)

(defn with-rest-handler [f]
  (with-redefs [rest-handler
                (-> (rest/rest-handler xtdb-node "fake-secret")
                    (wrap-defaults
                      {:params    {:keywordize true
                                   :multipart  true
                                   :nested     true
                                   :urlencoded true}
                       :cookies   true
                       :responses {:absolute-redirects     true
                                   :content-types          true
                                   :default-charset        "utf-8"
                                   :not-modified-responses true}
                       :static    {:resources "public"}
                       :session   false
                       :security  {:anti-forgery   false
                                   :hsts           true
                                   :ssl-redirect   false
                                   :frame-options  :sameorigin
                                   :xss-protection {:enable? true
                                                    :mode    :block}}}))]
    (f)))

(defn with-xtdb [f]
  (with-redefs [xtdb-node (xt/start-node {})]
    (f)))

(defn with-admin [f]
  (let [_ (pxu/create {:node xtdb-node} "admin@example.com" true "password")
        req (rest-handler (-> (mock/request :post "/api/v1/login")
                              (mock/header "accept" "application/edn")
                              (mock/json-body {:username "admin@example.com"
                                               :password "password"})))]
    (with-redefs [admin-token (-> req :body slurp read-string :token)]
      (f))))

(defn with-test-users [f]
  ;; Create test users
  (let [_ (pxu/create {:node xtdb-node} "user1@example.com" false "password1")
        _ (pxu/create {:node xtdb-node} "user2@example.com" false "password2")
        ;; Get tokens for test users
        user1-req (rest-handler (-> (mock/request :post "/api/v1/login")
                                    (mock/header "accept" "application/edn")
                                    (mock/json-body {:username "user1@example.com"
                                                     :password "password1"})))
        user2-req (rest-handler (-> (mock/request :post "/api/v1/login")
                                    (mock/header "accept" "application/edn")
                                    (mock/json-body {:username "user2@example.com"
                                                     :password "password2"})))]
    (with-redefs [user1-token (-> user1-req :body slurp read-string :token)
                  user2-token (-> user2-req :body slurp read-string :token)]
      (f))))

(defn admin-request [method path]
  (-> (mock/request method path)
      (mock/header "accept" "application/edn")
      (mock/header "Authorization" (str "Bearer " admin-token))))

(defn user1-request [method path]
  (-> (mock/request method path)
      (mock/header "accept" "application/edn")
      (mock/header "Authorization" (str "Bearer " user1-token))))

(defn user2-request [method path]
  (-> (mock/request method path)
      (mock/header "accept" "application/edn")
      (mock/header "Authorization" (str "Bearer " user2-token))))