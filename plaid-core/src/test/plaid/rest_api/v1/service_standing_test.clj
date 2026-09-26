(ns plaid.rest-api.v1.service-standing-test
  "A service channel is admitted when it opens and never asked again by
  `wrap-read-jwt`. These tests pin that every write which takes away the
  right to hold one (a revoked API token, a deactivated user, a logout, a
  lost role, a demoted admin, a deleted project) closes it before the write's
  response goes out, and that a submit never pushes a request down a channel
  whose opener would no longer be let in.

  ring-mock cannot hold an SSE channel, so `http-kit/as-channel` is redefined
  to open the REAL handler onto a stub channel that records its close."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [mount.core :as mount]
            [org.httpkit.server :as http-kit]
            [plaid.fixtures :as fix
             :refer [with-db with-mount-states with-rest-handler with-admin
                     with-test-users with-clean-db api-call admin-request]]
            [plaid.server.events :as events]
            [ring.mock.request :as mock]))

(defn with-rpc-state-started [f]
  (mount/start #'plaid.server.events/service-channels
               #'plaid.server.events/inflight-requests)
  (f))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin
  with-test-users with-rpc-state-started)
(use-fixtures :each with-clean-db)

(def ^:private password "service-owner-password")

(defn- token-req-fn [token]
  (fn [method path]
    (-> (mock/request method path)
        (mock/header "accept" "application/edn")
        (mock/header "Authorization" (str "Bearer " token)))))

(defn- create-user! [email admin?]
  (api-call admin-request {:method :post :path "/api/v1/users"
                           :body {:email email :password password :is-admin admin?}}))

(defn- session-of [email]
  (-> (fix/rest-handler (-> (mock/request :post "/api/v1/login")
                            (mock/header "accept" "application/edn")
                            (mock/json-body {:user-id email :password password})))
      :body slurp read-string :token))

(defn- create-project! []
  (-> (api-call admin-request {:method :post :path "/api/v1/projects"
                               :body {:name "Bug hunt fix CORE service standing"}})
      :body :id))

(defn- grant! [pid role email]
  (api-call admin-request {:method :post :path (str "/api/v1/projects/" pid "/" role "/" email)}))

(defn- writer!
  "A fresh user who is a writer on `pid`, and a session token for them."
  [pid email]
  (create-user! email false)
  (grant! pid "writers" email)
  (session-of email))

(defn- stub-channel
  "An open channel that accepts writes until it is closed."
  [closed]
  (reify http-kit/Channel
    (open? [_] (not @closed))
    (websocket? [_] false)
    (close [_] (reset! closed true) true)
    (send! [_ _] (not @closed))
    (send! [_ _ _] (not @closed))
    (on-receive [_ _])
    (on-ping [_ _])
    (on-close [_ _])))

(defn- open!
  "Open service `sid` on `pid` through the real route with `token`. Returns
  an atom that turns true when the server closes the channel."
  [token pid sid]
  (let [closed (atom false)
        ch (stub-channel closed)]
    (with-redefs [http-kit/as-channel (fn [_ {:keys [on-open]}]
                                        (on-open ch)
                                        {:status 200 :body ""})]
      (fix/rest-handler ((token-req-fn token) :get
                                              (str "/api/v1/projects/" pid "/services/" sid
                                                   "/requests?service-name=" sid))))
    (is (= ch (events/get-service-channel pid sid)) "the channel opened")
    closed))

(defn- live? [pid sid]
  (some? (events/get-service-channel pid sid)))

(defn- mint! [email]
  (:body (api-call admin-request {:method :post :path (str "/api/v1/users/" email "/tokens")
                                  :body {:name "service"}})))

(deftest revoking-the-api-token-closes-its-channel
  (events/reset-state!)
  (let [pid (create-project!)
        _ (writer! pid "svc-a@example.com")
        {token :token tid :id} (mint! "svc-a@example.com")
        closed (open! token pid "svc")
        other-closed (open! (writer! pid "svc-b@example.com") pid "other")]
    (events/track-request! "req-1" (Object.) pid "svc" "svc-b@example.com")
    (is (= 204 (:status (api-call admin-request
                                  {:method :delete
                                   :path (str "/api/v1/users/svc-a@example.com/tokens/" tid)}))))
    (testing "the revoked token's channel is closed and gone from discovery"
      (is @closed)
      (is (not (live? pid "svc")))
      (is (not (some #(= "svc" (:service-id %)) (events/list-live-services pid)))))
    (testing "a request it was working on ends in an error"
      (is (= "error" (-> (events/get-request "req-1") :result :event))))
    (testing "another user's channel stays open"
      (is (not @other-closed))
      (is (live? pid "other")))))

(deftest deactivating-the-user-closes-their-channels
  (events/reset-state!)
  (let [pid (create-project!)
        session (writer! pid "svc-a@example.com")
        {token :token} (mint! "svc-a@example.com")
        by-session (open! session pid "one")
        by-token (open! token pid "two")]
    (is (= 204 (:status (api-call admin-request {:method :delete
                                                 :path "/api/v1/users/svc-a@example.com"}))))
    (is @by-session)
    (is @by-token)
    (is (empty? (events/list-live-services pid)))))

(deftest losing-the-writer-role-closes-the-channel
  (events/reset-state!)
  (let [pid (create-project!)]
    (testing "removed from the project"
      (let [closed (open! (writer! pid "svc-a@example.com") pid "svc")]
        (api-call admin-request {:method :delete
                                 :path (str "/api/v1/projects/" pid "/writers/svc-a@example.com")})
        (is @closed)
        (is (not (live? pid "svc")))))
    (testing "demoted to reader"
      (let [closed (open! (writer! pid "svc-b@example.com") pid "svc")]
        (grant! pid "readers" "svc-b@example.com")
        (is @closed)
        (is (not (live? pid "svc")))))
    (testing "a role change for someone else leaves it open"
      (let [closed (open! (writer! pid "svc-c@example.com") pid "svc")]
        (grant! pid "readers" "user1@example.com")
        (grant! pid "maintainers" "svc-c@example.com")
        (is (not @closed))
        (is (live? pid "svc"))))))

(deftest a-demoted-admin-loses-a-channel-held-by-admin-standing
  (events/reset-state!)
  (let [pid (create-project!)
        _ (create-user! "svc-admin@example.com" true)
        closed (open! (session-of "svc-admin@example.com") pid "svc")]
    (api-call admin-request {:method :patch :path "/api/v1/users/svc-admin@example.com"
                             :body {:is-admin false}})
    (is @closed)
    (is (not (live? pid "svc")))))

(deftest logging-out-closes-a-channel-opened-with-the-session
  (events/reset-state!)
  (let [pid (create-project!)
        session (writer! pid "svc-a@example.com")
        {token :token} (mint! "svc-a@example.com")
        by-session (open! session pid "one")
        by-token (open! token pid "two")]
    (api-call (token-req-fn session) {:method :post :path "/api/v1/logout"})
    (is @by-session)
    (testing "an API token survives a logout, and so does its channel"
      (is (not @by-token))
      (is (live? pid "two")))))

(deftest deleting-the-project-closes-its-channels
  (events/reset-state!)
  (let [pid (create-project!)
        closed (open! (writer! pid "svc-a@example.com") pid "svc")
        ;; An admin holds a channel on any project, so admin standing must
        ;; not outlive the project it was held on.
        _ (create-user! "svc-admin@example.com" true)
        {admin-token :token} (mint! "svc-admin@example.com")
        by-admin-session (open! (session-of "svc-admin@example.com") pid "admin-session")
        by-admin-token (open! admin-token pid "admin-token")]
    (api-call admin-request {:method :delete :path (str "/api/v1/projects/" pid)})
    (is @closed)
    (is (not (live? pid "svc")))
    (testing "channels an admin opened close too"
      (is @by-admin-session)
      (is @by-admin-token)
      (is (empty? (events/list-live-services pid))))))

(deftest a-channel-whose-opener-lapses-before-it-registers-ends-closed
  ;; The route admits the credential in middleware, and the channel registers
  ;; later, when it opens. A write that lands in between finds no channel to
  ;; close, so the channel has to ask again once it is registered.
  (events/reset-state!)
  (let [pid (create-project!)
        _ (writer! pid "svc-a@example.com")
        {token :token tid :id} (mint! "svc-a@example.com")
        closed (atom false)
        ch (stub-channel closed)]
    (with-redefs [http-kit/as-channel
                  (fn [_ {:keys [on-open]}]
                    (is (= 204 (:status (api-call admin-request
                                                  {:method :delete
                                                   :path (str "/api/v1/users/svc-a@example.com/tokens/" tid)}))))
                    (on-open ch)
                    {:status 200 :body ""})]
      (fix/rest-handler ((token-req-fn token) :get
                                              (str "/api/v1/projects/" pid "/services/svc/requests?service-name=svc"))))
    (is @closed)
    (is (not (live? pid "svc")))
    (is (not (some #(= "svc" (:service-id %)) (events/list-live-services pid))))))

(deftest a-submit-never-reaches-a-channel-whose-opener-lost-the-right
  ;; The writes above close the channel at once. A submit asks again, since
  ;; a delegating service is handed the requester's own token.
  (events/reset-state!)
  (let [pid (create-project!)
        _ (writer! pid "svc-a@example.com")
        {token :token tid :id} (mint! "svc-a@example.com")
        closed (open! token pid "svc")]
    (swap! events/service-channels assoc-in [pid "svc" :extras] {:delegation true})
    (with-redefs [events/standing-op-types #{}]
      (api-call admin-request {:method :delete
                               :path (str "/api/v1/users/svc-a@example.com/tokens/" tid)}))
    (is (not @closed) "no write closed it")
    (let [resp (api-call admin-request {:method :post
                                        :path (str "/api/v1/projects/" pid "/services/svc/requests")
                                        :body {:doc 1}})]
      (is (= 503 (:status resp)))
      (is @closed)
      (is (not (live? pid "svc"))))))
