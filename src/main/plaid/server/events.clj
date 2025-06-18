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
            [clojure.string :as str]))


;; =============================================================================
;; Client Subscription Management
;; =============================================================================

;; Client registry maps project-id -> #{client-channels}
;; This allows us to efficiently find all clients interested in a specific project
(defstate client-registry
  :start (atom {})
  :stop (reset! client-registry {}))

;; Channel mappings for lifecycle management
;; Maps http-kit-channel -> {:client-chan chan :project-id id :stop-chan chan}
;; This allows us to clean up resources when an SSE connection closes
(defstate channel-mappings
  :start (atom {})
  :stop (reset! channel-mappings {}))

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


(defn register-channel-mapping!
  "Register the relationship between an http-kit channel and its associated
   client channel, project, and stop channel. This enables proper cleanup
   when the SSE connection closes."
  [http-channel client-chan project-id stop-chan]
  (swap! channel-mappings assoc http-channel {:client-chan client-chan
                                              :project-id  project-id
                                              :stop-chan   stop-chan})
  (log/debug "Registered channel mapping for project" project-id))

(defn cleanup-channel!
  "Clean up all resources associated with a closed SSE connection.
   This includes:
   - Closing the stop channel to signal any associated go-loops
   - Unregistering the client from the project
   - Closing the client channel
   - Removing the channel mapping"
  [http-channel]
  (when-let [{:keys [client-chan project-id stop-chan]} (get @channel-mappings http-channel)]
    (log/debug "Cleaning up channel for project" project-id)
    (try
      ;; Signal shutdown to any associated go-loops
      (when stop-chan
        (async/close! stop-chan))
      ;; Remove client from project subscription
      (unregister-client! project-id client-chan)
      ;; Close the client channel
      (async/close! client-chan)
      (catch Exception e
        (log/warn e "Error during channel cleanup")))
    (swap! channel-mappings dissoc http-channel)))


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

;; Global event bus that receives all audit log events
;; Uses a sliding buffer to prevent blocking if distribution is slow
(defstate event-bus
  :start
  (let [ch (async/chan (async/sliding-buffer 1000))]
    (log/info "Started audit event bus")
    ;; Start the event distribution loop
    (log/info "Starting event distributor")
    (async/go-loop []
      (when-let [event (async/<! ch)]
        (log/debug "Event distributor received event:" event)
        (let [affected-projects (:audit/projects event)
              client-count (reduce + (map #(count (get-project-clients %)) affected-projects))]
          (log/debug "Distributing to" client-count "clients across projects" affected-projects)
          ;; Send event to all clients subscribed to affected projects
          (doseq [project-id affected-projects
                  client-chan (get-project-clients project-id)]
            (log/debug "Sending event to client for project" project-id)
            ;; Using put! here is non-blocking; if client is slow, events may be dropped
            (async/put! client-chan event)))
        (recur)))
    ch)
  :stop
  (do
    (log/info "Stopping audit event bus")
    (async/close! event-bus)))

(defn publish-audit-event!
  "Publish an audit event to the event bus for distribution to subscribed clients.
   
   This is called by the database layer (plaid.xtdb.operation) after successful
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
                                        :user-id user-id})
    (cond
      (nil? event-bus)
      (do (log/warn "Event bus is not initialized") false)

      (not (satisfies? clojure.core.async.impl.protocols/WritePort event-bus))
      (do (log/warn "Event bus is not writable") false)

      :else
      (let [event {:event/type      :audit-log
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
        (let [put-result (async/put! event-bus event)]
          (if put-result
            (do (log/debug "Event published successfully") true)
            (do (log/warn "Failed to put event on bus - channel may be closed") false)))))
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
                                          :user-id user-id})
    (cond
      (nil? event-bus)
      (do (log/warn "Event bus is not initialized") false)

      (not (satisfies? clojure.core.async.impl.protocols/WritePort event-bus))
      (do (log/warn "Event bus is not writable") false)

      :else
      (let [message-id (java.util.UUID/randomUUID)
            event {:event/type      :message
                   :message/id      message-id
                   :message/project project-id
                   :message/user    user-id
                   :message/time    (java.util.Date.)
                   :message/data    message-data
                   ;; Include in audit/projects for routing compatibility
                   :audit/projects  #{project-id}}]
        (log/debug "Message event data:" event)
        (let [put-result (async/put! event-bus event)]
          (if put-result
            (do (log/debug "Message published successfully") true)
            (do (log/warn "Failed to put message on bus - channel may be closed") false)))))
    (catch Exception e
      (log/error e "Exception while publishing message event"
                 {:project-id project-id
                  :user-id  user-id})
      false)))