(ns plaid.rest-api.v1.service-channel-owner-test
  "Who may act as a service. A delegated token (the one an assistant is
  handed to act for a requester) never opens a service channel, on any path
  in, so a captured one cannot collect other members' tokens. And only the
  account that holds the service channel a request went to may report that
  request's progress or result: another writer on the project who learns the
  request id cannot answer in the service's place.

  ring-mock cannot hold an SSE channel, so `http-kit/as-channel` is redefined
  to open the REAL handler onto a stub channel, as in `service-standing-test`."
  (:require [clojure.data.json :as json]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [mount.core :as mount]
            [org.httpkit.server :as http-kit]
            [plaid.fixtures :as fix
             :refer [with-db with-mount-states with-rest-handler with-admin
                     with-test-users with-clean-db api-call admin-request]]
            [plaid.rest-api.v1.auth :as auth]
            [plaid.server.events :as events]
            [plaid.test-helpers :as h]
            [ring.mock.request :as mock]))

(defn with-rpc-state-started [f]
  (mount/start #'plaid.server.events/service-channels
               #'plaid.server.events/inflight-requests)
  (f))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin
  with-test-users with-rpc-state-started)
(use-fixtures :each with-clean-db)

(defn- as [token]
  (fn [method path]
    (-> (mock/request method path)
        (mock/header "accept" "application/edn")
        (mock/header "Authorization" (str "Bearer " token)))))

(defn- stub-channel [closed sent]
  (reify http-kit/Channel
    (open? [_] (not @closed))
    (websocket? [_] false)
    (close [_] (reset! closed true) true)
    (send! [_ data] (swap! sent conj data) (not @closed))
    (send! [_ data _] (swap! sent conj data) (not @closed))
    (on-receive [_ _])
    (on-ping [_ _])
    (on-close [_ _])))

(defn- channel-path [pid sid extras]
  (str "/api/v1/projects/" pid "/services/" sid "/requests?service-name=" sid
       (when extras
         (str "&extras=" (java.net.URLEncoder/encode (json/write-str extras) "UTF-8")))))

(defn- open!
  "Open service `sid` on `pid` through the real route with `token`. Returns
  {:resp :closed :sent}."
  ([token pid sid] (open! token pid sid nil))
  ([token pid sid extras]
   (let [closed (atom false)
         sent (atom [])
         ch (stub-channel closed sent)
         resp (with-redefs [http-kit/as-channel (fn [_ {:keys [on-open]}]
                                                  (on-open ch)
                                                  {:status 200 :body ""})]
                (fix/rest-handler ((as token) :get (channel-path pid sid extras))))]
     {:resp resp :closed closed :sent sent})))

(defn- submit!
  "Submit work to `sid` on `pid` with `token`. Returns the request id the
  service was sent, or nil."
  [token pid sid sent]
  (with-redefs [http-kit/as-channel (fn [_ {:keys [on-open]}]
                                      (on-open (stub-channel (atom false) (atom [])))
                                      {:status 200 :body ""})]
    (fix/rest-handler (-> ((as token) :post (str "/api/v1/projects/" pid "/services/" sid "/requests"))
                          (mock/json-body {:q 1}))))
  (when-let [frame (last (filter #(and (string? %) (str/starts-with? % "event: service_request")) @sent))]
    (:request-id (json/read-str (second (re-find #"(?m)^data: (.*)$" frame)) :key-fn keyword))))

(defn- report! [token pid request-id body]
  (:status (fix/rest-handler (-> ((as token) :post (str "/api/v1/projects/" pid
                                                        "/service-requests/" request-id "/events"))
                                 (mock/json-body body)))))

(defn- writer! [pid email]
  (api-call admin-request {:method :post :path (str "/api/v1/projects/" pid "/writers/" email)}))

(deftest a-delegated-token-cannot-open-a-service-channel
  (events/reset-state!)
  (let [pid (h/create-test-project admin-request "Owner P")
        _ (writer! pid "user1@example.com")
        delegated (auth/issue-delegated-token! fix/db "fake-secret" "user1@example.com" [pid])
        admin-delegated (auth/issue-delegated-token! fix/db "fake-secret" "admin@example.com" [pid])]
    (doseq [[label token] [["a writer's" delegated] ["an admin's" admin-delegated]]
            extras [nil {:delegation true}]]
      (testing (str label " delegated token, " (if extras "a delegating service" "a plain service"))
        (let [{:keys [resp]} (open! token pid "trap" extras)]
          (is (= 403 (:status resp)))
          (is (re-find #"delegated" (let [b (:body resp)] (if (string? b) b (slurp b)))))
          (is (nil? (events/get-service-channel pid "trap")) "nothing registered"))))
    (testing "through a batch"
      (let [resp (with-redefs [http-kit/as-channel (fn [_ {:keys [on-open]}]
                                                     (on-open (stub-channel (atom false) (atom [])))
                                                     {:status 200 :body ""})]
                   (fix/rest-handler (-> ((as delegated) :post "/api/v1/batch")
                                         (mock/json-body [{:path (channel-path pid "trap" nil) :method "get"}]))))]
        (is (= 403 (:status resp)))
        (is (re-find #"delegated" (let [b (:body resp)] (if (string? b) b (slurp b)))))
        (is (nil? (events/get-service-channel pid "trap")) "nothing registered")))
    (testing "the same user's own session still opens one"
      (is (= 200 (:status (:resp (open! fix/user1-token pid "svc")))))
      (is (some? (events/get-service-channel pid "svc"))))))

(deftest only-the-service-reports-its-requests
  (events/reset-state!)
  (let [pid (h/create-test-project admin-request "Owner Q")
        _ (writer! pid "user1@example.com")
        _ (writer! pid "user2@example.com")
        {:keys [sent]} (open! fix/user1-token pid "svc")
        rid (submit! fix/admin-token pid "svc" sent)]
    (is (string? rid) "the service was sent the request")
    (testing "another writer on the project cannot report it"
      (is (= 403 (report! fix/user2-token pid rid {:status "progress" :progress {:percent 5}})))
      (is (= 403 (report! fix/user2-token pid rid {:status "completed" :data {:forged true}})))
      (is (= 403 (report! fix/user2-token pid rid {:status "error" :data "forged"})))
      (is (nil? (:result (events/get-request rid))) "the request is still open")
      (is (nil? (:last-progress (events/get-request rid)))))
    (testing "an admin who is not the service cannot either"
      (is (= 403 (report! fix/admin-token pid rid {:status "completed" :data {:forged true}}))))
    (testing "the requester cannot answer their own request"
      (let [rid2 (submit! fix/user2-token pid "svc" sent)]
        (is (= 403 (report! fix/user2-token pid rid2 {:status "completed" :data {}})))))
    (testing "the service's own account reports it"
      (is (= 200 (report! fix/user1-token pid rid {:status "progress" :progress {:percent 50}})))
      (is (= {:percent 50} (:last-progress (events/get-request rid))))
      (is (= 200 (report! fix/user1-token pid rid {:status "completed" :data {:ok true}})))
      (is (= {:event "result" :data {:data {:ok true}}} (:result (events/get-request rid)))))))

(deftest a-reconnected-service-still-reports-what-it-was-sent
  ;; The service's channel drops and its supervisor reopens it, here with a
  ;; different credential of the same account (an API token), taking over
  ;; the registration. The request it was already working on is its own.
  (events/reset-state!)
  (let [pid (h/create-test-project admin-request "Owner R")
        _ (writer! pid "user1@example.com")
        {:keys [sent closed]} (open! fix/user1-token pid "svc")
        rid (submit! fix/admin-token pid "svc" sent)
        api-token (:token (:body (api-call admin-request {:method :post
                                                          :path "/api/v1/users/user1@example.com/tokens"
                                                          :body {:name "svc"}})))]
    (reset! closed true)
    (is (= 200 (:status (:resp (open! api-token pid "svc")))) "the reconnect took over")
    (is (nil? (:result (events/get-request rid))) "the request survived the takeover")
    (is (= 200 (report! api-token pid rid {:status "completed" :data {:ok true}})))
    (is (= "result" (-> (events/get-request rid) :result :event)))))
