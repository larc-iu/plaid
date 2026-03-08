(ns plaid.fixtures
  (:require [buddy.hashers :as hashers]
            [clojure.test :refer :all]
            [plaid.xtdb2.user :as pxu]
            [plaid.xtdb2.operation-coordinator]
            [ring.middleware.defaults :refer [wrap-defaults]]
            [ring.mock.request :as mock]
            [xtdb.node :as xtdb-node-api]
            [taoensso.timbre :as log]
            [mount.core :as mount]
            [plaid.rest-api.v1.core :as rest]))

(log/set-min-level! :info)

;; Single shared XTDB node for all test namespaces — started once per JVM session
(defonce ^:private shared-node (xtdb-node-api/start-node {:log [:in-memory {}]
                                                          :storage [:in-memory {}]}))
(defonce ^:private coordinator-started? (atom false))

(def ^:dynamic xtdb-node nil)
(def ^:dynamic config nil)
(def ^:dynamic rest-handler nil)
(def ^:dynamic admin-token nil)
(def ^:dynamic user1-token nil)
(def ^:dynamic user2-token nil)

(defn with-rest-handler [f]
  (binding [rest-handler
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
  (binding [xtdb-node shared-node]
    (f)))

(defn with-mount-states [f]
  (mount/start #'plaid.xtdb2.operation-coordinator/operation-coordinator)
  (when (compare-and-set! coordinator-started? false true)
    ;; Only sleep on first start to allow the coordinator's async thread to initialize
    (Thread/sleep 100))
  (f))

(defn- ensure-user! [xt-map email admin? password]
  (try
    (when-not (pxu/get-internal xt-map email)
      (pxu/create xt-map email admin? password))
    (catch clojure.lang.ExceptionInfo _)))

(defn with-admin [f]
  (let [xt-map {:node xtdb-node}
        _ (ensure-user! xt-map "admin@example.com" true "password")
        req (rest-handler (-> (mock/request :post "/api/v1/login")
                              (mock/header "accept" "application/edn")
                              (mock/json-body {:user-id "admin@example.com"
                                               :password "password"})))]
    (binding [admin-token (-> req :body slurp read-string :token)]
      (f))))

(defn with-test-users [f]
  (let [xt-map {:node xtdb-node}
        _ (ensure-user! xt-map "user1@example.com" false "password1")
        _ (ensure-user! xt-map "user2@example.com" false "password2")
        user1-req (rest-handler (-> (mock/request :post "/api/v1/login")
                                    (mock/header "accept" "application/edn")
                                    (mock/json-body {:user-id "user1@example.com"
                                                     :password "password1"})))
        user2-req (rest-handler (-> (mock/request :post "/api/v1/login")
                                    (mock/header "accept" "application/edn")
                                    (mock/json-body {:user-id "user2@example.com"
                                                     :password "password2"})))]
    (binding [user1-token (-> user1-req :body slurp read-string :token)
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
     :headers (:headers resp)
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