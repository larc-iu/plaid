(ns plaid.rest-api.v1.vocab-layer
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.layer :refer [layer-config-routes]]
            [plaid.rest-api.v1.pagination :as pagination]
            [reitit.coercion.malli]
            [plaid.sql.vocab-layer :as vocab]))

(defn get-vocab-id
  "Extract vocab ID from request parameters"
  [{params :parameters}]
  (-> params :path :id))

(def vocab-layer-routes
  ["/vocab-layers"

   [""
    {:get {:summary "List all vocab layers accessible to user"
           :parameters {:query (into [:map] pagination/query-params)}
           :handler (fn [{db :db user-id :user/id {query :query} :parameters}]
                      (pagination/list-response
                       query
                       (fn [opts] (vocab/get-accessible db user-id opts))))}
     :post {:summary "Create a new vocab layer. Note: this also registers the user as a maintainer."
            :parameters {:body {:name string?}}
            :handler (fn [{{{:keys [name]} :body} :parameters db :db user-id :user/id :as req}]
                       (let [result (vocab/create db {:vocab/name name
                                                      :vocab/maintainers [user-id]} user-id)]
                         (if (:success result)
                           {:status 201
                            :body {:id (:extra result)}}
                           {:status (or (:code result) 500)
                            :body {:error (:error result)}})))}}]

   ["/:id"
    {:parameters {:path [:map [:id :uuid]]}
     :get {:summary "Get a vocab layer by ID"
           :middleware [[pra/wrap-vocab-reader-required get-vocab-id]]
           :parameters {:query [:map [:include-items {:optional true} boolean?]]}
           :handler (fn [{{{:keys [id]} :path
                           {:keys [include-items]} :query}
                          :parameters
                          db :db
                          :as req}]
                      (let [vocab-layer (vocab/get db id include-items)]
                        (if vocab-layer
                          {:status 200
                           :body vocab-layer}
                          {:status 404
                           :body {:error "Vocab layer not found"}})))}

     :patch {:summary "Update a vocab layer's name."
             :middleware [[pra/wrap-vocab-maintainer-required get-vocab-id]]
             :parameters {:body [:map [:name string?]]}
             :handler (fn [{{{:keys [id]} :path {:keys [name]} :body} :parameters
                            db :db
                            user-id :user/id :as req}]
                        (let [{:keys [success code error]} (vocab/merge db id {:vocab/name name} user-id)]
                          (if success
                            {:status 200
                             :body (vocab/get db id)}
                            {:status (or code 500)
                             :body {:error error}})))}

     :delete {:summary "Delete a vocab layer."
              :middleware [[pra/wrap-vocab-maintainer-required get-vocab-id]]
              :handler (fn [{{{:keys [id]} :path} :parameters
                             db :db
                             user-id :user/id :as req}]
                         (let [{:keys [success code error]} (vocab/delete db id user-id)]
                           (if success
                             {:status 204}
                             {:status (or code 500)
                              :body {:error (or error "Internal server error")}})))}}]

   ;; Maintainer management endpoints
   ["/:id"
    {:middleware [[pra/wrap-vocab-maintainer-required get-vocab-id]]}
    ["/maintainers/:user-id"
     {:post {:summary "Assign a user as a maintainer for this vocab layer."
             :parameters {:path [:map [:id :uuid] [:user-id string?]]}
             :handler (fn [{{{:keys [id user-id]} :path} :parameters
                            db :db
                            actor-user-id :user/id :as req}]
                        (let [{:keys [success code error]} (vocab/add-maintainer db id user-id actor-user-id)]
                          (if success
                            {:status 204}
                            {:status (or code 500)
                             :body {:error error}})))}

      :delete {:summary "Remove a user's maintainer privileges for this vocab layer."
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler (fn [{{{:keys [id user-id]} :path} :parameters
                              db :db
                              actor-user-id :user/id :as req}]
                          (let [{:keys [success code error]} (vocab/remove-maintainer db id user-id actor-user-id)]
                            (if success
                              {:status 204}
                              {:status (or code 500)
                               :body {:error error}})))}}]]

   ;; Config endpoints
   ["/:id"
    {:middleware [[pra/wrap-vocab-maintainer-required get-vocab-id]]}
    (layer-config-routes :id)]])
