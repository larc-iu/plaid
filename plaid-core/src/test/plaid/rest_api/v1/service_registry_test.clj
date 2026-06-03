(ns plaid.rest-api.v1.service-registry-test
  "Tests for the in-memory service registry surface
  (`/api/v1/projects/:id/services`): register/heartbeat, synchronous listing,
  unregister, lazy TTL expiry, and reader-vs-writer auth. The registry is
  ephemeral in-memory state — it is deliberately NOT persisted or audit-logged."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [mount.core :as mount]
            [plaid.fixtures :as fix
             :refer [with-db with-mount-states with-rest-handler with-admin
                     with-test-users with-clean-db api-call
                     admin-request user1-request user2-request]]
            [plaid.server.events :as events]
            [plaid.sql.common :as psc]))

(defn with-service-registry-started
  "The service registry + channel maps are mount `defstate`s; the production
  server starts them via `mount/start`, but the test fixture chain doesn't run
  mount, so start them here. `service-channels` is needed because discovery now
  gates on an open request channel."
  [f]
  (mount/start #'plaid.server.events/service-registry
               #'plaid.server.events/service-channels)
  (f))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin
  with-test-users with-service-registry-started)
(use-fixtures :each with-clean-db)

;; ---------------------------------------------------------------------------
;; Helpers
;; ---------------------------------------------------------------------------

(defn- create-project! []
  (-> (api-call admin-request {:method :post
                               :path "/api/v1/projects"
                               :body {:name "svc-reg-test"}})
      :body :id))

(defn- grant-writer! [pid email]
  (api-call admin-request {:method :post
                           :path (str "/api/v1/projects/" pid "/writers/" email)}))

(defn- grant-reader! [pid email]
  (api-call admin-request {:method :post
                           :path (str "/api/v1/projects/" pid "/readers/" email)}))

(defn- register! [user-fn pid info]
  (api-call user-fn {:method :post
                     :path (str "/api/v1/projects/" pid "/services")
                     :body info}))

(defn- list! [user-fn pid]
  (api-call user-fn {:method :get
                     :path (str "/api/v1/projects/" pid "/services")}))

(defn- unregister! [user-fn pid service-id]
  (api-call user-fn {:method :delete
                     :path (str "/api/v1/projects/" pid "/services/" service-id)}))

(defn- open-channel!
  "Simulate a service's open request channel so it passes discovery's
  channel-open gate (`list-live-services` lists only services with one).
  ring-mock can't hold a real SSE channel, so inject a placeholder."
  [pid service-id]
  (swap! events/service-channels assoc-in [pid service-id] ::fake-channel))

(def ^:private stanza
  {:service-id "stanza" :service-name "Stanza" :description "Parser"
   :extras {:lang "en"}})

;; ---------------------------------------------------------------------------
;; Tests
;; ---------------------------------------------------------------------------

(deftest register-list-and-shape
  (let [pid (create-project!)]
    (grant-writer! pid "user1@example.com")
    (grant-reader! pid "user2@example.com")
    (testing "a writer can register a service; response advises a heartbeat interval"
      (let [resp (register! user1-request pid stanza)]
        (fix/assert-ok resp)
        (is (true? (-> resp :body :success)))
        (is (pos? (-> resp :body :ttl-ms)))
        (is (= (quot (-> resp :body :ttl-ms) 3) (-> resp :body :heartbeat-interval-ms)))))
    (open-channel! pid "stanza")  ; discovery requires an open request channel
    (testing "a reader sees the live service, shaped to public fields only"
      (let [resp (list! user2-request pid)
            entry (first (:body resp))]
        (fix/assert-ok resp)
        (is (= 1 (count (:body resp))))
        (is (= "stanza" (:service-id entry)))
        (is (= "Stanza" (:service-name entry)))
        (is (= {:lang "en"} (:extras entry)))
        ;; internal bookkeeping must not leak to clients
        (is (not (contains? entry :user-id)))
        (is (not (contains? entry :last-seen)))))))

(deftest reregister-refreshes-presence
  (let [pid (create-project!)]
    (grant-writer! pid "user1@example.com")
    (register! user1-request pid stanza)
    (open-channel! pid "stanza")
    (let [before (get-in @events/service-registry [pid "stanza" :last-seen])]
      ;; Backdate, then re-register: last-seen should advance past the old value.
      (swap! events/service-registry assoc-in [pid "stanza" :last-seen] (- before 10000))
      (register! user1-request pid stanza)
      (let [after (get-in @events/service-registry [pid "stanza" :last-seen])]
        (is (>= after before) "re-registration refreshes last-seen (heartbeat)")
        (is (= 1 (count (:body (list! user1-request pid)))))))))

(deftest unregister-removes-service
  (let [pid (create-project!)]
    (grant-writer! pid "user1@example.com")
    (register! user1-request pid stanza)
    (open-channel! pid "stanza")
    (is (= 1 (count (:body (list! user1-request pid)))))
    (testing "a writer can unregister; the service disappears from the listing"
      (let [resp (unregister! user1-request pid "stanza")]
        (fix/assert-ok resp)
        (is (true? (-> resp :body :success)))
        (is (empty? (:body (list! user1-request pid))))))))

(deftest stale-services-are-reaped-on-read
  (let [pid (create-project!)]
    (grant-writer! pid "user1@example.com")
    (register! user1-request pid stanza)
    (testing "an entry older than the TTL is omitted AND evicted from the atom on read"
      (let [ttl (:ttl-ms (events/service-registry-config))]
        (swap! events/service-registry assoc-in [pid "stanza" :last-seen]
               (- (System/currentTimeMillis) ttl 1000))
        (is (empty? (:body (list! user1-request pid))))
        (is (not (contains? @events/service-registry pid))
            "the project key is dropped once its last service is reaped")))))

(deftest discovery-requires-open-channel
  ;; Regression: a service that registered (or whose heartbeat re-registered it
  ;; on a fresh server) but whose request channel is not open must NOT be listed
  ;; as available — otherwise discovery says "reachable" while requests 503.
  (let [pid (create-project!)]
    (grant-writer! pid "user1@example.com")
    (register! user1-request pid stanza)
    (testing "registered but no open channel → hidden from discovery"
      (is (empty? (:body (list! user1-request pid)))))
    (testing "opening the channel makes it discoverable; dropping it hides it again"
      (open-channel! pid "stanza")
      (is (= 1 (count (:body (list! user1-request pid)))))
      (swap! events/service-channels update pid dissoc "stanza")
      (is (empty? (:body (list! user1-request pid)))
          "a dropped channel (registry entry still fresh) is no longer listed"))))

(deftest auth-writer-required-to-register
  (let [pid (create-project!)]
    (grant-reader! pid "user2@example.com")
    (testing "a reader cannot register a service"
      (fix/assert-forbidden (register! user2-request pid stanza)))
    (testing "a reader cannot unregister a service"
      (fix/assert-forbidden (unregister! user2-request pid "stanza")))))

(deftest auth-reader-required-to-list
  (let [pid (create-project!)]
    (grant-writer! pid "user1@example.com")
    (register! user1-request pid stanza)
    (testing "a non-member cannot list services"
      ;; user2 has no role on the project
      (fix/assert-forbidden (list! user2-request pid)))))

(deftest registry-not-audit-logged
  (let [pid (create-project!)]
    (grant-writer! pid "user1@example.com")
    (let [count-audits #(-> (psc/q1 fix/db ["SELECT COUNT(*) AS c FROM audit_writes"]) :c)
          before (count-audits)]
      (register! user1-request pid stanza)
      (list! user1-request pid)
      (unregister! user1-request pid "stanza")
      (is (= before (count-audits))
          "register/list/unregister must not write any audit rows"))))
