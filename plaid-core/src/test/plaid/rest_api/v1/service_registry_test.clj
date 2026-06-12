(ns plaid.rest-api.v1.service-registry-test
  "Tests for service presence + discovery. Presence is an OPEN request channel:
  recording a service is `register-service-channel!` (channel + metadata).
  Discovery (`GET /projects/:id/services`) merges those live entries with the
  persistent seen_services rows (upserted on registration, unaudited), so
  previously-seen offline services appear with `:online false` and a
  last-seen stamp. Duplicate live registration of a service-id is rejected
  (409 / :conflict) unless the held channel is dead — then the newcomer takes
  over (reconnect-after-blip safety)."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [mount.core :as mount]
            [plaid.fixtures :as fix
             :refer [with-db with-mount-states with-rest-handler with-admin
                     with-test-users with-clean-db api-call
                     admin-request user2-request]]
            [plaid.server.events :as events]
            [plaid.sql.service-registry :as service-registry]
            [org.httpkit.server :as http-kit]))

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

(defn- discard! [user-fn pid service-id]
  (api-call user-fn {:method :delete :path (str "/api/v1/projects/" pid "/services/" service-id)}))

(defn- live-ch
  "A channel stub that probes alive (open, accepts writes)."
  []
  (reify http-kit/Channel
    (open? [_] true)
    (send! [_ _] true)
    (send! [_ _ _] true)))

(defn- dead-ch
  "A channel stub the server hasn't closed yet but whose peer is gone."
  []
  (reify http-kit/Channel
    (open? [_] false)
    (send! [_ _] false)
    (send! [_ _ _] false)))

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
        (is (true? (:online entry)))
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

;; ---------------------------------------------------------------------------
;; Liveness probe + duplicate-registration guard (events level)
;; ---------------------------------------------------------------------------

(deftest channel-liveness-probe
  (is (false? (events/channel-alive? nil)))
  (is (false? (events/channel-alive? (Object.)))
      "a non-channel (or any probe explosion) counts as dead, never throws")
  (is (true? (events/channel-alive? (live-ch))))
  (is (false? (events/channel-alive? (dead-ch)))))

(deftest duplicate-registration-guard
  (events/reset-state!)
  (testing "a second live registration of the same service-id conflicts"
    (let [pid (random-uuid)
          ch1 (live-ch)
          ch2 (live-ch)]
      (is (= :registered (events/try-register-service-channel! pid "svc" ch1 {:service-name "S"} "u1")))
      (is (= :conflict (events/try-register-service-channel! pid "svc" ch2 {:service-name "S2"} "u2")))
      (is (= ch1 (events/get-service-channel pid "svc"))
          "the loser must not replace the live holder")))
  (testing "a dead-but-unclosed channel is taken over (reconnect after a blip)"
    (let [pid (random-uuid)
          stale (dead-ch)
          fresh (live-ch)]
      (events/register-service-channel! pid "svc" stale {:service-name "S"} "u1")
      (is (= :registered (events/try-register-service-channel! pid "svc" fresh {:service-name "S"} "u1")))
      (is (= fresh (events/get-service-channel pid "svc")))))
  (testing "re-registering the same channel is idempotent, not a conflict"
    (let [pid (random-uuid)
          ch (live-ch)]
      (is (= :registered (events/try-register-service-channel! pid "svc" ch {:service-name "S"} "u1")))
      (is (= :registered (events/try-register-service-channel! pid "svc" ch {:service-name "S"} "u1"))))))

(deftest duplicate-registration-409-over-rest
  (events/reset-state!)
  (let [pid (create-project!)]
    ;; A live channel holds the id; the REST pre-check must reject before
    ;; opening the SSE stream. (The success path needs a real http-kit server
    ;; and is covered by the live client E2E.)
    (events/register-service-channel! pid "svc" (live-ch) {:service-name "S"} "u1")
    (let [resp (api-call admin-request {:method :get
                                        :path (str "/api/v1/projects/" pid "/services/svc/requests")})]
      (is (= 409 (:status resp))))))

;; ---------------------------------------------------------------------------
;; Persistent seen-services registry
;; ---------------------------------------------------------------------------

(deftest seen-row-upsert-and-delete
  (let [pid (create-project!)]
    (service-registry/record-seen! fix/db pid "svc"
                                   {:service-name "A" :description "d1" :extras-json "{\"v\": 1}"})
    (testing "re-registration upserts (no duplicate row, metadata refreshed)"
      (service-registry/record-seen! fix/db pid "svc"
                                     {:service-name "B" :description "d2" :extras-json "{\"v\": 2}"})
      (let [rows (service-registry/list-seen fix/db pid)]
        (is (= 1 (count rows)))
        (is (= "B" (:service-name (first rows))))
        (is (= "d2" (:description (first rows))))
        (is (= {:v 2} (:extras (first rows))))
        (is (string? (:last-seen-at (first rows))))))
    (testing "delete-seen! reports whether a row was removed"
      (is (= 1 (service-registry/delete-seen! fix/db pid "svc")))
      (is (= 0 (service-registry/delete-seen! fix/db pid "svc")))
      (is (empty? (service-registry/list-seen fix/db pid))))))

(deftest merged-discovery
  (events/reset-state!)
  (let [pid (create-project!)]
    (grant-reader! pid "user2@example.com")
    ;; A service that registered in the past but is offline now.
    (service-registry/record-seen! fix/db pid "old-svc"
                                   {:service-name "Old" :description "Gone"
                                    :extras-json "{\"tasks\": [\"parse\"]}"})
    (testing "offline seen services are listed with online false + last-seen"
      (let [body (:body (list! user2-request pid))
            entry (first body)]
        (is (= ["old-svc"] (mapv :service-id body)))
        (is (false? (:online entry)))
        (is (string? (:last-seen-at entry)))
        (is (= {:tasks ["parse"]} (:extras entry))
            "persisted extras parse to the same shape a live entry carries")))
    (testing "live + seen merge, live metadata wins, sorted by service-id"
      ;; same id live AND seen: live entry's (newer) metadata should win
      (service-registry/record-seen! fix/db pid "stanza"
                                     {:service-name "Stale name" :description "stale"
                                      :extras-json "{\"lang\": \"de\"}"})
      (events/register-service-channel! pid "stanza" (live-ch)
                                        {:service-name "Stanza" :description "Parser" :extras {:lang "en"}}
                                        "u1")
      (let [body (:body (list! user2-request pid))
            by-id (into {} (map (juxt :service-id identity)) body)]
        (is (= ["old-svc" "stanza"] (mapv :service-id body)))
        (is (false? (:online (by-id "old-svc"))))
        (is (true? (:online (by-id "stanza"))))
        (is (= "Stanza" (:service-name (by-id "stanza"))) "live metadata wins over the stored snapshot")
        (is (= {:lang "en"} (:extras (by-id "stanza"))))
        (is (string? (:last-seen-at (by-id "stanza"))) "live entry still reports the stored stamp")))))

(deftest discard-seen-service
  (events/reset-state!)
  (let [pid (create-project!)]
    (grant-reader! pid "user2@example.com")
    (service-registry/record-seen! fix/db pid "old-svc"
                                   {:service-name "Old" :description "x" :extras-json nil})
    (testing "maintainer required"
      (fix/assert-forbidden (discard! user2-request pid "old-svc")))
    (testing "409 while a live channel holds the id"
      (events/register-service-channel! pid "old-svc" (live-ch) {:service-name "Old"} "u1")
      (is (= 409 (:status (discard! admin-request pid "old-svc")))))
    (testing "204 once offline, then 404"
      (events/unregister-service-channel! pid "old-svc" (events/get-service-channel pid "old-svc"))
      (is (= 204 (:status (discard! admin-request pid "old-svc"))))
      (is (= 404 (:status (discard! admin-request pid "old-svc"))))
      (is (empty? (:body (list! admin-request pid)))))))

(deftest project-delete-cascades-seen-rows
  (let [pid (create-project!)]
    (service-registry/record-seen! fix/db pid "svc"
                                   {:service-name "S" :description nil :extras-json nil})
    (is (= 1 (count (service-registry/list-seen fix/db pid))))
    (fix/assert-no-content (api-call admin-request {:method :delete :path (str "/api/v1/projects/" pid)}))
    (is (empty? (service-registry/list-seen fix/db pid))
        "seen_services rows ride the projects FK cascade")))
