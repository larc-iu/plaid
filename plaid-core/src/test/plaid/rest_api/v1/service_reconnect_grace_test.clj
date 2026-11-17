(ns plaid.rest-api.v1.service-reconnect-grace-test
  "A service whose channel drops and comes back within
  `message/reconnect-grace-ms` keeps the requests it was serving, if it is
  the same process (its instance id) and account: the requester still waits,
  and the service's reports are taken meanwhile. Another process, or none back
  in time, ends them \"Service disconnected\". The marks' one-owner rule
  (message.clj) is tested at function level, and the close and reopen cases
  through the real channel handler (`http-kit/as-channel` redefined to open it
  onto a stub channel, as service_standing_test does)."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [org.httpkit.server :as http-kit]
            [plaid.fixtures :as fix
             :refer [with-db with-mount-states with-rest-handler with-admin
                     with-test-users with-clean-db api-call admin-request]]
            [plaid.rest-api.v1.message :as message]
            [plaid.server.events :as events]
            [plaid.sql.service-registry :as service-registry]
            [plaid.test-helpers :refer [with-rpc-state-started]]
            [ring.mock.request :as mock]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin
  with-test-users with-rpc-state-started)
(use-fixtures :each with-clean-db)

(def ^:private runner "admin@example.com")

(defn- create-project! []
  (-> (api-call admin-request {:method :post :path "/api/v1/projects" :body {:name "grace-test"}})
      :body :id))

(defn- report!
  ([pid rid] (report! admin-request pid rid))
  ([as pid rid]
   (:status (api-call as {:method :post
                          :path (str "/api/v1/projects/" pid "/service-requests/" rid "/events")
                          :body {:status "progress" :progress {:percent 50}}}))))

(defn- ended [rid] (get-in (events/get-request rid) [:result :data :error]))

(defn- held [] @@#'message/held)

(defn- settle
  "Wait out a grace of `ms` and a little more, for the timer's go block."
  [ms]
  (Thread/sleep (+ ms 300)))

(defmacro ^:private with-grace [ms & body]
  `(with-redefs [message/reconnect-grace-ms ~ms] ~@body))

(defn- fresh! []
  (events/reset-state!)
  (reset! @#'message/held {}))

;; --- function level ----------------------------------------------------------

(defn- open!
  ([pid ch] (open! pid ch runner "i1"))
  ([pid ch user instance]
   (events/register-service-channel! pid "svc" ch {:service-name "S" :instance instance
                                                   :extras {:model-pool "p"}} user)
   (message/service-channel-opened! pid "svc" user instance ch)))

(defn- track!
  ([rid pid] (track! rid pid "i1"))
  ([rid pid instance]
   (events/track-request! rid nil pid "svc" "user1@example.com" runner
                          {:instance instance :model-pool "p"})))

(defn- close! [pid ch]
  (message/service-channel-closed! (:db admin-request) pid "svc" ch))

(deftest the-same-process-coming-back-adopts-what-it-reported-on
  (fresh!)
  (with-grace 400
    (let [pid (create-project!) old (Object.) new (Object.)]
      (open! pid old)
      (track! "heard" pid)
      (is (= 200 (report! pid "heard")))
      (close! pid old)
      (testing "the channel is gone, the request is held, its reports taken"
        (is (nil? (events/get-service-channel pid "svc")))
        (is (nil? (ended "heard")))
        (is (= 200 (report! pid "heard"))))
      (open! pid new)
      (settle 400)
      (is (nil? (ended "heard")) "adopted: still running after the grace")
      (is (= {} (held))))))

(deftest with-no-channel-back-the-requests-end-at-the-grace
  (fresh!)
  (with-grace 300
    (let [pid (create-project!) ch (Object.)]
      (open! pid ch)
      (track! "r1" pid)
      (close! pid ch)
      (is (nil? (ended "r1")) "held during the grace")
      (settle 300)
      (is (= "Service disconnected" (ended "r1")))
      (is (= 404 (report! pid "r1")) "a report after that is refused")
      (is (= {} (held))))))

(deftest another-process-coming-back-ends-the-held-requests-at-once
  ;; REV-SD-1: a restarted process (or a second one) of the same id and
  ;; account knows nothing of them.
  (fresh!)
  (with-grace 5000
    (let [pid (create-project!) a (Object.) b (Object.)]
      (open! pid a runner "process-a")
      (track! "r1" pid "process-a")
      (report! pid "r1")
      (close! pid a)
      (open! pid b runner "process-b")
      (is (= "Service disconnected" (ended "r1")) "not 5 s later: now")
      (is (= {} (held)))
      (is (= 0 (:in-flight (events/model-pool-load "p")))))))

(deftest a-new-process-taking-over-a-live-channel-ends-the-old-ones-requests
  (fresh!)
  (with-grace 5000
    (let [pid (create-project!) a (Object.) b (Object.)]
      (open! pid a runner "process-a")
      (track! "r1" pid "process-a")
      ;; A's channel was half-dead and B took it over: no close in between.
      (open! pid b runner "process-b")
      (is (= "Service disconnected" (ended "r1"))))))

(deftest a-client-that-names-no-process-loses-its-requests-at-the-close
  (fresh!)
  (with-grace 5000
    (let [pid (create-project!) ch (Object.)]
      (open! pid ch runner nil)
      (track! "r1" pid nil)
      (report! pid "r1")
      (close! pid ch)
      (is (= "Service disconnected" (ended "r1")) "as before the grace period")
      (is (= {} (held))))))

(deftest a-request-the-service-never-reported-on-ends-at-the-reconnect
  (fresh!)
  (with-grace 5000
    (let [pid (create-project!) old (Object.)]
      (open! pid old)
      (track! "heard" pid)
      (track! "unheard" pid)
      (report! pid "heard")
      (close! pid old)
      (open! pid (Object.))
      (is (nil? (ended "heard")))
      (is (= "Service disconnected" (ended "unheard"))))))

(deftest a-channel-of-another-account-adopts-nothing
  (fresh!)
  (with-grace 5000
    (let [pid (create-project!) old (Object.)]
      (open! pid old)
      (track! "r1" pid)
      (report! pid "r1")
      (close! pid old)
      (open! pid (Object.) "user2@example.com" "i1")
      (is (= "Service disconnected" (ended "r1"))))))

(deftest a-stop-reaches-the-service-once
  ;; REV-SD-5: a stop asked in the gap is sent on the new channel, one already
  ;; sent before the drop is not sent again.
  (fresh!)
  (with-grace 5000
    (let [pid (create-project!) old (Object.) new (Object.) sent (atom [])]
      (with-redefs [http-kit/send! (fn [ch data _] (swap! sent conj [(if (identical? ch old) :old :new) data]) true)]
        (open! pid old)
        (track! "before" pid)
        (track! "during" pid)
        (report! pid "before")
        (report! pid "during")
        (api-call admin-request {:method :delete :path (str "/api/v1/projects/" pid "/service-requests/before")})
        (close! pid old)
        (api-call admin-request {:method :delete :path (str "/api/v1/projects/" pid "/service-requests/during")})
        (open! pid new))
      (is (= [[:old "before"] [:new "during"]]
             (for [[ch data] @sent
                   :let [[_ id] (re-find #"service_cancel\ndata: \{\"request-id\":\"([^\"]+)\"" data)]
                   :when id]
               [ch id]))))))

(deftest the-model-pool-still-counts-a-held-request
  ;; REV-SD-3: a person's turn held in the gap still loads the pool.
  (fresh!)
  (with-grace 5000
    (let [pid (create-project!) old (Object.)]
      (open! pid old)
      (track! "r1" pid)
      (report! pid "r1")
      (is (= 1 (:in-flight (events/model-pool-load "p"))))
      (close! pid old)
      (is (= 1 (:in-flight (events/model-pool-load "p")))))))

(deftest a-result-in-the-gap-reaches-the-requester-and-leaves-no-mark
  (fresh!)
  (with-grace 300
    (let [pid (create-project!) old (Object.)]
      (open! pid old)
      (track! "r1" pid)
      (report! pid "r1")
      (close! pid old)
      (is (= 200 (:status (api-call admin-request
                                    {:method :post
                                     :path (str "/api/v1/projects/" pid "/service-requests/r1/events")
                                     :body {:status "completed" :data {:ok 1}}}))))
      (settle 300)
      (is (= {:event "result" :data {:data {:ok 1}}} (:result (events/get-request "r1"))))
      (is (= {} (held))))))

(deftest a-close-between-registration-and-open-strands-nothing
  ;; REV-SD-2: B registers, B's close runs, then B's open. B's open adopts
  ;; nothing (it is not the registered channel), B's close's timer ends r1.
  (fresh!)
  (with-grace 300
    (let [pid (create-project!) old (Object.) new (Object.)]
      (open! pid old)
      (track! "r1" pid)
      (report! pid "r1")
      (close! pid old)
      (events/register-service-channel! pid "svc" new {:service-name "S" :instance "i1"} runner)
      (close! pid new)
      (with-redefs [http-kit/send! (fn [& _] false)]
        (message/service-channel-opened! pid "svc" runner "i1" new))
      (settle 300)
      (is (= "Service disconnected" (ended "r1")))
      (is (= {} (held))))))

(deftest a-close-overlapping-a-reopen-leaves-no-mark-beside-the-live-channel
  ;; REV-SD-6: A's close unregisters, B registers and opens (no mark yet),
  ;; then A's close marks r1. The timer takes the mark and B adopts r1.
  (fresh!)
  (with-grace 300
    (let [pid (create-project!) a (Object.) b (Object.)]
      (open! pid a)
      (track! "r1" pid)
      (report! pid "r1")
      (let [real-get events/get-service-channel
            calls (atom 0)]
        (with-redefs [events/get-service-channel
                      (fn [p s]
                        (if (= 1 (swap! calls inc))
                          (let [r (real-get p s)]
                            (open! pid b)
                            r)
                          (real-get p s)))]
          (close! pid a)))
      (settle 300)
      (is (identical? b (events/get-service-channel pid "svc")))
      (is (nil? (ended "r1")))
      (is (= {} (held))))))

(deftest a-second-drop-gets-a-grace-of-its-own
  (fresh!)
  (with-grace 600
    (let [pid (create-project!) a (Object.) b (Object.)]
      (open! pid a)
      (track! "r1" pid)
      (report! pid "r1")
      (close! pid a)
      (Thread/sleep 300)
      (open! pid b)
      (close! pid b)
      (Thread/sleep 450)
      (is (nil? (ended "r1")) "the first close's timer finds its mark taken")
      (settle 300)
      (is (= "Service disconnected" (ended "r1"))))))

(deftest a-drop-of-many-projects-holds-each-on-its-own
  (fresh!)
  (with-grace 400
    (let [pids (vec (repeatedly 3 create-project!))
          chans (vec (repeatedly 3 #(Object.)))]
      (doseq [[i pid] (map-indexed vector pids)]
        (open! pid (chans i))
        (track! (str "r" i) pid)
        (report! pid (str "r" i)))
      (doseq [[i pid] (map-indexed vector pids)]
        (close! pid (chans i)))
      ;; Two of three come back.
      (open! (pids 0) (Object.))
      (open! (pids 1) (Object.))
      (settle 400)
      (is (nil? (ended "r0")))
      (is (nil? (ended "r1")))
      (is (= "Service disconnected" (ended "r2")))
      (is (= {} (held))))))

;; --- through the real channel handler ----------------------------------------

(def ^:private password "grace-owner-password")

(defn- token-req-fn [token]
  (fn [method path]
    (-> (mock/request method path)
        (mock/header "accept" "application/edn")
        (mock/header "Authorization" (str "Bearer " token)))))

(defn- writer!
  "A fresh writer on `pid`, and a session token for them."
  [pid email]
  (api-call admin-request {:method :post :path "/api/v1/users"
                           :body {:email email :password password :is-admin false}})
  (api-call admin-request {:method :post :path (str "/api/v1/projects/" pid "/writers/" email)})
  (-> (fix/rest-handler (-> (mock/request :post "/api/v1/login")
                            (mock/header "accept" "application/edn")
                            (mock/json-body {:user-id email :password password})))
      :body slurp read-string :token))

(defn- stub-channel [closed]
  (reify http-kit/Channel
    (open? [_] (not @closed))
    (websocket? [_] false)
    (close [_] (reset! closed true) true)
    (send! [_ _] (not @closed))
    (send! [_ _ _] (not @closed))
    (on-receive [_ _])
    (on-ping [_ _])
    (on-close [_ _])))

(defn- handler-open!
  "Open service `svc` on `pid` through the real route with `token` and
  `instance`. `mid-open` runs inside the open, between the registration and
  the adoption (where the seen-services row is written). Answers
  `{:channel :close!}`, `close!` running the channel's real `:on-close`."
  ([token pid instance] (handler-open! token pid instance nil))
  ([token pid instance mid-open]
   (let [closed (atom false)
         ch (stub-channel closed)
         callbacks (atom nil)
         record-seen! service-registry/record-seen!]
     (with-redefs [http-kit/as-channel (fn [_ cbs] (reset! callbacks cbs) {:status 200 :body ""})]
       (fix/rest-handler ((token-req-fn token) :get
                                               (str "/api/v1/projects/" pid "/services/svc/requests"
                                                    "?service-name=S&instance-id=" instance))))
     (let [{:keys [on-open on-close]} @callbacks
           close! #(on-close ch nil)]
       (with-redefs [service-registry/record-seen! (fn [& args]
                                                     (apply record-seen! args)
                                                     (when mid-open (mid-open close!)))]
         (on-open ch))
       {:channel ch :close! close!}))))

(defn- handler-track! [rid pid user]
  (let [entry (events/get-service-entry pid "svc")]
    (events/track-request! rid nil pid "svc" "user1@example.com" user
                           {:instance (:instance entry)})))

(deftest through-the-handler-a-close-then-reopen-keeps-the-request
  (fresh!)
  (with-grace 400
    (let [pid (create-project!)
          token (writer! pid "svc-a@example.com")
          as (token-req-fn token)
          {:keys [close!]} (handler-open! token pid "i1")]
      (handler-track! "r1" pid "svc-a@example.com")
      (is (= 200 (report! as pid "r1")))
      (close!)
      (is (nil? (events/get-service-channel pid "svc")))
      (is (= 200 (report! as pid "r1")) "a report in the gap")
      (let [{close-again! :close!} (handler-open! token pid "i1")]
        (settle 400)
        (is (nil? (ended "r1")))
        (is (some? (events/get-service-channel pid "svc")))
        (testing "and another process reopening ends it at once"
          (close-again!)
          (handler-open! token pid "i2")
          (is (= "Service disconnected" (ended "r1"))))))))

(deftest through-the-handler-a-close-during-the-open-strands-nothing
  ;; REV-SD-2 through the real handler: the reconnect's channel closes while
  ;; its open is between the registration and the adoption.
  (fresh!)
  (with-grace 400
    (let [pid (create-project!)
          token (writer! pid "svc-a@example.com")
          {:keys [close!]} (handler-open! token pid "i1")]
      (handler-track! "r1" pid "svc-a@example.com")
      (report! (token-req-fn token) pid "r1")
      (close!)
      (handler-open! token pid "i1" (fn [close-this!] (close-this!)))
      (is (nil? (events/get-service-channel pid "svc")))
      (settle 400)
      (is (= "Service disconnected" (ended "r1")))
      (is (= {} (held))))))

(deftest through-the-handler-a-lowered-standing-in-the-gap-ends-the-request-at-once
  (fresh!)
  (with-grace 5000
    (let [pid (create-project!)
          token (writer! pid "svc-a@example.com")
          {:keys [close!]} (handler-open! token pid "i1")]
      (handler-track! "r1" pid "svc-a@example.com")
      (report! (token-req-fn token) pid "r1")
      (close!)
      (is (nil? (ended "r1")))
      (api-call admin-request {:method :post :path (str "/api/v1/projects/" pid "/readers/svc-a@example.com")})
      (is (= "Service disconnected" (ended "r1")) "not at the grace: now")
      (is (= {} (held)))
      (is (= 403 (report! (token-req-fn token) pid "r1"))))))
