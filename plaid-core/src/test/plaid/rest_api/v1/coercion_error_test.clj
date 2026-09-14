(ns plaid.rest-api.v1.coercion-error-test
  "A request that fails malli coercion answers with the same body shape as
  every other error: an encoded `{:error \"...\"}` under the negotiated
  content type. Reitit's own coercion exception handler returned the raw
  ex-data map, which nothing encoded, so clients got a printed Clojure map
  under application/octet-stream carrying the schema and the submitted
  value.

  Authentication also decides before coercion does: a caller with no token
  gets 401 and learns nothing about the route's schema."
  (:require [clojure.test :refer :all]
            [clojure.string :as str]
            [clojure.data.json :as json]
            [reitit.coercion :as reitit-coercion]
            [reitit.ring :as ring]
            [reitit.ring.coercion :as ring-coercion]
            [ring.mock.request :as mock]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-rest-handler
                                            with-admin with-clean-db rest-handler
                                            admin-request api-call]]
            [plaid.rest-api.v1.core :as rest]
            [plaid.test-helpers :refer [create-test-project]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(def ^:private secret
  "A password the error path must never repeat back."
  "hunter2-secret")

(defn- content-type [response]
  (or (get-in response [:headers "Content-Type"])
      (get-in response [:headers "content-type"])))

(deftest request-coercion-failure-is-a-json-error-body
  (testing "a wrong-typed body field returns a parseable {:error ...} under the negotiated type"
    (let [response (rest-handler (-> (admin-request :post "/api/v1/projects")
                                     (mock/json-body {:name 12345})))
          body (fix/parse-response-body response)]
      (is (= 400 (:status response)))
      (is (str/includes? (content-type response) "application/edn"))
      (is (not (str/includes? (content-type response) "octet-stream")))
      (is (string? (:error body)))
      (is (str/includes? (:error body) "name"))
      (is (str/includes? (:error body) "should be a string"))))

  (testing "a JSON client gets JSON"
    (let [response (rest-handler (-> (mock/request :post "/api/v1/projects")
                                     (mock/header "accept" "application/json")
                                     (mock/header "Authorization"
                                                  (get-in (admin-request :get "/") [:headers "authorization"]))
                                     (mock/json-body {:name 12345})))
          body (json/read-str (slurp (:body response)))]
      (is (= 400 (:status response)))
      (is (str/includes? (content-type response) "application/json"))
      (is (string? (get body "error")))))

  (testing "the submitted value is never echoed"
    (let [response (rest-handler (-> (admin-request :post "/api/v1/users")
                                     (mock/json-body {:id 12345 :password secret})))
          body (fix/parse-response-body response)]
      (is (= 400 (:status response)))
      (is (not (str/includes? (:error body) secret)))))

  (testing "a query parameter failure reads the same way"
    (let [id (create-test-project admin-request "CoercionErrProj")
          response (api-call admin-request {:method :get
                                            :path (str "/api/v1/projects/" id "/audit?limit=5000")})]
      (is (= 400 (:status response)))
      (is (string? (:error (:body response)))))))

(defn- coercion-failure-ex-data
  "The ex-data reitit throws when `body` fails coercion against a two-string
  body schema, using the project's own coercion object."
  [body]
  (let [handler (ring/ring-handler
                 (ring/router
                  ["/probe" {:post {:parameters {:body [:map [:user-id :string] [:password :string]]}
                                    :handler (fn [_] {:status 200 :body {}})}}]
                  {:data {:coercion rest/coercion
                          :middleware [ring-coercion/coerce-request-middleware]}}))]
    (try
      (handler {:request-method :post :uri "/probe" :body-params body})
      nil
      (catch clojure.lang.ExceptionInfo e (ex-data e)))))

(deftest coercion-error-never-materializes-the-submitted-body
  (let [data (coercion-failure-ex-data {:user-id 12345 :password secret})
        encoded (reitit-coercion/encode-error data)]
    (testing "the request did fail coercion"
      (is (some? data))
      (is (= :reitit.coercion/request-coercion (:type data))))
    (testing "encode-error builds neither the submitted value nor the schema"
      (is (not (contains? encoded :value)))
      (is (not (contains? encoded :schema))))
    (testing "nothing it does build carries the body"
      (is (not (str/includes? (pr-str encoded) secret))))
    (testing "the humanized message survives, which is what the client reads"
      (is (some? (:humanized encoded)))
      (is (str/includes? (pr-str (:humanized encoded)) "should be a string")))))

(deftest authentication-answers-before-coercion
  (testing "an unauthenticated malformed request is 401, not a schema-revealing 400"
    (let [response (rest-handler (-> (mock/request :post "/api/v1/projects")
                                     (mock/header "accept" "application/edn")
                                     (mock/json-body {:name 12345})))
          body (fix/parse-response-body response)]
      (is (= 401 (:status response)))
      (is (not (str/includes? (:error body) "name")))))

  (testing "the same route with a token still coerces"
    (let [response (rest-handler (-> (admin-request :post "/api/v1/projects")
                                     (mock/json-body {:name 12345})))]
      (is (= 400 (:status response)))))

  (testing "a route that needs no login still coerces for an anonymous caller"
    (let [response (rest-handler (-> (mock/request :post "/api/v1/login")
                                     (mock/header "accept" "application/edn")
                                     (mock/json-body {:user-id 12345 :password "x"})))]
      (is (= 400 (:status response))))))
