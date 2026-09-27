(ns plaid.rest-api.v1.delegated-token-lifetime-test
  "A delegated token lasts its hour and no longer. It cannot renew itself by
  submitting to a delegating service (its own, say), and a service channel
  opened with it closes when it expires, so the channel cannot go on
  receiving other members' tokens afterwards.

  ring-mock cannot hold an SSE channel, so `http-kit/as-channel` is redefined
  to open the REAL handler onto a stub channel, as in `service-standing-test`."
  (:require [buddy.sign.jwt :as jwt]
            [clojure.data.json :as json]
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
               #'plaid.server.events/inflight-requests
               #'plaid.server.events/client-registry
               #'plaid.server.events/channel-mappings
               #'plaid.server.events/heartbeat-registry)
  (f))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin
  with-test-users with-rpc-state-started)
(use-fixtures :each with-clean-db)

(defn- as [token]
  (fn [method path]
    (-> (mock/request method path)
        (mock/header "accept" "application/edn")
        (mock/header "Authorization" (str "Bearer " token)))))

(defn- claims [token]
  (jwt/unsign token "fake-secret"))

(defn- stub-channel
  "An open channel that records what is sent down it and whether it closed."
  [closed sent]
  (reify http-kit/Channel
    (open? [_] (not @closed))
    (websocket? [_] false)
    (close [_] (reset! closed true) true)
    (send! [_ data] (swap! sent conj data) (not @closed))
    (send! [_ data _] (swap! sent conj data) (not @closed))
    (on-receive [_ _])
    (on-ping [_ _])
    (on-close [_ _])))

(defn- open-service!
  "Open delegating service `sid` on `pid` through the real route with
  `token`. Returns {:closed atom :sent atom}."
  [token pid sid]
  (let [closed (atom false)
        sent (atom [])
        ch (stub-channel closed sent)]
    (with-redefs [http-kit/as-channel (fn [_ {:keys [on-open]}]
                                        (on-open ch)
                                        {:status 200 :body ""})]
      (fix/rest-handler ((as token) :get
                                    (str "/api/v1/projects/" pid "/services/" sid
                                         "/requests?service-name=" sid
                                         "&extras=" (java.net.URLEncoder/encode
                                                     (json/write-str {:delegation true}) "UTF-8")))))
    {:closed closed :sent sent}))

(defn- submit!
  "Submit work to `sid` on `pid` with `token`, the requester's stream opened
  onto a stub. Returns the response."
  [token pid sid]
  (with-redefs [http-kit/as-channel (fn [_ {:keys [on-open]}]
                                      (on-open (stub-channel (atom false) (atom [])))
                                      {:status 200 :body ""})]
    (fix/rest-handler (-> ((as token) :post (str "/api/v1/projects/" pid "/services/" sid "/requests"))
                          (mock/json-body {:q 1})))))

(defn- handed-token
  "The delegated token the last service_request sent down `sent` carried."
  [sent]
  (when-let [frame (last (filter #(and (string? %) (str/starts-with? % "event: service_request")) @sent))]
    (let [data (second (re-find #"(?m)^data: (.*)$" frame))]
      (:delegated-token (json/read-str data :key-fn keyword)))))

(deftest a-delegated-token-cannot-renew-itself-through-a-service
  (events/reset-state!)
  (let [pid (h/create-test-project admin-request "Lifetime P")
        _ (api-call admin-request {:method :post :path (str "/api/v1/projects/" pid "/writers/user1@example.com")})
        ;; The attacker's delegating service, on a project they write.
        {:keys [sent]} (open-service! fix/user1-token pid "helper")
        ;; A token that has 30 seconds left, as a captured one would near the
        ;; end of its hour.
        captured (with-redefs [auth/delegated-token-ttl-seconds (constantly 30)]
                   (auth/issue-delegated-token! fix/db "fake-secret" "admin@example.com" [pid]))]
    (is (= 200 (:status (submit! captured pid "helper"))))
    (let [handed (handed-token sent)]
      (is (string? handed) "the service was handed a token")
      (is (<= (:exp (claims handed)) (:exp (claims captured)))
          "the token it was handed expires no later than the one that asked"))
    (testing "an ordinary session still hands the service a fresh hour"
      (is (= 200 (:status (submit! fix/admin-token pid "helper"))))
      (is (< (- (:exp (claims (handed-token sent))) (quot (System/currentTimeMillis) 1000))
             (+ 5 (auth/delegated-token-ttl-seconds))))
      (is (< (- (auth/delegated-token-ttl-seconds) 5)
             (- (:exp (claims (handed-token sent))) (quot (System/currentTimeMillis) 1000)))))))

(deftest a-channel-opened-with-a-delegated-token-closes-when-it-expires
  (events/reset-state!)
  (let [pid (h/create-test-project admin-request "Lifetime Q")
        short-lived (with-redefs [auth/delegated-token-ttl-seconds (constantly 2)]
                      (auth/issue-delegated-token! fix/db "fake-secret" "admin@example.com" [pid]))
        {:keys [closed]} (open-service! short-lived pid "trap")]
    (is (some? (events/get-service-channel pid "trap")) "the channel opened while the token was good")
    (let [deadline (+ (System/currentTimeMillis) 6000)]
      (while (and (not @closed) (< (System/currentTimeMillis) deadline))
        (Thread/sleep 100)))
    (is @closed "the channel closed once the token expired")
    (is (nil? (events/get-service-channel pid "trap")))
    (testing "a member's request no longer reaches it"
      (is (= 503 (:status (submit! fix/admin-token pid "trap")))))))

(deftest a-submit-after-expiry-never-reaches-the-channel
  ;; Should the timer not have fired yet, the submit asks again.
  (events/reset-state!)
  (let [pid (h/create-test-project admin-request "Lifetime R")
        short-lived (with-redefs [auth/delegated-token-ttl-seconds (constantly 1)]
                      (auth/issue-delegated-token! fix/db "fake-secret" "admin@example.com" [pid]))
        {:keys [closed sent]} (with-redefs [plaid.rest-api.v1.message/close-at-expiry! (fn [& _])]
                                (open-service! short-lived pid "trap"))]
    (Thread/sleep 2100)
    (is (not @closed) "no timer closed it")
    (is (= 503 (:status (submit! fix/admin-token pid "trap"))))
    (is @closed)
    (is (nil? (handed-token sent)) "no token went down the channel")))
