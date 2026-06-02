(ns plaid.rest-api.v1.service-rpc-test
  "Tests for server-mediated service RPC (addressed; off the broadcast bus):
  the in-memory channel/in-flight routing helpers plus the non-streaming
  request paths (no-service 503, unknown-request 404, writer auth). The
  streaming SSE happy-path is exercised by the live Python E2E."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [mount.core :as mount]
            [plaid.fixtures :as fix
             :refer [with-db with-mount-states with-rest-handler with-admin
                     with-test-users with-clean-db api-call
                     admin-request user2-request]]
            [plaid.server.events :as events]))

(defn with-rpc-state-started
  "Start the ephemeral RPC defstates the test fixture chain otherwise leaves
  unstarted (mount isn't run by the fixtures)."
  [f]
  (mount/start #'plaid.server.events/service-registry
               #'plaid.server.events/service-channels
               #'plaid.server.events/inflight-requests)
  (f))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin
  with-test-users with-rpc-state-started)
(use-fixtures :each with-clean-db)

(defn- create-project! []
  (-> (api-call admin-request {:method :post :path "/api/v1/projects" :body {:name "svc-rpc-test"}})
      :body :id))

(defn- grant-reader! [pid email]
  (api-call admin-request {:method :post :path (str "/api/v1/projects/" pid "/readers/" email)}))

;; ---------------------------------------------------------------------------
;; In-memory routing helpers
;; ---------------------------------------------------------------------------

(deftest channel-helpers
  (events/reset-state!)
  (let [pid (random-uuid)
        ch (Object.)
        other (Object.)]
    (events/register-service-channel! pid "svc" ch)
    (is (= ch (events/get-service-channel pid "svc")))
    (testing "unregister only fires when the channel still matches (reconnect-safe)"
      (events/unregister-service-channel! pid "svc" other)
      (is (= ch (events/get-service-channel pid "svc")) "stale on-close must not clobber a reconnect")
      (events/unregister-service-channel! pid "svc" ch)
      (is (nil? (events/get-service-channel pid "svc"))))))

(deftest inflight-helpers
  (events/reset-state!)
  (let [pid (random-uuid)
        requester (Object.)]
    (events/track-request! "r1" requester pid "svc")
    (events/track-request! "r2" (Object.) pid "other")
    (is (= requester (:requester (events/get-request "r1"))))
    (is (= 1 (count (events/requests-for-service pid "svc"))))
    (is (= "r1" (ffirst (events/requests-for-service pid "svc"))))
    (is (= requester (:requester (events/resolve-request! "r1"))))
    (is (nil? (events/get-request "r1")) "resolved request is gone")
    (is (nil? (events/resolve-request! "r1")) "resolving twice is a no-op")))

(deftest reset-state-clears-rpc-maps
  (events/register-service-channel! (random-uuid) "svc" (Object.))
  (events/track-request! "rid" (Object.) (random-uuid) "svc")
  (events/reset-state!)
  (is (empty? @events/service-channels))
  (is (empty? @events/inflight-requests)))

;; ---------------------------------------------------------------------------
;; HTTP paths (non-streaming)
;; ---------------------------------------------------------------------------

(deftest submit-without-live-service-503
  (events/reset-state!)
  (let [pid (create-project!)
        resp (api-call admin-request {:method :post
                                      :path (str "/api/v1/projects/" pid "/services/ghost/requests")
                                      :body {:doc 1}})]
    (is (= 503 (:status resp)) "submitting to a project with no connected service fails fast")))

(deftest reply-to-unknown-request-404
  (let [pid (create-project!)
        resp (api-call admin-request {:method :post
                                      :path (str "/api/v1/projects/" pid "/service-requests/nope/events")
                                      :body {:status "progress" :progress {:percent 10}}})]
    (is (= 404 (:status resp)) "reporting against an unknown/expired request is a 404")))

(deftest submit-requires-writer
  (let [pid (create-project!)]
    (grant-reader! pid "user2@example.com")
    (let [resp (api-call user2-request {:method :post
                                        :path (str "/api/v1/projects/" pid "/services/x/requests")
                                        :body {:doc 1}})]
      (is (= 403 (:status resp)) "a reader cannot submit work (writer required)"))))
