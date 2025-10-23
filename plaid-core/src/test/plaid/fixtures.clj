(ns plaid.fixtures
  (:require [buddy.hashers :as hashers]
            [clojure.test :refer :all]
            [plaid.xtdb.user :as pxu]
            [plaid.xtdb.operation] ; Load for defstate
            [ring.middleware.defaults :refer [wrap-defaults]]
            [ring.mock.request :as mock]
            [xtdb.api :as xt]
            [taoensso.timbre :as log]
            [mount.core :as mount]
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
                     {:params {:keywordize true
                               :multipart true
                               :nested true
                               :urlencoded true}
                      :cookies false
                      :responses {:absolute-redirects true
                                  :content-types true
                                  :default-charset "utf-8"
                                  :not-modified-responses true}
                      :static {:resources "public"}
                      :session false
                      :security {:anti-forgery false
                                 :hsts true
                                 :ssl-redirect false
                                 :frame-options :sameorigin
                                 :xss-protection {:enable? true
                                                  :mode :block}}}))]
    (f)))

(defn with-xtdb [f]
  (with-redefs [xtdb-node (xt/start-node {})]
    (f)))

(defn with-mount-states [f]
  "Start mount states needed for testing"
  (try
    (mount/start #'plaid.xtdb.operation/operation-coordinator)
    ;; Small delay to ensure coordinator async thread is fully started
    (Thread/sleep 100)
    (f)
    (finally
      (mount/stop #'plaid.xtdb.operation/operation-coordinator))))

(defn with-admin [f]
  (let [_ (pxu/create {:node xtdb-node} "admin@example.com" true "password")
        req (rest-handler (-> (mock/request :post "/api/v1/login")
                              (mock/header "accept" "application/edn")
                              (mock/json-body {:user-id "admin@example.com"
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
                                    (mock/json-body {:user-id "user1@example.com"
                                                     :password "password1"})))
        user2-req (rest-handler (-> (mock/request :post "/api/v1/login")
                                    (mock/header "accept" "application/edn")
                                    (mock/json-body {:user-id "user2@example.com"
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

;; API Testing Helper Functions
(defn parse-response-body
  "Parse the response body from EDN format"
  [response]
  (read-string (slurp (:body response))))

(defn api-call
  "Make an API call using a request map with :method, :path, and optional :body"
  [user-request-fn request-map]
  (let [{:keys [method path body]} request-map
        req (cond-> (user-request-fn method path)
              body (mock/json-body body))
        resp (rest-handler req)]
    {:status (:status resp)
     :body (when-let [response-body (:body resp)]
             (when-not (= response-body "")
               (parse-response-body resp)))}))

;; Assertion Helpers
(defn assert-status
  "Assert that response has expected status code"
  [expected-status response]
  (is (= expected-status (:status response))))

(defn assert-success
  "Assert that response has 2xx status code"
  [response]
  (is (< 199 (:status response) 300)))

(defn assert-created
  "Assert that response has 201 Created status"
  [response]
  (assert-status 201 response))

(defn assert-ok
  "Assert that response has 200 OK status"
  [response]
  (assert-status 200 response))

(defn assert-no-content
  "Assert that response has 204 No Content status"
  [response]
  (assert-status 204 response))

(defn assert-not-found
  "Assert that response has 404 Not Found status"
  [response]
  (assert-status 404 response))

(defn assert-forbidden
  "Assert that response has 403 Forbidden status"
  [response]
  (assert-status 403 response))

(defn assert-bad-request
  "Assert that response has 400 Bad Request status"
  [response]
  (assert-status 400 response))