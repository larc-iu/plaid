(ns plaid.rest-api.v1.message
  (:require [plaid.rest-api.v1.auth :as pra]
            [taoensso.timbre :as log]
            [plaid.server.events :as events]
            [plaid.sql.api-token :as api-token]
            [plaid.sql.project :as prj]
            [plaid.sql.service-registry :as service-registry]
            [plaid.sql.user :as user]
            [clojure.core.async :as async]
            [clojure.data.json :as json]
            [clojure.string :as str]
            [org.httpkit.server :as http-kit]))

(defn get-project-id [{params :parameters}]
  (-> params :path :id))

(defn- still-entitled?
  "Would the credential that opened this channel still be let in to open it
  now? The same questions `wrap-read-jwt` and the route's privilege
  middleware ask: the user exists and is active, an API token is not
  revoked, a session token's password_changes claim still matches, and the
  user holds `privilege` on the project (`:project/writers` for a service
  channel, `:project/readers` for a /listen stream) or is an admin. The
  project must also still exist, since the privilege check lets an admin in
  on any project id, and an admin's channel has to close when its project
  is deleted. And a token that expires (`token-exp`, its `exp` claim) is
  let in only until then."
  [{:keys [db project-id user-id token-id token-version token-exp]} privilege]
  (let [account (user/get-internal db user-id)]
    (boolean
     (and account
          (or (nil? token-exp) (< (quot (System/currentTimeMillis) 1000) token-exp))
          (prj/get db project-id)
          (nil? (:user/deactivated-at account))
          (if token-id
            (api-token/active? db token-id)
            (= token-version (:user/password-changes account)))
          (pra/privileged? {:db db
                            :parameters {:path {:id project-id}}
                            :jwt-data {:user/id user-id}
                            :user/record (user/get db user-id)}
                           privilege
                           get-project-id)))))

(defn- standing-holds?
  "`still-entitled?` for one registry entry, where a check that cannot be
  answered (a busy database) keeps the channel open rather than failing the
  caller."
  [entry privilege]
  (try (still-entitled? entry privilege)
       (catch Exception e
         (log/warn e "Could not check the standing of a channel on project" (:project-id entry))
         true)))

(defn- close-listen-stream!
  "Close a /listen stream whose holder lost the right to it."
  [{:keys [channel project-id]}]
  (events/cleanup-channel! channel)
  (log/info "Closed a /listen stream on project" project-id
            "because its credential no longer admits it"))

(defn sse-handler
  "Handle SSE connections for project audit log events with manual heartbeat tracking"
  [{{{:keys [id]} :path} :parameters user-id :user/id db :db :as req}]
  (if (nil? (prj/get db id))
    ;; The privilege check lets an admin in on any project id, so a project
    ;; that does not exist is refused here, while a status can still be sent.
    ;; Only an admin gets this far, and an unknown id answers an admin 404
    ;; (a non-member already had the middleware's 403).
    {:status 404 :body {:error "Project not found"}}
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
                                                  (log/debug "Client" client-id "disconnected after" new-misses "consecutive missed heartbeats")
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
                                              (let [payload (events/wire-payload event)
                                                    event-str (str "event: " (:type payload) "\n"
                                                                   "data: " (json/write-str payload) "\n\n")]
                                                (http-kit/send! channel event-str false))
                                              (catch Exception e
                                                (log/warn "Event send failed for client" client-id ":" (.getMessage e))))
                                            (recur))
                                    :else nil)))  ; channel closed, exit

                            ;; Store mapping for cleanup using the channel itself as key,
                            ;; with what opened the stream, so it closes the moment that
                            ;; credential or its user's role no longer would.
                              (let [opener {:user-id user-id
                                            :token-id (:api-token/id req)
                                            :token-version (-> req :jwt-data :version)
                                            :token-exp (-> req :jwt-data :exp)
                                            :db db}]
                                (events/register-channel-mapping! channel client-chan id stop-chan client-id opener)
                              ;; The credential was admitted by the middleware, before this
                              ;; stream registered. A write that took it away in between
                              ;; found no stream to close, so ask again now that there is one.
                                (when-not (standing-holds? (assoc opener :project-id id) :project/readers)
                                  (close-listen-stream! {:channel channel :project-id id})))))

                          :on-close
                          (fn [channel _]
                            (log/debug "Connection closed, cleaning up channel for project" id)
                            (events/cleanup-channel! channel)
                            (log/debug "After cleanup - Total clients:" (events/get-client-count)))})))

;; =============================================================================
;; Server-mediated service RPC (addressed; off the broadcast bus)
;; =============================================================================
;;
;; A client submits work to ONE specific service and the server relays that
;; service's progress/result back to only that requester — no fan-out. This is
;; deliberately separate from /listen + /message (which stay as a generic
;; medium): the service receives requests on its own SSE stream, and replies
;; via plain POSTs that the server routes to the waiting requester's stream.
;; If no service channel is open, submit fails fast (503); if a service drops
;; mid-request, its in-flight requests are failed.
;;
;; A request outlives the requester's connection. The submitting stream may
;; close (a browser tab reloaded during a minutes-long turn) and the request
;; goes on; the requester comes back for it with the request id (GET
;; /service-requests/:request-id), which replays the latest progress and then
;; delivers the result, or the result straight away if it is already in (kept
;; for a while after the service delivered it). A client that wants to be
;; able to come back mints the id itself (`?request-id=`), so it can record
;; the id before the request is even accepted. DELETE asks the service to
;; stop; the request still ends with whatever the service then reports.

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

(defn- finish-request!
  "Store a request's terminal event and deliver it to every connection still
  watching, closing each."
  [request-id event data]
  (when-let [{:keys [requesters]} (events/finish-request! request-id event data)]
    (doseq [ch requesters]
      (try (http-kit/send! ch (sse-event event data) false) (catch Exception _))
      (try (http-kit/close ch) (catch Exception _)))))

(defn- drop-service-channel!
  "Deregister a service channel whose holder lost the right to it, fail the
  requests routed to it, and close it."
  [{:keys [db project-id service-id channel]}]
  (events/unregister-service-channel! project-id service-id channel)
  (try (http-kit/send! channel
                       (sse-event "error" {:error "This connection's credentials no longer allow it"})
                       false)
       (catch Exception _))
  (when-not (events/get-service-channel project-id service-id)
    (try (service-registry/touch-last-seen! db project-id service-id)
         (catch Exception _))
    (doseq [[request-id _] (events/requests-for-service project-id service-id)]
      (finish-request! request-id "error" {:error "Service disconnected"})))
  (try (http-kit/close channel) (catch Exception _))
  (log/info "Closed service channel" service-id "on project" project-id
            "because its credential no longer admits it"))

(defn close-at-expiry!
  "Close service channel `entry` when the token that opened it expires, if
  it does (`:token-exp`, a delegated token's hour). No write marks that
  moment, so `close-lapsed-service-channels!` would not, and the channel
  would go on receiving requests, and a delegating service the requesters'
  tokens, under a credential no longer let in anywhere."
  [{:keys [token-exp project-id service-id channel] :as entry}]
  (when token-exp
    (async/go
      (async/<! (async/timeout (max 0 (- (* 1000 (long token-exp)) (System/currentTimeMillis)))))
      (when (identical? channel (events/get-service-channel project-id service-id))
        (drop-service-channel! entry)))))

(defn close-lapsed-service-channels!
  "Close every live service channel whose opener would no longer be let in.
  Runs after each write that can take that right away (see
  `events/standing-op-types`), before the write's response goes out."
  []
  (doseq [entry (events/live-service-entries)]
    (when-not (standing-holds? entry :project/writers)
      (drop-service-channel! entry))))

(defn close-lapsed-listen-streams!
  "Close every open /listen stream whose opener could no longer open it, as
  `close-lapsed-service-channels!` does for service channels, so a reader
  who lost the right stops receiving the project's events at once rather
  than when their heartbeats next go unanswered."
  []
  (doseq [entry (events/live-listen-entries)]
    (when-not (standing-holds? entry :project/readers)
      (close-listen-stream! entry))))

(events/on-standing-change!
 (fn []
   ;; Each kind is checked on its own, so a failure closing one never
   ;; leaves the other open.
   (doseq [close! [close-lapsed-service-channels! close-lapsed-listen-streams!]]
     (try (close!)
          (catch Exception e
            (log/error e "Could not re-check the open channels after a change of standing"))))))

(defn service-channel-handler
  "SSE stream a service opens to RECEIVE work requests (server -> service).
  Holding this channel open IS the service's registration; its discovery
  metadata (service-name / description / extras) rides the query string, and
  closing the channel deregisters it. 409 if another LIVE channel already
  holds this service-id on the project (a dead-but-unclosed channel is taken
  over, so reconnect-after-blip never self-409s). Registration also upserts
  the persistent seen_services row so discovery can show the service offline
  later."
  [{{{:keys [id service-id]} :path
     {:keys [service-name description extras]} :query} :parameters
    user-id :user/id db :db :as req}]
  (let [info {:service-name service-name
              :description description
              :extras (when extras
                        (try (json/read-str extras :key-fn keyword)
                             (catch Exception _ nil)))
              ;; What opened the channel, so the channel can be closed the
              ;; moment that credential or its user's role no longer would.
              :token-id (:api-token/id req)
              :token-version (-> req :jwt-data :version)
              :token-exp (-> req :jwt-data :exp)
              :db db}]
    ;; Conflict pre-check must happen BEFORE as-channel — SSE headers go out
    ;; in :on-open, after which a plain 409 response is no longer possible.
    (cond
      ;; The privilege check lets an admin in on any project id, so a project
      ;; that does not exist is refused here, while a status can still be
      ;; sent. The same 403 a non-admin gets.
      (nil? (prj/get db id))
      {:status 403 :body {:error (str "User " user-id " lacks sufficient privileges to open a service channel on project " id)}}

      (events/channel-alive? (events/get-service-channel id service-id))
      {:status 409 :body {:error (str "Service '" service-id "' is already connected to this project")}}

      :else
      (http-kit/as-channel
       req
       {:on-open
        (fn [channel]
          (http-kit/send! channel {:status 200 :headers sse-response-headers} false)
          (if (= :conflict (events/try-register-service-channel! id service-id channel info user-id))
            ;; Lost the pre-check/open race to another registration.
            (do (http-kit/send! channel
                                (sse-event "error" {:error (str "Service '" service-id "' is already connected to this project")})
                                false)
                (http-kit/close channel))
            (if
              ;; The credential was admitted by the middleware, before this
              ;; channel registered. A write that took it away in between
              ;; found no channel to close, so ask again now that there is
              ;; one. Either order of the write and the registration then
              ;; ends closed.
             (not (standing-holds? (assoc info :project-id id :service-id service-id
                                          :user-id user-id)
                                   :project/writers))
              (drop-service-channel! (assoc info :project-id id :service-id service-id
                                            :channel channel))
              (do
                (http-kit/send! channel (sse-event "connected" {:status "connected" :service-id service-id}) false)
              ;; Persist to the seen-services registry. Best-effort: a busy DB
              ;; must never kill a service channel. Store the RAW extras JSON
              ;; so the snapshot parses to exactly the live wire shape.
                (try
                  (service-registry/record-seen! db id service-id
                                                 {:service-name service-name
                                                  :description description
                                                  :extras-json extras})
                  (catch Exception e
                    (log/warn e "Failed to record seen-service row for" service-id "on project" id)))
                (log/debug "Service channel opened for" service-id "on project" id)
                (start-keepalive! channel)
                (close-at-expiry! (assoc info :project-id id :service-id service-id
                                         :user-id user-id :channel channel))))))
        :on-close
        (fn [channel _]
          (events/unregister-service-channel! id service-id channel)
          ;; Only run the "service is gone" cleanup when it actually is gone —
          ;; a superseded/losing channel closing must not stamp last-seen or
          ;; fail in-flight requests that a live takeover is still serving.
          (when-not (events/get-service-channel id service-id)
            ;; Best-effort "last seen alive" stamp.
            (try (service-registry/touch-last-seen! db id service-id)
                 (catch Exception _))
            ;; Fail any in-flight requests that were routed to this now-gone service.
            (doseq [[request-id _] (events/requests-for-service id service-id)]
              (finish-request! request-id "error" {:error "Service disconnected"})))
          (log/debug "Service channel closed for" service-id "on project" id))}))))

(defn- request-visible?
  "May this request's caller see the request `entry`: it belongs to the
  project in the path and was submitted by the caller, or the caller is an
  admin."
  [entry req project-id]
  (boolean
   (and entry
        (= (:project-id entry) project-id)
        (or (= (:user-id entry) (pra/->user-id req))
            (user/admin? (:user/record req))))))

(defn- attach-stream
  "An SSE stream that joins an existing request: the latest progress, then
  the result when it comes; or the stored result at once if it is already in."
  [req request-id]
  (http-kit/as-channel
   req
   {:on-open
    (fn [channel]
      (http-kit/send! channel {:status 200 :headers sse-response-headers} false)
      (http-kit/send! channel (sse-event "accepted" {:request-id request-id}) false)
      (let [entry (events/attach-request! request-id channel)]
        (cond
          (nil? entry)
          (do (http-kit/send! channel (sse-event "error" {:error "Unknown or expired request"}) false)
              (http-kit/close channel))

          (:result entry)
          (let [{:keys [event data]} (:result entry)]
            (http-kit/send! channel (sse-event event data) false)
            (http-kit/close channel))

          :else
          (do (when-let [p (:last-progress entry)]
                (http-kit/send! channel (sse-event "progress" {:progress p}) false))
              (start-keepalive! channel)))))
    :on-close
    (fn [channel _]
      (events/detach-request! request-id channel))}))

(defn- uuid-string? [s]
  (boolean (and (string? s) (re-matches #"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" s))))

(defn- delegated-projects
  "The projects a delegated token for this request is scoped to: the one the
  request is on, then each of `joined` (the other projects a conversation
  reads, `?project-ids=`) that exists and that the requester can read. A
  project the requester cannot read is left out, not refused: the service
  finds it unopenable and says so, as it does for any project it cannot open.
  A request made with a scoped token never widens that token's reach, since
  `privileged?` answers only inside it."
  [req db home joined]
  (into [(str home)]
        (comp (remove #{(str home)})
              (distinct)
              (filter #(and (prj/get db %)
                            (pra/privileged? req :project/readers (constantly %)))))
        joined))

(defn- parse-project-ids
  "`?project-ids=` as a list of lower-cased ids, or nil when any is not a UUID."
  [s]
  (let [ids (->> (str/split (or s "") #",") (map str/trim) (remove str/blank?) (map str/lower-case))]
    (when (every? uuid-string? ids)
      (vec ids))))

(defn submit-request-handler
  "Client POSTs work for a service; the response is an SSE stream of that
  service's progress events ending in a result or error. 503 if no service is
  currently connected.

  The stream opens with an `accepted` event naming the request id. The
  client may choose the id (`?request-id=`, a UUID): submitting an id that
  names a request this user already made joins that request instead of
  starting another, so a retry after a dropped connection is safe.

  Who may submit depends on the service. A plain service acts with its OWN
  token, so driving it is a write on the project: writer required. A
  *delegating* service (`extras.delegation`) acts on the requester's behalf:
  the server mints a short-lived token for the requesting user and passes it
  to the service as `delegated-token` beside the request data, so every read
  and write the service performs for this request is checked against, and
  attributed to, the requester. Readers may drive such a service (it can do
  nothing for them that they could not do themselves). Every service is told
  who asked (`requester-id`)."
  [{{{:keys [id service-id]} :path
     {:keys [request-id project-ids]} :query
     data :body} :parameters
    db :db secret-key :secret-key :as req}]
  (let [entry (events/get-service-entry id service-id)
        delegating? (events/delegating-service? entry)
        existing (when request-id (events/get-request request-id))
        user-id (pra/->user-id req)]
    (cond
      existing
      (if (request-visible? existing req id)
        (attach-stream req request-id)
        {:status 409 :body {:error (str "Request id " request-id " is taken")}})

      (and request-id (not (uuid-string? request-id)))
      {:status 400 :body {:error "request-id must be a UUID"}}

      (nil? (parse-project-ids project-ids))
      {:status 400 :body {:error "project-ids must be a comma-separated list of project UUIDs"}}

      (nil? entry)
      {:status 503 :body {:error (str "No live service '" service-id "' on this project")}}

      (and (not delegating?) (not (pra/privileged? req :project/writers get-project-id)))
      {:status 403 :body {:error (str "User " user-id " lacks sufficient privileges to write for project "
                                      id " (service '" service-id "' acts with its own credentials)")}}

      ;; A write that took the channel's right away closes it at once
      ;; (`close-lapsed-service-channels!`). Asked again here because a
      ;; request carries the requester's own token to the service.
      (not (still-entitled? (assoc entry :project-id id) :project/writers))
      (do (drop-service-channel! (assoc entry :project-id id))
          {:status 503 :body {:error (str "No live service '" service-id "' on this project")}})

      :else
      (let [request-id (or request-id (str (java.util.UUID/randomUUID)))
            scope (when delegating?
                    (delegated-projects req db id (parse-project-ids project-ids)))
            ;; Never longer-lived than the requester's own token, so a
            ;; delegated token cannot renew itself through a service.
            delegated-token (when delegating?
                              (pra/issue-delegated-token! db secret-key user-id scope
                                                          (-> req :jwt-data :exp)))
            ;; The service is told which projects the token reaches, so it
            ;; can say which of the ones it was asked about it cannot open.
            event (cond-> {:request-id request-id :requester-id user-id :data data}
                    delegated-token (assoc :delegated-token delegated-token
                                           :delegated-projects scope))]
        (http-kit/as-channel
         req
         {:on-open
          (fn [requester]
            (http-kit/send! requester {:status 200 :headers sse-response-headers} false)
            (events/track-request! request-id requester id service-id user-id)
            (http-kit/send! requester (sse-event "accepted" {:request-id request-id}) false)
            (start-keepalive! requester)
            ;; Re-fetch the channel at push time — it may have dropped since the
            ;; pre-check above.
            (let [service-ch (events/get-service-channel id service-id)]
              (when-not (and service-ch
                             (http-kit/send! service-ch (sse-event "service_request" event) false))
                (events/forget-request! request-id)
                (http-kit/send! requester (sse-event "error" {:error "Service unavailable"}) false)
                (http-kit/close requester))))
          :on-close
          (fn [requester _]
            (events/detach-request! request-id requester))})))))

(defn attach-request-handler
  "Client GETs the stream of a request it made earlier (see
  `submit-request-handler`): 404 unless the request is known and theirs."
  [{{{:keys [id request-id]} :path} :parameters :as req}]
  (if (request-visible? (events/get-request request-id) req id)
    (attach-stream req request-id)
    {:status 404 :body {:error "Unknown or expired request"}}))

(defn cancel-request-handler
  "Client asks the service to stop a request it made. The service is told
  (`service_cancel` on its channel) and the request still ends with whatever
  the service then reports. 409 once the request has finished."
  [{{{:keys [id request-id]} :path} :parameters :as req}]
  (let [entry (events/get-request request-id)]
    (cond
      (not (request-visible? entry req id))
      {:status 404 :body {:error "Unknown or expired request"}}

      (:result entry)
      {:status 409 :body {:error "The request has already finished"}}

      :else
      (do (events/cancel-request! request-id)
          (when-let [service-ch (events/get-service-channel id (:service-id entry))]
            (try (http-kit/send! service-ch (sse-event "service_cancel" {:request-id request-id}) false)
                 (catch Exception _)))
          {:status 204}))))

(defn reply-handler
  "Service POSTs progress/result/error for an in-flight request; the server
  relays it to every connection watching the request, stores the terminal
  event for a requester that comes back later, and closes the watchers."
  [{{{:keys [id request-id]} :path
     {:keys [status progress data]} :body} :parameters :as req}]
  (let [{:keys [project-id result]} (events/get-request request-id)]
    (if-not (and project-id (= project-id id) (nil? result))
      {:status 404 :body {:error "Unknown or already-completed request"}}
      (do
        (case status
          "progress"  (doseq [ch (events/record-progress! request-id progress)]
                        (try (http-kit/send! ch (sse-event "progress" {:progress progress}) false)
                             (catch Exception _)))
          "completed" (finish-request! request-id "result" {:data data})
          "error"     (finish-request! request-id "error" (if (map? data) data {:error data}))
          nil)
        {:status 200 :body {:success true}}))))

(def message-routes
  ["/projects/:id" {:parameters {:path [:map [:id :uuid]]}}

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

   ;; Service discovery: every service ever seen on the project (persistent
   ;; seen_services rows, upserted on registration) merged with the live
   ;; channel registry. Live entries win on metadata and carry :online true;
   ;; the rest are offline with a :last-seen-at stamp. Synchronous read.
   ["/services"
    {:get {:summary (str "List the services seen on a project: currently connected ones "
                         "(online true) plus previously-seen offline ones with a last-seen time.")
           :middleware [[pra/wrap-reader-required get-project-id]]
           :handler (fn [{{{:keys [id]} :path} :parameters db :db}]
                      (let [live (events/list-live-services id)
                            live-ids (set (map :service-id live))
                            seen (try (service-registry/list-seen db id)
                                      (catch Exception e
                                        (log/warn e "Failed to read seen-services for project" id)
                                        []))
                            ;; last-seen-at for a live service is "now" in
                            ;; spirit; report the stored row's stamp if any so
                            ;; clients have one field to render.
                            seen-by-id (into {} (map (juxt :service-id identity)) seen)
                            merged (concat
                                    (map (fn [{:keys [service-id] :as entry}]
                                           (assoc entry
                                                  :online true
                                                  :last-seen-at (get-in seen-by-id [service-id :last-seen-at])))
                                         live)
                                    (->> seen
                                         (remove #(live-ids (:service-id %)))
                                         (map #(assoc % :online false))))]
                        {:status 200
                         :body (vec (sort-by :service-id merged))}))}}]

   ;; Registry hygiene: forget a previously-seen (offline) service.
   ["/services/:service-id"
    {:parameters {:path [:map [:id :uuid] [:service-id :string]]}
     :delete {:summary "Forget a previously-seen service. 409 if it is currently connected."
              :middleware [[pra/wrap-maintainer-required get-project-id]]
              :handler (fn [{{{:keys [id service-id]} :path} :parameters db :db}]
                         (if (events/channel-alive? (events/get-service-channel id service-id))
                           {:status 409 :body {:error (str "Service '" service-id "' is currently connected; it would just re-register")}}
                           (if (pos? (service-registry/delete-seen! db id service-id))
                             {:status 204}
                             {:status 404 :body {:error (str "No seen service '" service-id "' on this project")}})))}}]

   ;; Server-mediated RPC: the service's inbound request stream (GET) and the
   ;; client's work-submission stream (POST). Addressed, not broadcast. Opening
   ;; the GET stream registers the service for discovery (metadata rides the
   ;; query string); closing it deregisters.
   ["/services/:service-id/requests"
    {:parameters {:path [:map [:id :uuid] [:service-id :string]]}
     :get {:summary "Service: open the inbound work-request stream (SSE); this registers the service."
           :middleware [[pra/wrap-writer-required get-project-id]]
           :parameters {:query [:map
                                [:service-name {:optional true} :string]
                                [:description {:optional true} :string]
                                [:extras {:optional true} :string]]}
           :handler service-channel-handler}
     :post {:summary (str "Client: submit work to a service; streams progress + result (SSE). "
                          "Writer required, or reader when the service delegates (acts on the "
                          "requester's behalf with a short-lived token the server mints).")
            ;; Reader here; the handler raises the bar to writer for a
            ;; non-delegating service (see `submit-request-handler`).
            :middleware [[pra/wrap-reader-required get-project-id]]
            :parameters {:query [:map
                                 [:request-id {:optional true} :string]
                                 [:project-ids {:optional true} :string]]
                         :body any?}
            :handler submit-request-handler}}]

   ;; A request the client made earlier: rejoin its stream, or ask the
   ;; service to stop it. Only the user who submitted it (or an admin).
   ["/service-requests/:request-id"
    {:parameters {:path [:map [:id :uuid] [:request-id :string]]}
     :get {:summary (str "Client: rejoin the stream of a request made earlier (progress, then the "
                         "result; or the result at once if it already finished). 404 unless the "
                         "request is yours and still known.")
           :middleware [[pra/wrap-reader-required get-project-id]]
           :handler attach-request-handler}
     :delete {:summary (str "Client: ask the service to stop a request made earlier. The request "
                            "ends with whatever the service then reports. 409 once finished.")
              :middleware [[pra/wrap-reader-required get-project-id]]
              :handler cancel-request-handler}}]

   ;; Service reports progress/result/error for an in-flight request; the server
   ;; relays it to the waiting requester.
   ["/service-requests/:request-id/events"
    {:parameters {:path [:map [:id :uuid] [:request-id :string]]}
     :post {:summary "Service: report progress/result/error for an in-flight request."
            :middleware [[pra/wrap-writer-required get-project-id]]
            :parameters {:body [:map
                                [:status [:enum "progress" "completed" "error"]]
                                [:progress {:optional true} any?]
                                [:data {:optional true} any?]]}
            :handler reply-handler}}]])