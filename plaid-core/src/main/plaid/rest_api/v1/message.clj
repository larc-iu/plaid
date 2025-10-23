(ns plaid.rest-api.v1.message
  (:require [plaid.rest-api.v1.auth :as pra]
            [taoensso.timbre :as log]
            [plaid.server.events :as events]
            [clojure.core.async :as async]
            [clojure.data.json :as json]
            [org.httpkit.server :as http-kit]))

(defn get-project-id [{params :parameters}]
  (-> params :path :id))

(defn sse-handler
  "Handle SSE connections for project audit log events with manual heartbeat tracking"
  [{{{:keys [id]} :path} :parameters :as req}]
  (http-kit/as-channel req
                       {:on-open
                        (fn [channel]
                          (let [client-chan (async/chan (async/sliding-buffer 100))
                                stop-chan (async/chan)
                                ;; Generate unique client ID for heartbeat tracking
                                client-id (events/register-client-with-id! id client-chan)]

                            (log/debug "New SSE client connected for project" id "with client-id" client-id
                                       "- Total clients:" (events/get-client-count))

                            ;; Send SSE headers
                            (http-kit/send! channel
                                            {:status  200
                                             :headers {"Content-Type"  "text/event-stream"
                                                       "Cache-Control" "no-cache"
                                                       "Connection"    "keep-alive"}}
                                            false)                   ; don't close connection

                            ;; Send initial connection message with client ID
                            (http-kit/send! channel
                                            (str "event: connected\n"
                                                 "data: " (json/write-str {:status    "connected"
                                                                           :client-id client-id}) "\n\n")
                                            false)

                            ;; Start heartbeat loop. This shouldn't be necessary, and for Python it isn't, but something about the
                            ;; JavaScript setup we have is causing channel closes to never happen.
                            (async/go-loop [consecutive-misses 0
                                            last-check-time (System/currentTimeMillis)]
                                           (let [hb-config (events/heartbeat-config)
                                                 interval-ms (:interval-ms hb-config)
                                                 max-misses (:max-consecutive-misses hb-config)
                                                 [_ ch] (async/alts! [(async/timeout interval-ms) stop-chan])]
                                             (if (= ch stop-chan)
                                               nil  ; exit loop on stop signal
                                               (do
                                                 ;; Send heartbeat ping
                                                 (try
                                                   (http-kit/send! channel "event: heartbeat\ndata: \"ping\"\n\n" false)
                                                   (catch Exception e
                                                     (log/warn "Heartbeat send failed for client" client-id ":" (.getMessage e))))

                                                 ;; Check if we received a confirmation since last check
                                                 (if-let [client-info (get @events/heartbeat-registry client-id)]
                                                   (let [last-heartbeat (:last-heartbeat client-info)]
                                                     (if (> last-heartbeat last-check-time)
                                                       ;; Got response since last check - reset miss counter
                                                       (recur 0 (System/currentTimeMillis))
                                                       ;; No response since last check - count as miss
                                                       (let [new-misses (inc consecutive-misses)]
                                                         (if (>= new-misses max-misses)
                                                           (do
                                                             (log/info "Client" client-id "disconnected after" new-misses "consecutive missed heartbeats")
                                                             (events/cleanup-channel! channel)
                                                             nil)  ; exit loop
                                                           (recur new-misses (System/currentTimeMillis))))))
                                                   (do
                                                     (log/warn "Client" client-id "not found in heartbeat registry, disconnecting")
                                                     (events/cleanup-channel! channel)
                                                     nil))))))

                            ;; Main event loop
                            (async/go-loop []
                                           (let [[event ch] (async/alts! [client-chan stop-chan])]
                                             (cond
                                               (= ch stop-chan) nil  ; exit loop on stop signal
                                               event (do
                                                       (try
                                                         (let [event-type (case (:event/type event)
                                                                            :audit-log "audit-log"
                                                                            :message "message"
                                                                            "unknown")
                                                               event-str (str "event: " event-type "\n"
                                                                              "data: " (json/write-str event) "\n\n")]
                                                           (http-kit/send! channel event-str false))
                                                         (catch Exception e
                                                           (log/warn "Event send failed for client" client-id ":" (.getMessage e))))
                                                       (recur))
                                               :else nil)))  ; channel closed, exit

                            ;; Store mapping for cleanup using the channel itself as key
                            (events/register-channel-mapping! channel client-chan id stop-chan client-id)))

                        :on-close
                        (fn [channel _]
                          (log/debug "Connection closed, cleaning up channel for project" id)
                          (events/cleanup-channel! channel)
                          (log/debug "After cleanup - Total clients:" (events/get-client-count)))}))

(def message-routes
  ["/projects/:id" {:parameters {:path [:map [:id :uuid]]}
                    :openapi {:x-client-bundle "messages"}}

   ;; SSE endpoint for audit log events
   ["/listen"
    {:get {:summary "Listen to audit log events and messages for a project via Server-Sent Events"
           :middleware [[pra/wrap-reader-required get-project-id]]
           :handler sse-handler}}]

   ;; Message endpoint for sending arbitrary messages to project subscribers
   ;; Heartbeat confirmation endpoint
   ["/heartbeat"
    {:post {:summary "INTERNAL, do not use directly."
            :middleware [[pra/wrap-reader-required get-project-id]]
            :parameters {:body [:map [:client-id :string]]}
            :handler (fn [{{{:keys [id]} :path
                            {:keys [client-id]} :body} :parameters
                           :as req}]
                       (if (events/record-heartbeat! id client-id)
                         {:status 200
                          :body {:success true}}
                         {:status 404
                          :body {:error "Client not found"}}))}}]

   ;; Message endpoint for sending arbitrary messages to project subscribers
   ["/message"
    {:post {:summary (str "Send a message to all clients that are listening to a project. "
                          "Useful for e.g. telling an NLP service to perform some work.")
            :middleware [[pra/wrap-writer-required get-project-id]]
            :openapi {:x-client-method "send-message"}
            :parameters {:body any?}
            :handler (fn [{{{:keys [id]} :path
                            body :body} :parameters
                           user-id :user/id
                           :as req}]
                       (if (events/publish-message! id (:body body) user-id)
                         {:status 200
                          :body {:success true
                                 :message "Message sent to subscribers"}}
                         {:status 500
                          :body {:error "Failed to publish message"}}))}}]])