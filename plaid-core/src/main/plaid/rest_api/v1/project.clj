(ns plaid.rest-api.v1.project
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.middleware :as prm]
            [plaid.rest-api.v1.layer :refer [layer-config-routes]]
            [plaid.rest-api.v1.pagination :as pagination]
            [plaid.server.project-removal :as removal]
            [reitit.coercion.malli]
            [plaid.sql.operation :as op]
            [plaid.sql.project :as prj]))

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

     :delete {:summary "Delete a project. It is gone at once, and what it holds is removed in the background."
              :middleware [[pra/wrap-maintainer-required get-project-id]]
              :handler (fn [{{{:keys [id]} :path} :parameters datasource :plaid/datasource user-id :user/id db :db}]
                         (let [{:keys [success code error]} (prj/delete db id user-id)]
                           (if success
                             (do
                               ;; After the commit: inside an atomic batch the
                               ;; delete may still roll back.
                               (op/after-commit! #(removal/schedule! datasource id))
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
     ;; Linking or unlinking changes who reaches the vocabulary, which a
     ;; delegated token may not do (`pra/token-scope-gate`).
     {:plaid/vocabulary-admin true
      :post {:summary "Link a vocabulary to a project. Requires maintaining both the project and the vocabulary."
             ;; The link grants every member of the project access to the
             ;; vocabulary, so only someone who already controls who touches
             ;; it may make one. Unlinking only withdraws that grant, so it
             ;; stays with the project maintainer.
             :middleware [[pra/wrap-vocab-maintainer-required
                           (fn [{p :parameters}] (-> p :path :vocab-id))
                           "Only a maintainer of this vocabulary can link it to a project."]]
             :parameters {:path [:map [:id :uuid] [:vocab-id :uuid]]}
             :handler (fn [{{{:keys [id vocab-id]} :path} :parameters db :db user-id :user/id :as req}]
                        (let [{:keys [success code error]} (prj/add-vocab db id vocab-id user-id)]
                          (if success
                            {:status 204}
                            {:status (or code 500) :body {:error error}})))}

      :delete {:summary "Unlink a vocabulary to a project."
               :parameters {:path [:map [:id :uuid] [:vocab-id :uuid]]}
               :handler (fn [{{{:keys [id vocab-id]} :path} :parameters db :db user-id :user/id :as req}]
                          (let [{:keys [success code error documents]}
                                (prj/remove-vocab db id vocab-id user-id)]
                            (if success
                              ;; Unlinking drops the vocabulary's links in this
                              ;; project's documents and bumps their versions.
                              (prm/assoc-document-versions-in-header
                               {:status 204} db documents)
                              {:status (or code 500) :body {:error error}})))}}]]

   ;; Config endpoints
   ["/:id"
    {:middleware [[pra/wrap-maintainer-required get-project-id]]}
    (layer-config-routes :projects :id)]])
