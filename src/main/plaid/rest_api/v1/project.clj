(ns plaid.rest-api.v1.project
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.layer :refer [layer-config-routes]]
            [reitit.coercion.malli]
            [plaid.xtdb.project :as prj]
            ))

(defn get-project-id [{params :parameters}]
  (-> params :path :id))

(def project-routes
  ["/projects"

   [""
    {:get {:summary "List all projects accessible to user"
           :handler (fn [{db :db user-id :user/id :as req}]
                      {:status 200
                       :body (prj/get-accessible db user-id)})}
     :post {:summary "Create a new project. Note: this also registers the user as a maintainer."
            :parameters {:body {:name string?}}
            :handler (fn [{{{:keys [name]} :body} :parameters xtdb :xtdb user-id :user/id :as req}]
                       (let [result (prj/create {:node xtdb} {:project/name name
                                                              :project/maintainers [user-id]} user-id)]
                         (if (:success result)
                           {:status 201
                            :body {:id (:extra result)}}
                           {:status (or (:code result) 500)
                            :body {:error (:error result)}})))}}]

   ["/:id"
    {:parameters {:path [:map [:id :uuid]]}
     :get {:summary "Get a project by ID. If <body>include-documents</body> is true, also include document IDs and names."
           :middleware [[pra/wrap-reader-required get-project-id]]
           :parameters {:query [:map [:include-documents {:optional true} boolean?]]}
           :handler (fn [{{{:keys [id]} :path
                           {:keys [include-documents]} :query} :parameters
                          db :db}]
                      (let [project (prj/get db id include-documents)]
                        (if (some? project)
                          {:status 200
                           :body project}
                          {:status 404
                           :body {:error "Project not found"}})))}

     :patch {:summary "Update a project's name."
             :middleware [[pra/wrap-maintainer-required get-project-id]]
             :parameters {:body [:map [:name string?]]}
             :handler (fn [{{{:keys [id]} :path {:keys [name]} :body} :parameters xtdb :xtdb user-id :user/id :as req}]
                        (let [{:keys [success code error]} (prj/merge {:node xtdb} id {:project/name name} user-id)]
                          (if success
                            {:status 200
                             :body (prj/get xtdb id)}
                            {:status (or code 500)
                             :body {:error error}})))}

     :delete {:summary "Delete a project."
              :middleware [[pra/wrap-maintainer-required get-project-id]]
              :handler (fn [{{{:keys [id]} :path} :parameters xtdb :xtdb user-id :user/id :as req}]
                         (let [{:keys [success code error]} (prj/delete {:node xtdb} id user-id)]
                           (if success
                             {:status 204}
                             {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]

   ;; Access management endpoints
   ["/:id"
    {:middleware [[pra/wrap-maintainer-required get-project-id]]}
    ["/readers/:user-id"
     {:post {:summary "Set a user's access level to read-only for this project."
             :parameters {:path [:map [:id :uuid] [:user-id string?]]}
             :handler (fn [{{{:keys [id user-id]} :path} :parameters xtdb :xtdb actor-user-id :user/id :as req}]
                        (let [{:keys [success code error]} (prj/add-reader {:node xtdb} id user-id actor-user-id)]
                          (if success
                            {:status 204}
                            {:status (or code 500) :body {:error error}})))}

      :delete {:summary "Remove a user's reader privileges for this project."
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler (fn [{{{:keys [id user-id]} :path} :parameters xtdb :xtdb actor-user-id :user/id :as req}]
                          (let [{:keys [success code error]} (prj/remove-reader {:node xtdb} id user-id actor-user-id)]
                            (if success
                              {:status 204}
                              {:status (or code 500) :body {:error error}})))}}]
    ["/writers/:user-id"
     {:post {:summary "Set a user's access level to read and write for this project."
             :parameters {:path [:map [:id :uuid] [:user-id string?]]}
             :handler (fn [{{{:keys [id user-id]} :path} :parameters xtdb :xtdb actor-user-id :user/id :as req}]
                        (let [{:keys [success code error]} (prj/add-writer {:node xtdb} id user-id actor-user-id)]
                          (if success
                            {:status 204}
                            {:status (or code 500) :body {:error error}})))}

      :delete {:summary "Remove a user's writer privileges for this project."
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler (fn [{{{:keys [id user-id]} :path} :parameters xtdb :xtdb actor-user-id :user/id :as req}]
                          (let [{:keys [success code error]} (prj/remove-writer {:node xtdb} id user-id actor-user-id)]
                            (if success
                              {:status 204}
                              {:status (or code 500) :body {:error error}})))}}]
    ["/maintainers/:user-id"
     {:post {:summary "Assign a user as a maintainer for this project."
             :parameters {:path [:map [:id :uuid] [:user-id string?]]}
             :handler (fn [{{{:keys [id user-id]} :path} :parameters xtdb :xtdb actor-user-id :user/id :as req}]
                        (let [{:keys [success code error]} (prj/add-maintainer {:node xtdb} id user-id actor-user-id)]
                          (if success
                            {:status 204}
                            {:status (or code 500) :body {:error error}})))}

      :delete {:summary "Remove a user's maintainer privileges for this project."
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler (fn [{{{:keys [id user-id]} :path} :parameters xtdb :xtdb actor-user-id :user/id :as req}]
                          (let [{:keys [success code error]} (prj/remove-maintainer {:node xtdb} id user-id actor-user-id)]
                            (if success
                              {:status 204}
                              {:status (or code 500) :body {:error error}})))}}]]

   ;; Vocabs
   ["/:id"
    {:middleware [[pra/wrap-maintainer-required get-project-id]]}
    ["/vocabs/:vocab-id"
     {:post {:summary "Link a vocabulary to a project."
             :openapi {:x-client-method "link-vocab"}
             :parameters {:path [:map [:id :uuid] [:vocab-id :uuid]]}
             :handler (fn [{{{:keys [id vocab-id]} :path} :parameters xtdb :xtdb user-id :user/id :as req}]
                        (let [{:keys [success code error]} (prj/add-vocab {:node xtdb} id vocab-id user-id)]
                          (if success
                            {:status 204}
                            {:status (or code 500) :body {:error error}})))}

      :delete {:summary "Unlink a vocabulary to a project."
               :openapi {:x-client-method "unlink-vocab"}
               :parameters {:path [:map [:id :uuid] [:vocab-id :uuid]]}
               :handler (fn [{{{:keys [id vocab-id]} :path} :parameters xtdb :xtdb user-id :user/id :as req}]
                          (let [{:keys [success code error]} (prj/remove-vocab {:node xtdb} id vocab-id user-id)]
                            (if success
                              {:status 204}
                              {:status (or code 500) :body {:error error}})))}}]]

   ;; Config endpoints
   ["/:id"
    {:middleware [[pra/wrap-maintainer-required get-project-id]]}
    (layer-config-routes :id)]])
