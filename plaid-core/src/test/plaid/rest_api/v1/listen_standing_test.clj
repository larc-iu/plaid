(ns plaid.rest-api.v1.listen-standing-test
  "A project's /listen stream is admitted when it opens. These tests pin
  that every write which takes away the right to open it (a revoked API
  token, a deactivated user, a logout, a lost role, a demoted admin, a
  deleted project) closes it before the write's response goes out, rather
  than when its heartbeats next go unanswered.

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

(defn with-listen-state-started [f]
  (mount/start #'plaid.server.events/client-registry
               #'plaid.server.events/channel-mappings
               #'plaid.server.events/heartbeat-registry)
  (f))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin
  with-test-users with-listen-state-started)
(use-fixtures :each with-clean-db)

(def ^:private password "listener-password")

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
                               :body {:name "Bug hunt fix SEC listen standing"}})
      :body :id))

(defn- grant! [pid role email]
  (api-call admin-request {:method :post :path (str "/api/v1/projects/" pid "/" role "/" email)}))

(defn- member!
  "A fresh user with `role` on `pid`, and a session token for them."
  [pid role email]
  (create-user! email false)
  (grant! pid role email)
  (session-of email))

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

(defn- listening? [ch]
  (contains? @events/channel-mappings ch))

(defn- open!
  "Open /listen on `pid` through the real route with `token`. Returns an atom
  that turns true when the server closes the stream."
  [token pid]
  (let [closed (atom false)
        ch (stub-channel closed)]
    (with-redefs [http-kit/as-channel (fn [_ {:keys [on-open]}]
                                        (on-open ch)
                                        {:status 200 :body ""})]
      (fix/rest-handler ((token-req-fn token) :get (str "/api/v1/projects/" pid "/listen"))))
    (is (listening? ch) "the stream opened")
    (is (not @closed))
    closed))

(defn- mint! [email]
  (:body (api-call admin-request {:method :post :path (str "/api/v1/users/" email "/tokens")
                                  :body {:name "listener"}})))

(deftest revoking-the-api-token-closes-its-stream
  (events/reset-state!)
  (let [pid (create-project!)
        _ (member! pid "readers" "lis-a@example.com")
        {token :token tid :id} (mint! "lis-a@example.com")
        closed (open! token pid)
        other-closed (open! (member! pid "readers" "lis-b@example.com") pid)]
    (is (= 204 (:status (api-call admin-request
                                  {:method :delete
                                   :path (str "/api/v1/users/lis-a@example.com/tokens/" tid)}))))
    (is @closed)
    (testing "another user's stream stays open"
      (is (not @other-closed)))))

(deftest deactivating-the-user-closes-their-streams
  (events/reset-state!)
  (let [pid (create-project!)
        session (member! pid "readers" "lis-a@example.com")
        {token :token} (mint! "lis-a@example.com")
        by-session (open! session pid)
        by-token (open! token pid)]
    (is (= 204 (:status (api-call admin-request {:method :delete
                                                 :path "/api/v1/users/lis-a@example.com"}))))
    (is @by-session)
    (is @by-token)))

(deftest losing-every-role-closes-the-stream
  (events/reset-state!)
  (let [pid (create-project!)]
    (testing "a reader removed from the project"
      (let [closed (open! (member! pid "readers" "lis-a@example.com") pid)]
        (api-call admin-request {:method :delete
                                 :path (str "/api/v1/projects/" pid "/readers/lis-a@example.com")})
        (is @closed)))
    (testing "a writer demoted to reader keeps it"
      (let [closed (open! (member! pid "writers" "lis-b@example.com") pid)]
        (grant! pid "readers" "lis-b@example.com")
        (is (not @closed))))))

(deftest a-demoted-admin-loses-a-stream-held-by-admin-standing
  (events/reset-state!)
  (let [pid (create-project!)
        _ (create-user! "lis-admin@example.com" true)
        closed (open! (session-of "lis-admin@example.com") pid)]
    (api-call admin-request {:method :patch :path "/api/v1/users/lis-admin@example.com"
                             :body {:is-admin false}})
    (is @closed)))

(deftest logging-out-closes-a-stream-opened-with-the-session
  (events/reset-state!)
  (let [pid (create-project!)
        session (member! pid "readers" "lis-a@example.com")
        {token :token} (mint! "lis-a@example.com")
        by-session (open! session pid)
        by-token (open! token pid)]
    (api-call (token-req-fn session) {:method :post :path "/api/v1/logout"})
    (is @by-session)
    (testing "an API token survives a logout, and so does its stream"
      (is (not @by-token)))))

(deftest deleting-the-project-closes-its-streams
  (events/reset-state!)
  (let [pid (create-project!)
        closed (open! (member! pid "readers" "lis-a@example.com") pid)
        _ (create-user! "lis-admin@example.com" true)
        by-admin (open! (session-of "lis-admin@example.com") pid)]
    (api-call admin-request {:method :delete :path (str "/api/v1/projects/" pid)})
    (is @closed)
    (is @by-admin)))

(deftest a-stream-whose-opener-lapses-before-it-registers-ends-closed
  ;; The route admits the credential in middleware, and the stream registers
  ;; later, when it opens. A write that lands in between finds no stream to
  ;; close, so the stream has to ask again once it is registered.
  (events/reset-state!)
  (let [pid (create-project!)
        _ (member! pid "readers" "lis-a@example.com")
        {token :token tid :id} (mint! "lis-a@example.com")
        closed (atom false)
        ch (stub-channel closed)]
    (with-redefs [http-kit/as-channel
                  (fn [_ {:keys [on-open]}]
                    (is (= 204 (:status (api-call admin-request
                                                  {:method :delete
                                                   :path (str "/api/v1/users/lis-a@example.com/tokens/" tid)}))))
                    (on-open ch)
                    {:status 200 :body ""})]
      (fix/rest-handler ((token-req-fn token) :get (str "/api/v1/projects/" pid "/listen"))))
    (is @closed)
    (is (not (listening? ch)))))

(deftest an-admin-listening-on-a-missing-project-is-refused
  ;; The privilege check lets an admin in on any project id, so the route
  ;; refuses a project that does not exist before the SSE headers go out,
  ;; rather than opening a stream that the standing check would close. An
  ;; unknown id answers 404 to an admin and 403 to anyone else, as on every
  ;; other route (the 2026-09-14 ruling).
  (events/reset-state!)
  (let [opened (atom false)
        missing (str (java.util.UUID/randomUUID))]
    (with-redefs [http-kit/as-channel (fn [_ _] (reset! opened true) {:status 200 :body ""})]
      (let [resp (fix/rest-handler (admin-request :get (str "/api/v1/projects/" missing "/listen")))]
        (is (= 404 (:status resp)))
        (is (not @opened)))
      (create-user! "lis-a@example.com" false)
      (let [resp (fix/rest-handler ((token-req-fn (session-of "lis-a@example.com"))
                                    :get (str "/api/v1/projects/" missing "/listen")))]
        (is (= 403 (:status resp)))
        (is (not @opened))))))

(deftest a-change-that-leaves-the-right-standing-keeps-the-stream
  (events/reset-state!)
  (let [p1 (create-project!)
        p2 (create-project!)]
    (testing "a reader of two projects removed from one keeps the other's stream"
      (let [session (member! p1 "readers" "lis-a@example.com")
            _ (grant! p2 "readers" "lis-a@example.com")
            on-p1 (open! session p1)
            on-p2 (open! session p2)]
        (api-call admin-request {:method :delete
                                 :path (str "/api/v1/projects/" p2 "/readers/lis-a@example.com")})
        (is @on-p2)
        (is (not @on-p1))))
    (testing "a maintainer demoted to reader keeps it"
      (let [closed (open! (member! p1 "maintainers" "lis-b@example.com") p1)]
        (grant! p1 "readers" "lis-b@example.com")
        (is (not @closed))))
    (testing "an admin with no role keeps it through someone else's role change"
      (create-user! "lis-admin@example.com" true)
      (let [closed (open! (session-of "lis-admin@example.com") p1)]
        (member! p1 "readers" "lis-c@example.com")
        (api-call admin-request {:method :delete
                                 :path (str "/api/v1/projects/" p1 "/readers/lis-c@example.com")})
        (is (not @closed))))
    (testing "a user updated without losing standing keeps it"
      (let [closed (open! (member! p1 "readers" "lis-d@example.com") p1)]
        (api-call admin-request {:method :patch :path "/api/v1/users/lis-d@example.com"
                                 :body {:display-name "Listener D"}})
        (is (not @closed))))))

(deftest a-closed-stream-leaves-nothing-registered
  (events/reset-state!)
  (let [pid (create-project!)
        closed (open! (member! pid "readers" "lis-a@example.com") pid)]
    (is (= 1 (count (events/get-project-clients pid))))
    (is (= 1 (count @events/heartbeat-registry)))
    (api-call admin-request {:method :delete
                             :path (str "/api/v1/projects/" pid "/readers/lis-a@example.com")})
    (is @closed)
    (is (empty? @events/channel-mappings))
    (is (empty? (events/get-project-clients pid)))
    (is (empty? @events/heartbeat-registry))))
