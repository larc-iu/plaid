(ns plaid.rest-api.v1.service-reconnect-grace-test
  "A service whose channel drops and comes back within
  `message/reconnect-grace-ms` keeps the requests it was serving: the
  requester still waits, and the service's reports are taken meanwhile. With
  no channel back in that time they end \"Service disconnected\", as they did
  at once before."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [org.httpkit.server :as http-kit]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-test-users with-clean-db api-call admin-request]]
            [plaid.rest-api.v1.message :as message]
            [plaid.server.events :as events]
            [plaid.test-helpers :refer [with-rpc-state-started]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin
  with-test-users with-rpc-state-started)
(use-fixtures :each with-clean-db)

(def ^:private runner "admin@example.com")

(defn- create-project! []
  (-> (api-call admin-request {:method :post :path "/api/v1/projects" :body {:name "grace-test"}})
      :body :id))

(defn- report! [pid rid]
  (:status (api-call admin-request {:method :post
                                    :path (str "/api/v1/projects/" pid "/service-requests/" rid "/events")
                                    :body {:status "progress" :progress {:percent 50}}})))

(defn- ended [rid] (get-in (events/get-request rid) [:result :data :error]))

(defn- settle
  "Wait out the grace and a little more, for the timer's go block."
  [ms]
  (Thread/sleep (+ ms 300)))

(defmacro ^:private with-grace [ms & body]
  `(with-redefs [message/reconnect-grace-ms ~ms] ~@body))

(defn- open! [pid ch user]
  (events/register-service-channel! pid "svc" ch {:service-name "S"} user)
  (message/service-channel-opened! pid "svc" user ch))

(defn- close! [pid ch]
  (message/service-channel-closed! (:db admin-request) pid "svc" ch))

(deftest a-reconnect-within-the-grace-adopts-what-the-service-reported-on
  (events/reset-state!)
  (with-grace 400
    (let [pid (create-project!)
          old (Object.)
          new (Object.)]
      (open! pid old runner)
      (events/track-request! "heard" nil pid "svc" "user1@example.com" runner)
      (is (= 200 (report! pid "heard")))
      (close! pid old)
      (testing "the channel is gone, the request is held"
        (is (nil? (events/get-service-channel pid "svc")))
        (is (nil? (ended "heard"))))
      (testing "the service's report in the gap is taken"
        (is (= 200 (report! pid "heard"))))
      (open! pid new runner)
      (settle 400)
      (testing "adopted: still running after the grace"
        (is (nil? (ended "heard")))
        (is (= 200 (report! pid "heard")))))))

(deftest with-no-channel-back-the-requests-end-disconnected
  (events/reset-state!)
  (with-grace 300
    (let [pid (create-project!)
          ch (Object.)]
      (open! pid ch runner)
      (events/track-request! "r1" nil pid "svc" "user1@example.com" runner)
      (close! pid ch)
      (is (nil? (ended "r1")) "held during the grace")
      (settle 300)
      (is (= "Service disconnected" (ended "r1")))
      (is (= 404 (report! pid "r1")) "a report after that is refused"))))

(deftest a-request-the-service-never-reported-on-ends-at-the-reconnect
  ;; It may have been lost on the dead connection, so the service may never
  ;; have received it.
  (events/reset-state!)
  (with-grace 5000
    (let [pid (create-project!)
          old (Object.)]
      (open! pid old runner)
      (events/track-request! "heard" nil pid "svc" "user1@example.com" runner)
      (events/track-request! "unheard" nil pid "svc" "user1@example.com" runner)
      (report! pid "heard")
      (close! pid old)
      (open! pid (Object.) runner)
      (is (nil? (ended "heard")))
      (is (= "Service disconnected" (ended "unheard"))))))

(deftest a-channel-of-another-account-adopts-nothing
  (events/reset-state!)
  (with-grace 5000
    (let [pid (create-project!)
          old (Object.)]
      (open! pid old runner)
      (events/track-request! "r1" nil pid "svc" "user1@example.com" runner)
      (report! pid "r1")
      (close! pid old)
      (open! pid (Object.) "user2@example.com")
      (is (= "Service disconnected" (ended "r1"))))))

(deftest a-stop-asked-for-in-the-gap-reaches-the-service-when-it-is-back
  (events/reset-state!)
  (with-grace 5000
    (let [pid (create-project!)
          old (Object.)
          new (Object.)
          sent (atom [])]
      (open! pid old runner)
      (events/track-request! "r1" nil pid "svc" runner runner)
      (report! pid "r1")
      (close! pid old)
      (is (= 204 (:status (api-call admin-request {:method :delete
                                                   :path (str "/api/v1/projects/" pid "/service-requests/r1")}))))
      (with-redefs [http-kit/send! (fn [ch data _] (swap! sent conj [ch data]) true)]
        (open! pid new runner))
      (is (nil? (ended "r1")))
      (is (= [[new "event: service_cancel\ndata: {\"request-id\":\"r1\"}\n\n"]] @sent)))))

(deftest a-close-with-a-live-takeover-holds-nothing
  (events/reset-state!)
  (with-grace 0
    (let [pid (create-project!)
          old (Object.)
          new (Object.)]
      (open! pid old runner)
      (events/track-request! "r1" nil pid "svc" "user1@example.com" runner)
      ;; The reconnect took over before the old channel's close was seen.
      (events/register-service-channel! pid "svc" new {:service-name "S"} runner)
      (close! pid old)
      (settle 0)
      (is (nil? (ended "r1")))
      (is (= new (events/get-service-channel pid "svc"))))))

(deftest a-second-drop-gets-a-grace-of-its-own
  (events/reset-state!)
  (with-grace 600
    (let [pid (create-project!)
          a (Object.)
          b (Object.)]
      (open! pid a runner)
      (events/track-request! "r1" nil pid "svc" "user1@example.com" runner)
      (report! pid "r1")
      (close! pid a)
      (Thread/sleep 300)
      (open! pid b runner)
      (close! pid b)
      ;; The first close's timer fires here, 600 ms after it: the second
      ;; close's grace has 300 ms to go.
      (Thread/sleep 450)
      (is (nil? (ended "r1")))
      (settle 300)
      (is (= "Service disconnected" (ended "r1"))))))

(deftest a-channel-back-but-not-yet-opened-when-the-grace-ends-is-left-to-adopt
  (events/reset-state!)
  (with-grace 200
    (let [pid (create-project!)
          old (Object.)
          new (Object.)]
      (open! pid old runner)
      (events/track-request! "r1" nil pid "svc" "user1@example.com" runner)
      (report! pid "r1")
      (close! pid old)
      ;; Registered, its standing check and greeting still under way.
      (events/register-service-channel! pid "svc" new {:service-name "S"} runner)
      (settle 200)
      (is (nil? (ended "r1")))
      (message/service-channel-opened! pid "svc" runner new)
      (is (nil? (ended "r1"))))))
