(ns plaid.rest-api.v1.project
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.layer :refer [layer-config-routes]]
            [plaid.rest-api.v1.pagination :as pagination]
            [reitit.coercion.malli]
            [taoensso.timbre :as log]
            [plaid.sql.project :as prj]))

(defonce ^{:doc "When true, a project delete fires a background sweep to purge
  the (now-deleted, un-time-travelable) project's operations + audit_writes —
  see `prj/purge-deleted-project-history!`. DISABLED by default so the test
  suite, which deletes projects via REST and then asserts on their audit rows,
  never races a sweep. The HTTP server flips it true at startup
  (`plaid.server.http-server`), a path tests never run."}
  purge-deleted-projects? (atom false))

(defn get-project-id [{params :parameters}]
  (-> params :path :id))

(def project-routes
  ["/projects"

   [""
    {:get {:summary "List all projects accessible to user"
           :parameters {:query (into [:map] pagination/query-params)}
           :handler (fn [{db :db user-id :user/id {query :query} :parameters}]
                      (pagination/list-response
                       query
                       (fn [opts] (prj/get-accessible db user-id opts))))}
     :post {:summary "Create a new project. Note: this also registers the user as a maintainer."
            :parameters {:body {:name string?}}
            :handler (fn [{{{:keys [name]} :body} :parameters db :db user-id :user/id :as req}]
                       (let [result (prj/create db {:project/name name
                                                    :project/maintainers [user-id]} user-id)]
                         (if (:success result)
                           {:status 201
                            :body {:id (:extra result)}}
                           {:status (or (:code result) 500)
                            :body {:error (:error result)}})))}}]

   ["/:id"
    {:parameters {:path [:map [:id :uuid]]}
     :get {:summary "Get a project by ID."
           :middleware [[pra/wrap-reader-required get-project-id]]
           :handler (fn [{{{:keys [id]} :path} :parameters
                          db :db}]
                      (let [project (prj/get db id)]
                        (if (some? project)
                          {:status 200
                           :body project}
                          {:status 404
                           :body {:error "Project not found"}})))}

     :patch {:summary "Update a project's name."
             :middleware [[pra/wrap-maintainer-required get-project-id]]
             :parameters {:body [:map [:name string?]]}
             :handler (fn [{{{:keys [id]} :path {:keys [name]} :body} :parameters db :db user-id :user/id :as req}]
                        (let [{:keys [success code error]} (prj/merge db id {:project/name name} user-id)]
                          (if success
                            {:status 200
                             :body (prj/get db id)}
                            {:status (or code 500)
                             :body {:error error}})))}

     :delete {:summary "Delete a project."
              :middleware [[pra/wrap-maintainer-required get-project-id]]
              :handler (fn [{{{:keys [id]} :path} :parameters db :db user-id :user/id :as req}]
                         (let [{:keys [success code error]} (prj/delete db id user-id)]
                           (if success
                             (do
                               ;; Delete stays fast (it doesn't audit descendants).
                               ;; Reclaim the project's op/audit history in the
                               ;; background. Best-effort; gated so tests don't race.
                               (when @purge-deleted-projects?
                                 (future
                                   (try
                                     (log/info "Purged history for deleted project" id
                                               (prj/purge-deleted-project-history! db id))
                                     (catch Throwable t
                                       (log/warn t "Background purge failed for deleted project" id)))))
                               {:status 204})
                             {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]

   ;; Documents (keyset-paginated)
   ["/:id/documents"
    {:get {:summary "List documents in a project."
           :middleware [[pra/wrap-reader-required get-project-id]]
           :parameters {:path [:map [:id :uuid]]
                        :query (into [:map] pagination/query-params)}
           :handler (fn [{{{:keys [id]} :path query :query} :parameters db :db}]
                      (pagination/list-response
                       query
                       (fn [opts] (prj/get-documents-page db id opts))))}}]

   ;; Access management endpoints
   ["/:id"
    {:middleware [[pra/wrap-maintainer-required get-project-id]]}
    ["/readers/:user-id"
     {:post {:summary "Set a user's access level to read-only for this project."
             :parameters {:path [:map [:id :uuid] [:user-id string?]]}
             :handler (fn [{{{:keys [id user-id]} :path} :parameters db :db actor-user-id :user/id :as req}]
                        (let [{:keys [success code error]} (prj/add-reader db id user-id actor-user-id)]
                          (if success
                            {:status 204}
                            {:status (or code 500) :body {:error error}})))}

      :delete {:summary "Remove a user's reader privileges for this project."
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler (fn [{{{:keys [id user-id]} :path} :parameters db :db actor-user-id :user/id :as req}]
                          (let [{:keys [success code error]} (prj/remove-reader db id user-id actor-user-id)]
                            (if success
                              {:status 204}
                              {:status (or code 500) :body {:error error}})))}}]
    ["/writers/:user-id"
     {:post {:summary "Set a user's access level to read and write for this project."
             :parameters {:path [:map [:id :uuid] [:user-id string?]]}
             :handler (fn [{{{:keys [id user-id]} :path} :parameters db :db actor-user-id :user/id :as req}]
                        (let [{:keys [success code error]} (prj/add-writer db id user-id actor-user-id)]
                          (if success
                            {:status 204}
                            {:status (or code 500) :body {:error error}})))}

      :delete {:summary "Remove a user's writer privileges for this project."
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler (fn [{{{:keys [id user-id]} :path} :parameters db :db actor-user-id :user/id :as req}]
                          (let [{:keys [success code error]} (prj/remove-writer db id user-id actor-user-id)]
                            (if success
                              {:status 204}
                              {:status (or code 500) :body {:error error}})))}}]
    ["/maintainers/:user-id"
     {:post {:summary "Assign a user as a maintainer for this project."
             :parameters {:path [:map [:id :uuid] [:user-id string?]]}
             :handler (fn [{{{:keys [id user-id]} :path} :parameters db :db actor-user-id :user/id :as req}]
                        (let [{:keys [success code error]} (prj/add-maintainer db id user-id actor-user-id)]
                          (if success
                            {:status 204}
                            {:status (or code 500) :body {:error error}})))}

      :delete {:summary "Remove a user's maintainer privileges for this project."
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler (fn [{{{:keys [id user-id]} :path} :parameters db :db actor-user-id :user/id :as req}]
                          (let [{:keys [success code error]} (prj/remove-maintainer db id user-id actor-user-id)]
                            (if success
                              {:status 204}
                              {:status (or code 500) :body {:error error}})))}}]]

   ;; Vocabs
   ["/:id"
    {:middleware [[pra/wrap-maintainer-required get-project-id]]}
    ["/vocabs/:vocab-id"
     {:post {:summary "Link a vocabulary to a project."
             :parameters {:path [:map [:id :uuid] [:vocab-id :uuid]]}
             :handler (fn [{{{:keys [id vocab-id]} :path} :parameters db :db user-id :user/id :as req}]
                        (let [{:keys [success code error]} (prj/add-vocab db id vocab-id user-id)]
                          (if success
                            {:status 204}
                            {:status (or code 500) :body {:error error}})))}

      :delete {:summary "Unlink a vocabulary to a project."
               :parameters {:path [:map [:id :uuid] [:vocab-id :uuid]]}
               :handler (fn [{{{:keys [id vocab-id]} :path} :parameters db :db user-id :user/id :as req}]
                          (let [{:keys [success code error]} (prj/remove-vocab db id vocab-id user-id)]
                            (if success
                              {:status 204}
                              {:status (or code 500) :body {:error error}})))}}]]

   ;; Config endpoints
   ["/:id"
    {:middleware [[pra/wrap-maintainer-required get-project-id]]}
    (layer-config-routes :id)]])
