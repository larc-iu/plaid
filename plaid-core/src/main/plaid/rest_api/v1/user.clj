(ns plaid.rest-api.v1.user
  (:require [plaid.rest-api.v1.auth :as pra]
            [reitit.coercion.malli]
            [plaid.xtdb2.user :as user]))

(def user-routes
  ["/users"
   {:openapi {:security [{:auth []}]}
    :middleware [pra/wrap-login-required]}

   [""
    {:get {:summary "List all users"
           :handler (fn [{xt-map :xt-map}]
                      {:status 200
                       :body (user/get-all xt-map)})}
     :post {:summary "Create a new user"
            :middleware [pra/wrap-admin-required]
            :parameters {:body {:username string? :password string? :is-admin boolean?}}
            :handler (fn [{{{:keys [username password is-admin]} :body} :parameters xtdb :xtdb}]
                       (let [result (user/create {:node xtdb} username is-admin password)]
                         (if (:success result)
                           {:status 201
                            :body {:id (:extra result)}}
                           {:status (or (:code result) 500)
                            :body {:error (:error result)}})))}}]

   ["/:id"
    {:parameters {:path [:map [:id string?]]}}
    [""
     {:get {:summary "Get a user by ID"
            :handler (fn [{{{:keys [id]} :path} :parameters xt-map :xt-map}]
                       (let [user (user/get xt-map id)]
                         (if (some? user)
                           {:status 200
                            :body user}
                           {:status 404
                            :body {:error "User not found"}})))}
      :patch {:summary (str "Modify a user. Admins may change the username, password, and admin status of any user. "
                            "All other users may only modify their own username or password.")
              :parameters {:body [:map
                                  [:password {:optional true} string?]
                                  [:username {:optional true} string?]
                                  [:is-admin {:optional true} boolean?]]}
              :handler (fn [{{{:keys [id]} :path {:keys [username password is-admin]} :body} :parameters
                             xtdb :xtdb
                             :as request}]
                         (let [current-user-id (pra/->user-id request)
                               current-user (user/get xtdb current-user-id)
                               is-self? (= id current-user-id)
                               is-admin? (user/admin? current-user)]
                           (cond
                             is-admin?
                             (let [{:keys [success code error]} (user/merge {:node xtdb}
                                                                            id
                                                                            {:password password
                                                                             :user/username username
                                                                             :user/is-admin is-admin})]
                               (if success
                                 {:status 200
                                  :body (user/get xtdb id)}
                                 {:status (or code 500)
                                  :body {:error error}}))

                             (and is-self? (not is-admin))
                             (let [{:keys [success code error]} (user/merge {:node xtdb}
                                                                            id
                                                                            {:password password
                                                                             :user/username username})]
                               (if success
                                 {:status 200
                                  :body (user/get xtdb id)}
                                 {:status (or code 500)
                                  :body {:error error}}))

                             :else
                             {:status 403
                              :body {:error "You can only modify your own username and password"}})))}

      :delete {:summary "Delete a user"
               :middleware [pra/wrap-admin-required]
               :handler (fn [{{{:keys [id]} :path} :parameters xtdb :xtdb}]
                          (let [{:keys [success code error]} (user/delete {:node xtdb} id)]
                            (if success
                              {:status 204}
                              {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]]])
