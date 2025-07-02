(ns plaid.rest-api.v1.vocab-layer
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.layer :refer [layer-config-routes]]
            [reitit.coercion.malli]
            [plaid.xtdb.vocab-layer :as vocab]
            [plaid.xtdb.user :as user]
            [taoensso.timbre :as log]))

(defn get-vocab-id
  "Extract vocab ID from request parameters"
  [{params :parameters}]
  (-> params :path :id))

(def vocab-layer-routes
  ["/vocab-layers"

   [""
    {:get {:summary "List all vocab layers accessible to user"
           :handler (fn [{db :db user-id :user/id :as req}]
                      {:status 200
                       :body (vocab/get-accessible db user-id)})}
     :post {:summary "Create a new vocab layer. Note: this also registers the user as a maintainer."
            :parameters {:body {:name string?}}
            :handler (fn [{{{:keys [name]} :body} :parameters xtdb :xtdb user-id :user/id :as req}]
                       (let [result (vocab/create {:node xtdb} {:vocab/name name
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
                            xtdb :xtdb
                            user-id :user/id :as req}]
                        (let [{:keys [success code error]} (vocab/merge {:node xtdb} id {:vocab/name name} user-id)]
                          (if success
                            {:status 200
                             :body (vocab/get xtdb id)}
                            {:status (or code 500)
                             :body {:error error}})))}

     :delete {:summary "Delete a vocab layer."
              :middleware [[pra/wrap-vocab-maintainer-required get-vocab-id]]
              :handler (fn [{{{:keys [id]} :path} :parameters
                             xtdb :xtdb
                             user-id :user/id :as req}]
                         (let [{:keys [success code error]} (vocab/delete {:node xtdb} id user-id)]
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
                            xtdb :xtdb
                            actor-user-id :user/id :as req}]
                        (let [{:keys [success code error]} (vocab/add-maintainer {:node xtdb} id user-id actor-user-id)]
                          (if success
                            {:status 204}
                            {:status (or code 500)
                             :body {:error error}})))}

      :delete {:summary "Remove a user's maintainer privileges for this vocab layer."
               :parameters {:path [:map [:id :uuid] [:user-id string?]]}
               :handler (fn [{{{:keys [id user-id]} :path} :parameters
                              xtdb :xtdb
                              actor-user-id :user/id :as req}]
                          (let [{:keys [success code error]} (vocab/remove-maintainer {:node xtdb} id user-id actor-user-id)]
                            (if success
                              {:status 204}
                              {:status (or code 500)
                               :body {:error error}})))}}]]

   ;; Config endpoints
   ["/:id"
    {:middleware [[pra/wrap-vocab-maintainer-required get-vocab-id]]}
    (layer-config-routes :id)]])