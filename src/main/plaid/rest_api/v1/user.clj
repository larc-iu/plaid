(ns plaid.rest-api.v1.user
  (:require [plaid.rest-api.v1.auth :as pra]
            [reitit.coercion.malli]
            [plaid.xtdb.user :as user]))

(defn filter-keys
  [u]
  (-> u
      (dissoc :user/password-hash)
      (dissoc :user/password-changes)
      (dissoc :xt/id)))

(def user-routes
  ["/users"
   {:openapi    {:security [{:auth []}]}
    :middleware [pra/wrap-admin-required]}

   [""
    {:get  {:summary "List all users"
            :handler (fn [{db :db}]
                       {:status 200
                        :body   (->> (user/get-all db)
                                     (map filter-keys))})}
     :post {:summary    "Create a new user"
            :parameters {:body {:username string? :password string? :is-admin boolean?}}
            :handler    (fn [{{{:keys [username password is-admin]} :body} :parameters xtdb :xtdb}]
                          (let [result (user/create {:node xtdb} username is-admin password)]
                            (if (:success result)
                              {:status 201
                               :body   {:id (:extra result)}}
                              {:status (or (:code result) 500)
                               :body   {:error (:error result)}})))}}]

   ["/:id"
    {:parameters {:path [:map [:id string?]]}}
    [""
     {:get    {:summary "Get a user by ID"
               :handler (fn [{{{:keys [id]} :path} :parameters db :db}]
                          (let [user (user/get db id)]
                            (if (some? user)
                              {:status 200
                               :body   (filter-keys user)}
                              {:status 404
                               :body   {:error "User not found"}})))}
      :patch  {:summary    "Modify a user"
               :parameters {:body [:map
                                   [:password {:optional true} string?]
                                   [:username {:optional true} string?]
                                   [:is-admin {:optional true} boolean?]]}
               :handler    (fn [{{{:keys [id]} :path {:keys [username password is-admin]} :body} :parameters xtdb :xtdb}]
                             (let [{:keys [success code error]} (user/merge {:node xtdb}
                                                                            id
                                                                            {:password      password
                                                                             :user/username username
                                                                             :user/is-admin is-admin})]
                               (if success
                                 {:status 200
                                  :body   (select-keys (user/get xtdb id)
                                                       [:user/id :user/username :user/is-admin])}
                                 {:status (or code 500)
                                  :body   {:error error}})))}

      :delete {:summary "Delete a user"
               :handler (fn [{{{:keys [id]} :path} :parameters xtdb :xtdb}]
                          (let [{:keys [success code error]} (user/delete {:node xtdb} id)]
                            (if success
                              {:status 204}
                              {:status (or code 404) :body {:error error}})))}}]]])