(ns plaid.rest-api.v1.service-registry-test
  "Tests for service presence + discovery. Presence is an OPEN request channel:
  recording a service is `register-service-channel!` (channel + metadata), and
  discovery (`GET /projects/:id/services`) lists those — shaped to public
  fields. There is no separate registry, TTL, or heartbeat. Ephemeral in-memory
  state, not persisted or audit-logged."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [mount.core :as mount]
            [plaid.fixtures :as fix
             :refer [with-db with-mount-states with-rest-handler with-admin
                     with-test-users with-clean-db api-call
                     admin-request user2-request]]
            [plaid.server.events :as events]))

(defn with-rpc-state-started
  "Start the ephemeral service-channels defstate (the fixture chain doesn't run
  mount). list-live-services derefs it."
  [f]
  (mount/start #'plaid.server.events/service-channels
               #'plaid.server.events/inflight-requests)
  (f))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin
  with-test-users with-rpc-state-started)
(use-fixtures :each with-clean-db)

(defn- create-project! []
  (-> (api-call admin-request {:method :post :path "/api/v1/projects" :body {:name "svc-disc-test"}})
      :body :id))

(defn- grant-reader! [pid email]
  (api-call admin-request {:method :post :path (str "/api/v1/projects/" pid "/readers/" email)}))

(defn- list! [user-fn pid]
  (api-call user-fn {:method :get :path (str "/api/v1/projects/" pid "/services")}))

;; ---------------------------------------------------------------------------
;; Presence helpers (events level)
;; ---------------------------------------------------------------------------

(deftest presence-helpers
  (events/reset-state!)
  (let [pid (random-uuid)
        ch (Object.)
        other (Object.)]
    (events/register-service-channel! pid "stanza" ch
                                      {:service-name "Stanza" :description "Parser" :extras {:lang "en"}}
                                      "u1")
    (testing "the channel is reachable and the service is listed as public metadata"
      (is (= ch (events/get-service-channel pid "stanza")))
      (is (= [{:service-id "stanza" :service-name "Stanza" :description "Parser" :extras {:lang "en"}}]
             (events/list-live-services pid))))
    (testing "unregister is reconnect-safe (only removes when the channel matches)"
      (events/unregister-service-channel! pid "stanza" other)
      (is (= ch (events/get-service-channel pid "stanza")) "stale on-close must not clobber a reconnect")
      (events/unregister-service-channel! pid "stanza" ch)
      (is (nil? (events/get-service-channel pid "stanza")))
      (is (empty? (events/list-live-services pid))
          "closing the (only) channel deregisters the service"))))

;; ---------------------------------------------------------------------------
;; Discovery endpoint
;; ---------------------------------------------------------------------------

(deftest discovery-lists-connected-services
  (let [pid (create-project!)]
    (grant-reader! pid "user2@example.com")
    (testing "no connected service → empty"
      (fix/assert-ok (list! user2-request pid))
      (is (empty? (:body (list! user2-request pid)))))
    (testing "a connected service is listed, shaped to public fields only"
      (events/register-service-channel! pid "stanza" (Object.)
                                        {:service-name "Stanza" :description "Parser" :extras {:lang "en"}}
                                        "admin@example.com")
      (let [resp (list! user2-request pid)
            entry (first (:body resp))]
        (fix/assert-ok resp)
        (is (= 1 (count (:body resp))))
        (is (= "stanza" (:service-id entry)))
        (is (= "Stanza" (:service-name entry)))
        (is (= {:lang "en"} (:extras entry)))
        ;; internal bookkeeping must not leak to clients
        (is (not (contains? entry :channel)))
        (is (not (contains? entry :user-id)))))
    (testing "deregistering removes it from discovery"
      (events/unregister-service-channel! pid "stanza"
                                          (events/get-service-channel pid "stanza"))
      (is (empty? (:body (list! user2-request pid)))))))

(deftest discovery-requires-reader
  (let [pid (create-project!)]
    ;; user2 has no role on the project
    (testing "a non-member cannot list services"
      (fix/assert-forbidden (list! user2-request pid)))))
