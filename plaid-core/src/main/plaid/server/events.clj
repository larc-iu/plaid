(ns plaid.server.events
  "Real-time event distribution system for audit log events.
   
   ## Architecture Overview
   
   This namespace implements a Server-Sent Events (SSE) based real-time event 
   system that allows clients to subscribe to audit log events for specific 
   projects. The flow is:
   
   1. Clients connect via SSE to /projects/:id/events endpoint
   2. The SSE handler registers the client for that project
   3. When database operations occur, audit events are published to the event bus
   4. The event distributor forwards events to all registered clients for affected projects
   5. Clients receive real-time updates about changes to their projects
   
   ## Key Components
   
   - **Client Registry**: Maps project IDs to sets of client channels
   - **Channel Mappings**: Maps HTTP-kit channels to client info for cleanup
   - **Event Bus**: Core.async channel that receives all audit events
   - **Event Distributor**: Background process that routes events to clients"
  (:require [clojure.core.async :as async]
            [mount.core :refer [defstate] :as mount]
            [taoensso.timbre :as log]
            [clojure.instant :as instant]
            [clojure.string :as str]
            [plaid.server.config :refer [config]]
            [org.httpkit.server :as http-kit]))

;; =============================================================================
;; Configuration
;; =============================================================================

(defn heartbeat-config []
  "Get heartbeat configuration from global config"
  (get config :plaid.server.events/heartbeat
       {:interval-ms            30000
        :max-consecutive-misses 2}))

;; =============================================================================
;; Client Subscription Management
;; =============================================================================

;; Client registry maps project-id -> #{client-channels}
;; This allows us to efficiently find all clients interested in a specific project
(defstate client-registry
  :start (atom {})
  :stop (reset! client-registry {}))

;; Channel mappings for lifecycle management  
;; Maps http-kit-channel -> {:client-chan chan :project-id id :stop-chan chan :client-id id}
;; This allows us to clean up resources when an SSE connection closes
(defstate channel-mappings
  :start (atom {})
  :stop (reset! channel-mappings {}))

;; Heartbeat tracking maps client-id -> {:project-id id :last-heartbeat timestamp}
;; This tracks when clients last confirmed they're alive via /heartbeat endpoint
(defstate heartbeat-registry
  :start (atom {})
  :stop (reset! heartbeat-registry {}))

;; Connected services: project-id -> {service-id -> entry}, where an entry is
;; {:channel <http-kit channel> :service-id :service-name :description :extras
;; :user-id}. The SERVICE's open inbound SSE channel IS its registration: a
;; service is present exactly while this channel is open. Discovery lists these
;; entries; routing pushes a request down :channel. There is no separate
;; registry, TTL, or heartbeat — opening the channel registers, closing it
;; deregisters, so presence can never diverge from reachability. Distinct from
;; the broadcast bus (client-registry / event-bus): a request goes to exactly
;; one service, never fanned out. Ephemeral, not persisted, not audit-logged.
(defstate service-channels
  :start (atom {})
  :stop (reset! service-channels {}))

;; In-flight server-mediated RPC requests: request-id -> {:requester <http-kit
;; channel> :project-id :service-id}. Lets the server route a service's reply
;; events (progress/result/error) back to ONLY the client that made the
;; request. Cleared when the request resolves or either side disconnects.
(defstate inflight-requests
  :start (atom {})
  :stop (reset! inflight-requests {}))

(defn register-client!
  "Register a client channel to receive events for a specific project.
   Called when an SSE connection is established."
  [project-id client-chan]
  (swap! client-registry update project-id (fnil conj #{}) client-chan)
  (log/debug "Registered client for project" project-id))

(defn unregister-client!
  "Remove a client channel from receiving events for a project.
   Called during channel cleanup when SSE connection closes."
  [project-id client-chan]
  (swap! client-registry update project-id disj client-chan)
  (when (empty? (get @client-registry project-id))
    (swap! client-registry dissoc project-id))
  (log/debug "Unregistered client for project" project-id))

(defn get-project-clients
  "Get all client channels currently subscribed to a specific project."
  [project-id]
  (get @client-registry project-id #{}))

(defn get-client-count
  "Get the total number of clients currently registered across all projects."
  []
  (reduce + (map count (vals @client-registry))))

(defn register-client-with-id!
  "Register a client with a unique client ID for heartbeat tracking.
   Returns the generated client-id."
  [project-id client-chan]
  (let [client-id (str (java.util.UUID/randomUUID))]
    (register-client! project-id client-chan)
    (swap! heartbeat-registry assoc client-id {:project-id     project-id
                                               :last-heartbeat (System/currentTimeMillis)})
    (log/debug "Registered client with ID" client-id "for project" project-id)
    client-id))

(defn record-heartbeat!
  "Record a heartbeat from a client. Returns true if client exists, false otherwise."
  [project-id client-id]
  (if-let [client-info (get @heartbeat-registry client-id)]
    (if (= (:project-id client-info) project-id)
      (do
        (swap! heartbeat-registry assoc-in [client-id :last-heartbeat] (System/currentTimeMillis))
        (log/debug "Recorded heartbeat for client" client-id "on project" project-id)
        true)
      (do
        (log/warn "Client" client-id "heartbeat for wrong project:" project-id "vs" (:project-id client-info))
        false))
    (do
      (log/warn "Heartbeat for unknown client" client-id)
      false)))

(defn register-channel-mapping!
  "Register the relationship between an http-kit channel and its associated
   client channel, project, stop channel, and client ID. This enables proper cleanup
   when the SSE connection closes."
  [http-channel client-chan project-id stop-chan client-id]
  (swap! channel-mappings assoc http-channel {:client-chan client-chan
                                              :project-id  project-id
                                              :stop-chan   stop-chan
                                              :client-id   client-id})
  (log/debug "Registered channel mapping for client" client-id "on project" project-id))

(defn cleanup-channel!
  "Clean up all resources associated with a closed SSE connection.
   This includes:
   - Closing the stop channel to signal any associated go-loops
   - Unregistering the client from the project
   - Closing the client channel
   - Removing the client from heartbeat registry
   - Removing the channel mapping"
  [http-channel]
  (when-let [{:keys [client-chan project-id stop-chan client-id]} (get @channel-mappings http-channel)]
    (log/debug "Cleaning up channel for client" client-id "on project" project-id)
    (try
      ;; Signal shutdown to any associated go-loops
      (when stop-chan
        (async/close! stop-chan))
      ;; Remove client from project subscription
      (unregister-client! project-id client-chan)
      ;; Remove from heartbeat registry
      (when client-id
        (swap! heartbeat-registry dissoc client-id))
      ;; Close the client channel
      (async/close! client-chan)
      ;; Close the http-kit channel to free server resources
      (http-kit/close http-channel)
      (catch Exception e
        (log/warn e "Error during channel cleanup")))
    (swap! channel-mappings dissoc http-channel)))

;; =============================================================================
;; Connected services (presence = open request channel) + RPC routing
;; =============================================================================
;;
;; Presence is derived entirely from the open request channel: a service is
;; "connected" exactly while its SSE channel (opened at GET
;; /projects/:id/services/:sid/requests) is held. Opening it registers the
;; service + its discovery metadata; closing it deregisters. There is no
;; separate registry, TTL, or heartbeat to drift out of sync. These helpers
;; only manage state — SSE framing / http-kit send! / close live in the route
;; handlers (plaid.rest-api.v1.message), mirroring how the audit distributor
;; leaves framing to the /listen handler.

(defn register-service-channel!
  "Record a connected service: its open inbound request channel plus its
  discovery metadata. Opening the channel IS registration. `info` is a map of
  {:service-name :description :extras}. Returns nil."
  [project-id service-id channel info user-id]
  (let [entry (merge (select-keys info [:service-name :description :extras])
                     {:channel    channel
                      :service-id service-id
                      :user-id    user-id})]
    (swap! service-channels assoc-in [project-id service-id] entry)
    (log/debug "Service connected:" service-id "on project" project-id)
    nil))

(defn channel-alive?
  "Best-effort liveness probe for a service's held channel: open AND able to
  accept a write (an SSE comment, invisible to the service). The write probe
  catches channels whose peer vanished without a FIN — `send!` returns false
  once http-kit knows the connection is dead — which is what lets a service
  reconnect after a network blip take over its own half-dead registration
  instead of 409ing against it. Limitation: a half-open TCP connection can
  pass this probe until the OS notices; worst case re-registration is blocked
  until the 25s keepalive write fails and closes the stale channel."
  [channel]
  (boolean
   (and channel
        (try
          (and (http-kit/open? channel)
               (http-kit/send! channel ": probe\n\n" false))
          (catch Exception _ false)))))

(def ^:private service-registration-lock
  "Serializes registration check-then-install so two simultaneous
  registrations of the same service-id can't both pass the conflict check.
  Registration is rare (service startup / reconnect), so a coarse monitor is
  fine; the liveness probe is impure and can't live inside a swap! fn."
  (Object.))

(defn try-register-service-channel!
  "Register a service unless another LIVE channel already holds its
  service-id on this project. Returns :registered (also when taking over a
  dead-but-not-yet-closed channel) or :conflict. See `channel-alive?` for the
  takeover semantics."
  [project-id service-id channel info user-id]
  (locking service-registration-lock
    (let [existing (get-in @service-channels [project-id service-id :channel])]
      (if (and existing
               (not= existing channel)
               (channel-alive? existing))
        :conflict
        (do (register-service-channel! project-id service-id channel info user-id)
            :registered)))))

(defn unregister-service-channel!
  "Deregister a connected service (its channel closed), but only if it still
  maps to `channel` — so a reconnect that already replaced the entry isn't
  clobbered by the old connection's on-close. Drops the project key when its
  last service is gone."
  [project-id service-id channel]
  (swap! service-channels
         (fn [svcs]
           (if (= channel (get-in svcs [project-id service-id :channel]))
             (let [svcs' (update svcs project-id dissoc service-id)]
               (if (empty? (get svcs' project-id))
                 (dissoc svcs' project-id)
                 svcs'))
             svcs)))
  (log/debug "Service disconnected:" service-id "on project" project-id)
  nil)

(defn get-service-channel
  "The open inbound channel for a service, or nil if none is connected."
  [project-id service-id]
  (get-in @service-channels [project-id service-id :channel]))

(defn list-live-services
  "Discovery: the connected services on a project as public metadata maps
  {:service-id :service-name :description :extras}, ordered by service-id. A
  service appears exactly while its request channel is open — there is no
  separate registry to drift out of sync."
  [project-id]
  (->> (vals (get @service-channels project-id {}))
       (map #(select-keys % [:service-id :service-name :description :extras]))
       (sort-by :service-id)
       vec))

(defn track-request!
  "Record an in-flight RPC so the service's reply events can be routed back to
  `requester-channel`."
  [request-id requester-channel project-id service-id]
  (swap! inflight-requests assoc request-id {:requester  requester-channel
                                             :project-id project-id
                                             :service-id service-id})
  nil)

(defn get-request
  "The in-flight request entry for `request-id`, or nil."
  [request-id]
  (get @inflight-requests request-id))

(defn resolve-request!
  "Remove an in-flight request (it completed, errored, or its requester left).
  Returns the removed entry, or nil if it was already gone."
  [request-id]
  (let [entry (get @inflight-requests request-id)]
    (swap! inflight-requests dissoc request-id)
    entry))

(defn requests-for-service
  "All in-flight [request-id entry] pairs routed to a given service — used to
  fail them when that service's channel drops."
  [project-id service-id]
  (filter (fn [[_ {p :project-id s :service-id}]]
            (and (= p project-id) (= s service-id)))
          @inflight-requests))

;; =============================================================================
;; Helper Functions
;; =============================================================================

(defn op-type-to-string
  "Convert operation type keyword to snake_cased string format 'namespace:name'.
   This ensures consistent formatting for operation types sent to clients.
   
   Example: :text/create -> \"text:create\"
            :token-layer/update -> \"token_layer:update\""
  [op-type-kw]
  (when op-type-kw
    (let [ns-part (-> (namespace op-type-kw)
                      (str/replace #"-" "_"))
          name-part (-> (name op-type-kw)
                        (str/replace #"-" "_"))]
      (str ns-part ":" name-part))))

;; =============================================================================
;; Event Publishing and Distribution
;; =============================================================================

;; Counter for events dropped because the event bus buffer was full.
;; Public so /health (and tests / future metrics surfaces) can read it.
(defonce event-bus-drop-count (atom 0))

(defn get-drop-count
  "Return the current count of events dropped because the event bus buffer
  was full. Exposed for the /health endpoint + metrics surfaces; callers
  that want the atom itself can still deref `event-bus-drop-count` directly."
  []
  @event-bus-drop-count)

;; Global event bus that receives all audit log events.
;;
;; Uses a `dropping-buffer` (not `sliding-buffer`) so that overflow is
;; explicitly visible to publishers: `>!!`/`offer!` returns false when
;; the buffer is full, letting `publish-*!` log a warning + bump the
;; drop counter. Sliding-buffer would silently evict the oldest event
;; on overflow — easier on memory, harder to diagnose.
(defstate event-bus
  :start
  (let [ch (async/chan (async/dropping-buffer 1000))]
    (log/info "Started audit event bus (dropping-buffer 1000)")
    ;; Start the event distribution loop
    (log/info "Starting event distributor")
    (async/go-loop []
      (when-let [event (async/<! ch)]
        (log/debug "Event distributor received event:" event)
        (let [affected-projects (:event/projects event)
              client-count (reduce + (map #(count (get-project-clients %)) affected-projects))]
          (when (> client-count 0)
            (log/debug "Distributing to" client-count "clients across projects" affected-projects))
          ;; Send event to all clients subscribed to affected projects
          (doseq [project-id affected-projects
                  client-chan (get-project-clients project-id)]
            (when (> client-count 0)
              (log/debug "Sending event to client for project" project-id))
            ;; Using put! here is non-blocking; if client is slow, events may be dropped
            (async/put! client-chan event)))
        (recur)))
    ch)
  :stop
  (do
    (log/info "Stopping audit event bus (total drops:" @event-bus-drop-count ")")
    (async/close! event-bus)))

(defn- offer-event!
  "Try to enqueue an event on the event bus. Returns true on success,
  false if the buffer is full (in which case the event is dropped and
  a warning is logged). `event-type` is a keyword tag for diagnostics.

  The drop-path warn log is dispatched to a `future` rather than emitted
  inline because the publishing thread may be holding the SQLite writer
  lock (e.g. `plaid.sql.operation/submit-operation*` publishes the audit
  event before returning to the REST handler). A slow log appender (file
  sync, remote sink, …) would otherwise extend the writer-held window
  for every dropped event."
  [event event-type]
  (let [accepted? (async/offer! event-bus event)]
    (when-not accepted?
      (let [total-drops (swap! event-bus-drop-count inc)
            ;; Task #119: capture the drop time NOW, before dispatching
            ;; the warn into a future. Under sustained overflow the
            ;; futures may queue + emit minutes later, at which point a
            ;; `(java.util.Date.)` inside the log/warn body would
            ;; describe the EMIT time, not the actual drop. Stamping
            ;; here pins the timeline so operators can correlate drops
            ;; against the upstream burst that caused them.
            drop-at (java.util.Date.)]
        (future
          (log/warn "Event bus full — dropping event"
                    {:event/type event-type
                     :event/at drop-at
                     :total-drops total-drops}))))
    (boolean accepted?)))

(defn publish-audit-event!
  "Publish an audit event to the event bus for distribution to subscribed clients.

   This is called by the database layer (plaid.sql.operation) after successful
   write operations. The event contains:
   - audit/id: Unique identifier for this audit entry
   - audit/projects: Set of affected project IDs
   - audit/documents: Set of affected document IDs  
   - audit/user: User who performed the operation
   - audit/time: Timestamp of the operation
   - audit/ops: Vector of individual operations with details
   
   Returns true if event was successfully published, false otherwise."
  [audit-entry operations user-id]
  (try
    (log/debug "Publishing audit event" {:audit-id (:audit/id audit-entry)
                                         :projects (:audit/projects audit-entry)
                                         :user-id  user-id})
    (cond
      (nil? event-bus)
      (do (log/warn "Event bus is not initialized") false)

      (not (satisfies? clojure.core.async.impl.protocols/WritePort event-bus))
      ;; An unstarted/misbound event-bus drops events — say so (the
      ;; publish-message! twin already does; silence here made partial
      ;; mount starts invisible).
      (do (log/warn "Event bus is not writable; dropping audit event") false)

      :else
      (let [event {:event/type      :audit-log
                   :event/projects  (:audit/projects audit-entry)
                   :audit/id        (:audit/id audit-entry)
                   :audit/projects  (:audit/projects audit-entry)
                   :audit/documents (:audit/documents audit-entry)
                   :audit/user      user-id
                   :audit/time      (java.util.Date.)
                   :audit/ops       (mapv #(-> (select-keys % [:op/id :op/type :op/project
                                                               :op/document :op/description])
                                               (update :op/type op-type-to-string))
                                          operations)}]
        (log/debug "Event data:" event)
        (if (offer-event! event :audit-log)
          (do (log/debug "Event published successfully") true)
          false)))
    (catch Exception e
      (log/error e "Exception while publishing audit event"
                 {:audit-id (:audit/id audit-entry)
                  :projects (:audit/projects audit-entry)
                  :user-id  user-id})
      false)))

(defn publish-message!
  "Publish a message event to the event bus for distribution to subscribed clients.
   
   Messages are arbitrary data payloads that can be sent to project subscribers.
   Unlike audit events, messages are not tied to database operations and are
   purely for real-time communication.
   
   Parameters:
   - project-id: The project ID this message is for
   - message-data: Arbitrary data to send (will be JSON serialized)
   - user-id: The user sending the message
   
   Returns true if message was successfully published, false otherwise."
  [project-id message-data user-id]
  (try
    (log/debug "Publishing message event" {:project-id project-id
                                           :user-id    user-id})
    (cond
      (nil? event-bus)
      (do (log/warn "Event bus is not initialized") false)

      (not (satisfies? clojure.core.async.impl.protocols/WritePort event-bus))
      (do (log/warn "Event bus is not writable") false)

      :else
      (let [message-id (java.util.UUID/randomUUID)
            event {:event/type      :message
                   :event/projects  #{project-id}
                   :message/id      message-id
                   :message/project project-id
                   :message/user    user-id
                   :message/time    (java.util.Date.)
                   :message/data    message-data}]
        (log/debug "Message event data:" event)
        (if (offer-event! event :message)
          (do (log/debug "Message published successfully") true)
          false)))
    (catch Exception e
      (log/error e "Exception while publishing message event"
                 {:project-id project-id
                  :user-id    user-id})
      false)))

;; =============================================================================
;; Test helpers
;; =============================================================================

(defn reset-state!
  "Test-helper: wipe the in-memory subscriber + heartbeat + drop-counter
  state. Task #113.

  Does NOT touch the `event-bus` core.async channel itself — that's
  started/stopped by mount, and a fresh channel between every deftest
  would race the distributor go-loop. Just resets the bookkeeping atoms
  + the drop counter so tests can observe drop counts and subscriber
  registrations starting from zero.

  Best-effort across mount lifecycle states: the drop-counter is a
  plain `defonce` atom and always resettable; the three defstate atoms
  are only resettable when their defstate is started (mount rebinds
  them to plain atoms on :start). Falls through silently when they're
  unstarted so the helper is safe to call from per-test fixtures that
  run before / outside `mount/start`."
  []
  (reset! event-bus-drop-count 0)
  (try (reset! client-registry {}) (catch Exception _))
  (try (reset! channel-mappings {}) (catch Exception _))
  (try (reset! heartbeat-registry {}) (catch Exception _))
  (try (reset! service-channels {}) (catch Exception _))
  (try (reset! inflight-requests {}) (catch Exception _)))