(ns plaid.server.events
  (:require [clojure.core.async :as async]
            [mount.core :refer [defstate] :as mount]
            [taoensso.timbre :as log]
            [clojure.instant :as instant]
            [clojure.string :as str]))

;; Global event bus for audit log events
(defstate event-bus
  :start
  (let [ch (async/chan (async/sliding-buffer 1000))]
    (log/info "Started audit event bus")
    ch)
  :stop
  (do
    (log/info "Stopping audit event bus")
    (async/close! event-bus)))

;; Client registry: project-id -> #{client-channels}
(defstate client-registry
  :start (atom {})
  :stop (reset! client-registry {}))

;; Channel mapping for cleanup: http-kit-channel -> {:client-chan chan :project-id id}
(defstate channel-mappings
  :start (atom {})
  :stop (reset! channel-mappings {}))

(defn op-type-to-string
  "Convert operation type keyword to snake_cased string format 'namespace:name'"
  [op-type-kw]
  (when op-type-kw
    (let [ns-part (-> (namespace op-type-kw)
                      (str/replace #"-" "_"))
          name-part (-> (name op-type-kw)
                        (str/replace #"-" "_"))]
      (str ns-part ":" name-part))))

(defn publish-audit-event!
  "Publish an audit event to the global event bus"
  [audit-entry operations user-id]
  (try
    (log/debug "Publishing audit event" {:audit-id (:audit/id audit-entry) :projects (:audit/projects audit-entry) :user-id user-id})
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
                   :audit/ops       (mapv #(-> (select-keys % [:op/id :op/type :op/project :op/document :op/description])
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

(defn register-client!
  "Register a client channel for a specific project"
  [project-id client-chan]
  (swap! client-registry update project-id (fnil conj #{}) client-chan)
  (log/debug "Registered client for project" project-id))

(defn unregister-client!
  "Unregister a client channel from a specific project"
  [project-id client-chan]
  (swap! client-registry update project-id disj client-chan)
  (when (empty? (get @client-registry project-id))
    (swap! client-registry dissoc project-id))
  (log/debug "Unregistered client for project" project-id))

(defn get-project-clients
  "Get all client channels for a specific project"
  [project-id]
  (get @client-registry project-id #{}))

(defn start-event-distributor!
  "Start the event distribution loop that sends events to appropriate clients"
  []
  (log/info "Starting event distributor")
  (async/go-loop []
    (when-let [event (async/<! event-bus)]
      (log/debug "Event distributor received event:" event)
      (let [affected-projects (:audit/projects event)
            client-count (reduce + (map #(count (get-project-clients %)) affected-projects))]
        (log/debug "Distributing to" client-count "clients across projects" affected-projects)
        ;; Send event to all clients listening to affected projects
        (doseq [project-id affected-projects
                client-chan (get-project-clients project-id)]
          (log/debug "Sending event to client for project" project-id)
          (async/put! client-chan event)))
      (recur))))

;; Start the distributor when the event bus starts
(defstate event-distributor
  :start (start-event-distributor!)
  :stop nil)

(defn register-channel-mapping!
  "Register a mapping between http-kit channel and client channel for cleanup"
  [http-channel client-chan project-id stop-chan]
  (swap! channel-mappings assoc http-channel {:client-chan client-chan
                                              :project-id  project-id
                                              :stop-chan   stop-chan})
  (log/debug "Registered channel mapping for project" project-id))

(defn cleanup-channel!
  "Clean up a channel mapping and unregister the client"
  [http-channel]
  (when-let [{:keys [client-chan project-id stop-chan]} (get @channel-mappings http-channel)]
    (log/debug "Cleaning up channel for project" project-id)
    (try
      ;; Signal shutdown to goroutines
      (when stop-chan
        (async/close! stop-chan))
      ;; Clean up client registration
      (unregister-client! project-id client-chan)
      ;; Close client channel
      (async/close! client-chan)
      (catch Exception e
        (log/warn e "Error during channel cleanup")))
    (swap! channel-mappings dissoc http-channel)))