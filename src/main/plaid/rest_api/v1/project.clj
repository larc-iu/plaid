(ns plaid.rest-api.v1.project
  (:require [plaid.rest-api.v1.auth :as pra]
            [reitit.coercion.malli]
            [plaid.xtdb.project :as prj]
            [taoensso.timbre :as log]
            [plaid.server.events :as events]
            [clojure.core.async :as async]
            [clojure.data.json :as json]
            [org.httpkit.server :as http-kit]))

(defn sse-handler
  "Handle SSE connections for project audit log events"
  [{{{:keys [id]} :path} :parameters :as req}]
  ;; TODO: for some reason, JS client never disconnects...
  (http-kit/as-channel req
      {:on-open  (fn [channel]
                 (let [client-chan (async/chan (async/sliding-buffer 100))
                       stop-chan (async/chan)]

                   ;; Register client for this project
                   (events/register-client! id client-chan)
                   (log/debug "New SSE client connected for project" id
                              "- Total clients:" (events/get-client-count))

                   ;; Send SSE headers
                   (http-kit/send! channel
                                   {:status  200
                                    :headers {"Content-Type"  "text/event-stream"
                                              "Cache-Control" "no-cache"
                                              "Connection"    "keep-alive"}}
                                   false)  ; don't close connection

                   ;; Send initial connection message
                   (http-kit/send! channel "event: connected\ndata: {\"status\": \"connected\"}\n\n" false)

                   ;; Start heartbeat loop with failure detection
                   (async/go-loop [heartbeat-failures 0]
                     (let [[_ ch] (async/alts! [(async/timeout 3000) stop-chan])]
                       (if (= ch stop-chan)
                         nil  ; exit loop on stop signal
                         (let [send-success
                               (try
                                 ;; Check if channel is still open before sending
                                 (if (http-kit/send! channel "event: heartbeat\ndata: \"ping\"\n\n" false)
                                   (do (log/debug "Heartbeat sent successfully for project" id)
                                       true)
                                   (do (log/warn "Heartbeat send failed for project" id "- send returned false")
                                       false))
                                 (catch Exception e
                                   (log/warn "Heartbeat failed for project" id ":" (.getMessage e))
                                   false))]
                           (if send-success
                             (recur 0)  ; reset failure count
                             (if (< heartbeat-failures 3)  ; allow only 1 failure before cleanup
                               (recur (inc heartbeat-failures))
                               (do
                                 (log/info "Too many heartbeat failures, cleaning up connection for project" id)
                                 (events/cleanup-channel! channel)
                                 nil)))))))

                   ;; Main event loop
                   (async/go-loop []
                     (let [[event ch] (async/alts! [client-chan stop-chan])]
                       (cond
                         (= ch stop-chan) nil ; exit loop on stop signal
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
                                     (log/warn "Event send failed for project" id ":" (.getMessage e))))
                                 (recur))
                         :else nil)))  ; channel closed, exit

                   ;; Store mapping for cleanup using the channel itself as key
                   (events/register-channel-mapping! channel client-chan id stop-chan)))

       :on-close (fn [channel _]
                   (log/debug "SSE connection closed, cleaning up channel for project" id)
                   (events/cleanup-channel! channel)
                   (log/debug "After cleanup - Total clients:" (events/get-client-count)))}))

(def project-routes
  ["/projects"

   [""
    {:get  {:summary "List all projects accessible to user"
            :handler (fn [{db :db user-id :user/id :as req}]
                       {:status 200
                        :body   (prj/get-accessible db user-id)})}
     :post {:summary    "Create a new project. Note: this also registers the user as a maintainer."
            :parameters {:body {:name string?}}
            :handler    (fn [{{{:keys [name]} :body} :parameters xtdb :xtdb user-id :user/id :as req}]
                          (let [result (prj/create {:node xtdb} {:project/name        name
                                                                 :project/maintainers [user-id]} user-id)]
                            (if (:success result)
                              {:status 201
                               :body   {:id (:extra result)}}
                              {:status (or (:code result) 500)
                               :body   {:error (:error result)}})))}}]

   ["/:id"
    {:parameters {:path [:map [:id :uuid]]}
     :get        {:summary    "Get a project by ID. If <body>include-documents</body> is true, also include document IDs and names."
                  :middleware [[pra/wrap-reader-required #(-> % :parameters :path :id)]]
                  :parameters {:query [:map [:include-documents {:optional true} boolean?]]}
                  :handler    (fn [{{{:keys [id]}                :path
                                     {:keys [include-documents]} :query} :parameters
                                    db                                   :db}]
                                (let [project (prj/get db id include-documents)]
                                  (if (some? project)
                                    {:status 200
                                     :body   project}
                                    {:status 404
                                     :body   {:error "Project not found"}})))}

     :patch      {:summary    "Update a project's name."
                  :middleware [[pra/wrap-maintainer-required #(-> % :parameters :path :id)]]
                  :parameters {:body [:map [:name string?]]}
                  :handler    (fn [{{{:keys [id]} :path {:keys [name]} :body} :parameters xtdb :xtdb user-id :user/id :as req}]
                                (let [{:keys [success code error]} (prj/merge {:node xtdb} id {:project/name name} user-id)]
                                  (if success
                                    {:status 200
                                     :body   (prj/get xtdb id)}
                                    {:status (or code 500)
                                     :body   {:error error}})))}

     :delete     {:summary    "Delete a project."
                  :middleware [[pra/wrap-maintainer-required #(-> % :parameters :path :id)]]
                  :handler    (fn [{{{:keys [id]} :path} :parameters xtdb :xtdb user-id :user/id :as req}]
                                (let [{:keys [success code error]} (prj/delete {:node xtdb} id user-id)]
                                  (if success
                                    {:status 204}
                                    {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]

   ;; Access management endpoints
   ["/:id"
    {:middleware [[pra/wrap-maintainer-required #(-> % :parameters :path :id)]]}
    ["/readers/:user-id"
     {:post   {:summary    "Set a user's access level to read-only for this project."
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler    (fn [{{{:keys [id user-id]} :path} :parameters xtdb :xtdb actor-user-id :user/id :as req}]
                             (let [{:keys [success code error]} (prj/add-reader {:node xtdb} id user-id actor-user-id)]
                               (if success
                                 {:status 204}
                                 {:status (or code 500) :body {:error error}})))}

      :delete {:summary    "Remove a user's reader privileges for this project."
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler    (fn [{{{:keys [id user-id]} :path} :parameters xtdb :xtdb actor-user-id :user/id :as req}]
                             (let [{:keys [success code error]} (prj/remove-reader {:node xtdb} id user-id actor-user-id)]
                               (if success
                                 {:status 204}
                                 {:status (or code 500) :body {:error error}})))}}]
    ["/writers/:user-id"
     {:post   {:summary    "Set a user's access level to read and write for this project."
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler    (fn [{{{:keys [id user-id]} :path} :parameters xtdb :xtdb actor-user-id :user/id :as req}]
                             (let [{:keys [success code error]} (prj/add-writer {:node xtdb} id user-id actor-user-id)]
                               (if success
                                 {:status 204}
                                 {:status (or code 500) :body {:error error}})))}

      :delete {:summary    "Remove a user's writer privileges for this project."
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler    (fn [{{{:keys [id user-id]} :path} :parameters xtdb :xtdb actor-user-id :user/id :as req}]
                             (let [{:keys [success code error]} (prj/remove-writer {:node xtdb} id user-id actor-user-id)]
                               (if success
                                 {:status 204}
                                 {:status (or code 500) :body {:error error}})))}}]
    ["/maintainers/:user-id"
     {:post   {:summary    "Assign a user as a maintainer for this project."
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler    (fn [{{{:keys [id user-id]} :path} :parameters xtdb :xtdb actor-user-id :user/id :as req}]
                             (let [{:keys [success code error]} (prj/add-maintainer {:node xtdb} id user-id actor-user-id)]
                               (if success
                                 {:status 204}
                                 {:status (or code 500) :body {:error error}})))}

      :delete {:summary    "Remove a user's maintainer privileges for this project."
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler    (fn [{{{:keys [id user-id]} :path} :parameters xtdb :xtdb actor-user-id :user/id :as req}]
                             (let [{:keys [success code error]} (prj/remove-maintainer {:node xtdb} id user-id actor-user-id)]
                               (if success
                                 {:status 204}
                                 {:status (or code 500) :body {:error error}})))}}]]

   ;; SSE endpoint for audit log events
   ["/:id/listen"
    {:parameters {:path [:map [:id :uuid]]}
     :get        {:summary    "Listen to audit log events and messages for a project via Server-Sent Events"
                  :middleware [[pra/wrap-reader-required #(-> % :parameters :path :id)]]
                  :openapi    {:x-client-method "listen"}
                  :handler    sse-handler}}]

   ;; Message endpoint for sending arbitrary messages to project subscribers
   ["/:id/message"
    {:parameters {:path [:map [:id :uuid]]}
     :post       {:summary    (str "Send a message to all clients that are listening to a project. "
                                   "Useful for e.g. telling an NLP service to perform some work.")
                  :middleware [[pra/wrap-writer-required #(-> % :parameters :path :id)]]
                  :openapi    {:x-client-method "send-message"}
                  :parameters {:body any?}  ; Accept any JSON payload
                  :handler    (fn [{{{:keys [id]} :path
                                     body         :body} :parameters
                                    user-id              :user/id
                                    :as                  req}]
                                (if (events/publish-message! id body user-id)
                                  {:status 200
                                   :body   {:success true
                                            :message "Message sent to subscribers"}}
                                  {:status 500
                                   :body   {:error "Failed to publish message"}}))}}]])
