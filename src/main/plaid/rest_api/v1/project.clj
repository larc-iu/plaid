(ns plaid.rest-api.v1.project
  (:require [plaid.rest-api.v1.auth :as pra]
            [reitit.coercion.malli]
            [plaid.xtdb.project :as prj]
            [plaid.xtdb.common :as pxc]
            [xtdb.api :as xt]))

(def project-routes
  ["/projects"

   [""
    {:get  {:summary "List all projects accessible to user"
            :handler (fn [{xtdb :xtdb}]
                       {:status 200
                        :body   (prj/get-all xtdb)})}
     :post {:summary    "Create a new project. Note: this also registers the user as a maintainer."
            :parameters {:body {:name string?}}
            :handler    (fn [{{{:keys [name]} :body} :parameters xtdb :xtdb :as req}]
                          (let [user-id (-> req :jwt-data :user/id)
                                result (prj/create {:node xtdb} {:project/name        name
                                                                 :project/maintainers [user-id]})]
                            (if (:success result)
                              {:status 201
                               :body   {:id (:extra result)}}
                              {:status (or (:code result) 500)
                               :body   {:error (:error result)}})))}}]

   ["/:id"
    {:get    {:summary    "Get a project by ID"
              :middleware [[pra/wrap-readable-required :project/id]]
              :parameters {:path [:map [:id :uuid]]}
              :handler    (fn [{{{:keys [id]} :path} :parameters xtdb :xtdb}]
                            (let [project (prj/get xtdb id)]
                              (if (some? project)
                                {:status 200
                                 :body   project}
                                {:status 404
                                 :body   {:error "Project not found"}})))}

     :patch  {:summary    "Update a project's name."
              :middleware [[pra/wrap-writeable-required :project/id]]
              :parameters {:path [:map [:id :uuid]]
                           :body [:map [:name string?]]}
              :handler    (fn [{{{:keys [id]} :path {:keys [name]} :body} :parameters xtdb :xtdb}]
                            (let [{:keys [success code error]} (prj/merge {:node xtdb} id {:project/name name})]
                              (if success
                                {:status 200
                                 :body   (prj/get xtdb id)}
                                {:status (or code 500)
                                 :body   {:error error}})))}

     :delete {:summary    "Delete a project"
              :middleware [[pra/wrap-writeable-required :project/id]]
              :parameters {:path [:map [:id :uuid]]}
              :handler    (fn [{{{:keys [id]} :path} :parameters xtdb :xtdb}]
                            (let [{:keys [success code error]} (prj/delete {:node xtdb} id)]
                              (if success
                                {:status 204}
                                {:status (or code 404) :body {:error error}})))}}]

   ["/:id/layers/:layer-id/config/:editor-name/:config-key"
    {:middleware [[pra/wrap-writeable-required :project/id]]
     :put        {:summary    "Set a configuration value for a layer in a specific editor namespace"
                  :parameters {:path [:map [:layer-id string?] [:editor-name string?] [:config-key string?]]
                               :body any?}
                  :handler    (fn [{{{:keys [layer-id editor-name config-key]} :path config-value :body} :parameters xtdb :xtdb}]
                                (let [{:keys [success code error]} (prj/assoc-editor-config-pair {:node xtdb} layer-id editor-name config-key config-value)]
                                  (if success
                                    {:status 204}
                                    {:status (or code 400)
                                     :body   {:error error}})))}

     :delete     {:summary    "Remove a configuration value for a layer in a specific editor namespace"
                  :parameters {:path [:map [:layer-id string?] [:editor-name string?] [:config-key string?]]}
                  :handler    (fn [{{{:keys [layer-id editor-name config-key]} :path} :parameters xtdb :xtdb}]
                                (let [{:keys [success code error]} (prj/dissoc-editor-config-pair {:node xtdb} layer-id editor-name config-key)]
                                  (if success
                                    {:status 204}
                                    {:status (or code 400)
                                     :body   {:error error}})))}}]

   ;; Access management endpoints
   ["/:id"
    {:middleware [[pra/wrap-maintainer-required #(-> % :parameters :path :id)]]}
    ["/readers/:user-id"
     {:post   {:summary    "Add a user as a reader to the project"
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler    (fn [{{{:keys [id user-id]} :path} :parameters xtdb :xtdb}]
                             (let [{:keys [success code error]} (prj/add-reader {:node xtdb} id user-id)]
                               (if success
                                 {:status 204}
                                 {:status (or code 400) :body {:error error}})))}

      :delete {:summary    "Remove a user's reader access from the project"
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler    (fn [{{{:keys [id user-id]} :path} :parameters xtdb :xtdb}]
                             (let [{:keys [success code error]} (prj/remove-reader {:node xtdb} id user-id)]
                               (if success
                                 {:status 204}
                                 {:status (or code 400) :body {:error error}})))}}]
    ["/writers/:user-id"
     {:post   {:summary    "Add a user as a writer to the project"
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler    (fn [{{{:keys [id user-id]} :path} :parameters xtdb :xtdb}]
                             (let [{:keys [success code error]} (prj/add-writer {:node xtdb} id user-id)]
                               (if success
                                 {:status 204}
                                 {:status (or code 400) :body {:error error}})))}

      :delete {:summary    "Remove a user's writer access from the project"
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler    (fn [{{{:keys [id user-id]} :path} :parameters xtdb :xtdb}]
                             (let [{:keys [success code error]} (prj/remove-writer {:node xtdb} id user-id)]
                               (if success
                                 {:status 204}
                                 {:status (or code 400) :body {:error error}})))}}]
    ["/maintainers/:user-id"
     {:post   {:summary    "Add a user as a maintainer to the project"
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler    (fn [{{{:keys [id user-id]} :path} :parameters xtdb :xtdb}]
                             (let [{:keys [success code error]} (prj/add-maintainer {:node xtdb} id user-id)]
                               (if success
                                 {:status 204}
                                 {:status (or code 400) :body {:error error}})))}

      :delete {:summary    "Remove a user's maintainer access from the project"
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler    (fn [{{{:keys [id user-id]} :path} :parameters xtdb :xtdb}]
                             (let [{:keys [success code error]} (prj/remove-maintainer {:node xtdb} id user-id)]
                               (if success
                                 {:status 204}
                                 {:status (or code 400) :body {:error error}})))}}]]])
