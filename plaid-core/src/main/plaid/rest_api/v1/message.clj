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

;; =============================================================================
;; Server-mediated service RPC (addressed; off the broadcast bus)
;; =============================================================================
;;
;; A client submits work to ONE specific service and the server relays that
;; service's progress/result back to only that requester — no fan-out. This is
;; deliberately separate from /listen + /message (which stay as a generic
;; medium): the service receives requests on its own SSE stream, and replies
;; via plain POSTs that the server routes to the waiting requester's stream.
;; Ephemeral: if no service channel is open, submit fails fast (503); if a
;; service drops mid-request, its in-flight requesters are errored.

(def ^:private sse-response-headers
  {"Content-Type"  "text/event-stream"
   "Cache-Control" "no-cache"
   "Connection"    "keep-alive"})

(defn- sse-event
  "Format a named SSE event carrying a JSON data payload."
  [event-name data]
  (str "event: " event-name "\n"
       "data: " (json/write-str data) "\n\n"))

(defn- start-keepalive!
  "Periodically send an SSE comment so an idle stream stays open through
  proxies; exits once the channel closes."
  [channel]
  (async/go-loop []
    (async/<! (async/timeout 25000))
    (when (and (http-kit/open? channel)
               (http-kit/send! channel ": keepalive\n\n" false))
      (recur))))

(defn service-channel-handler
  "SSE stream a service opens to RECEIVE work requests (server -> service).
  Holding this channel open IS the service's registration; its discovery
  metadata (service-name / description / extras) rides the query string, and
  closing the channel deregisters it."
  [{{{:keys [id service-id]} :path
     {:keys [service-name description extras]} :query} :parameters
    user-id :user/id :as req}]
  (let [info {:service-name service-name
              :description description
              :extras (when extras
                        (try (json/read-str extras :key-fn keyword)
                             (catch Exception _ nil)))}]
    (http-kit/as-channel
     req
     {:on-open
      (fn [channel]
        (http-kit/send! channel {:status 200 :headers sse-response-headers} false)
        (http-kit/send! channel (sse-event "connected" {:status "connected" :service-id service-id}) false)
        (events/register-service-channel! id service-id channel info user-id)
        (log/debug "Service channel opened for" service-id "on project" id)
        (start-keepalive! channel))
      :on-close
      (fn [channel _]
        (events/unregister-service-channel! id service-id channel)
        ;; Fail any in-flight requests that were routed to this now-gone service.
        (doseq [[request-id {:keys [requester]}] (events/requests-for-service id service-id)]
          (when requester
            (try (http-kit/send! requester (sse-event "error" {:error "Service disconnected"}) false)
                 (catch Exception _))
            (try (http-kit/close requester) (catch Exception _)))
          (events/resolve-request! request-id))
        (log/debug "Service channel closed for" service-id "on project" id))})))

(defn submit-request-handler
  "Client POSTs work for a service; the response is an SSE stream of that
  service's progress events ending in a result or error. 503 if no service is
  currently connected."
  [{{{:keys [id service-id]} :path
     data :body} :parameters :as req}]
  (if-not (events/get-service-channel id service-id)
    {:status 503 :body {:error (str "No live service '" service-id "' on this project")}}
    (let [request-id (str (java.util.UUID/randomUUID))]
      (http-kit/as-channel
       req
       {:on-open
        (fn [requester]
          (http-kit/send! requester {:status 200 :headers sse-response-headers} false)
          (events/track-request! request-id requester id service-id)
          (start-keepalive! requester)
          ;; Re-fetch the channel at push time — it may have dropped since the
          ;; pre-check above.
          (let [service-ch (events/get-service-channel id service-id)]
            (when-not (and service-ch
                           (http-kit/send! service-ch
                                           (sse-event "service_request" {:request-id request-id :data data})
                                           false))
              (http-kit/send! requester (sse-event "error" {:error "Service unavailable"}) false)
              (events/resolve-request! request-id)
              (http-kit/close requester))))
        :on-close
        (fn [_ _]
          (events/resolve-request! request-id))}))))

(defn reply-handler
  "Service POSTs progress/result/error for an in-flight request; the server
  relays it to the waiting requester's stream, closing on a terminal status."
  [{{{:keys [id request-id]} :path
     {:keys [status progress data]} :body} :parameters :as req}]
  (let [{:keys [requester project-id]} (events/get-request request-id)]
    (if-not (and requester (= project-id id))
      {:status 404 :body {:error "Unknown or already-completed request"}}
      (do
        (case status
          "progress"  (http-kit/send! requester (sse-event "progress" {:progress progress}) false)
          "completed" (do (http-kit/send! requester (sse-event "result" {:data data}) false)
                          (events/resolve-request! request-id)
                          (http-kit/close requester))
          "error"     (do (http-kit/send! requester (sse-event "error" (if (map? data) data {:error data})) false)
                          (events/resolve-request! request-id)
                          (http-kit/close requester))
          nil)
        {:status 200 :body {:success true}}))))

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
                          :body {:error "Failed to publish message"}}))}}]

   ;; Service discovery: the services currently connected to a project (presence
   ;; = an open request channel; see below). Synchronous read, not the old
   ;; broadcast-and-wait handshake. Not persisted, not audit-logged.
   ["/services"
    {:get {:summary "List the services currently connected to a project."
           :middleware [[pra/wrap-reader-required get-project-id]]
           :handler (fn [{{{:keys [id]} :path} :parameters}]
                      {:status 200
                       :body (events/list-live-services id)})}}]

   ;; Server-mediated RPC: the service's inbound request stream (GET) and the
   ;; client's work-submission stream (POST). Addressed, not broadcast. Opening
   ;; the GET stream registers the service for discovery (metadata rides the
   ;; query string); closing it deregisters.
   ["/services/:service-id/requests"
    {:parameters {:path [:map [:id :uuid] [:service-id :string]]}
     :get {:summary "Service: open the inbound work-request stream (SSE); this registers the service."
           :middleware [[pra/wrap-writer-required get-project-id]]
           :openapi {:x-client-method "serve-channel"}
           :parameters {:query [:map
                                [:service-name {:optional true} :string]
                                [:description {:optional true} :string]
                                [:extras {:optional true} :string]]}
           :handler service-channel-handler}
     :post {:summary "Client: submit work to a service; streams progress + result (SSE)."
            :middleware [[pra/wrap-writer-required get-project-id]]
            :openapi {:x-client-method "submit-request"}
            :parameters {:body any?}
            :handler submit-request-handler}}]

   ;; Service reports progress/result/error for an in-flight request; the server
   ;; relays it to the waiting requester.
   ["/service-requests/:request-id/events"
    {:parameters {:path [:map [:id :uuid] [:request-id :string]]}
     :post {:summary "Service: report progress/result/error for an in-flight request."
            :middleware [[pra/wrap-writer-required get-project-id]]
            :openapi {:x-client-method "report-request-event"}
            :parameters {:body [:map
                                [:status [:enum "progress" "completed" "error"]]
                                [:progress {:optional true} any?]
                                [:data {:optional true} any?]]}
            :handler reply-handler}}]])