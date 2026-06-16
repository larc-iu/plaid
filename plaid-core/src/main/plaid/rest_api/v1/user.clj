(ns plaid.rest-api.v1.user
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.pagination :as pagination]
            [reitit.coercion.malli]
            [plaid.sql.user :as user]))

(def user-routes
  ["/users"
   {:openapi {:security [{:auth []}]}
    :middleware [pra/wrap-login-required]}

   [""
    {:get {:summary "List/search users, keyset-paginated by username"
           ;; Task #95 locked the roster down to admins (it was an account-
           ;; enumeration surface for any authenticated caller). It's now also
           ;; open to project AND vocab MAINTAINERS, who need to find users to
           ;; grant project/vocab access — see `wrap-user-directory-access`. Ordinary
           ;; readers/writers still get 403. Optional `?q=` filters to usernames
           ;; containing that text. Returns the uniform {:entries :next-cursor}
           ;; envelope (default page 100, max 1000).
           :middleware [pra/wrap-user-directory-access]
           :parameters {:query (into [:map [:q {:optional true} string?]] pagination/query-params)}
           :handler (fn [{db :db {query :query} :parameters}]
                      (pagination/list-response query (fn [opts] (user/get-all db (assoc opts :q (:q query))))))}
     :post {:summary "Create a new user"
            :middleware [pra/wrap-admin-required]
            :parameters {:body {:username string? :password string? :is-admin boolean?}}
            :handler (fn [{{{:keys [username password is-admin]} :body} :parameters db :db user-id :user/id}]
                       (let [result (user/create db username is-admin password user-id)]
                         (if (:success result)
                           {:status 201
                            :body {:id (:extra result)}}
                           {:status (or (:code result) 500)
                            :body {:error (:error result)}})))}}]

   ["/:id"
    {:parameters {:path [:map [:id string?]]}}
    [""
     {:get {:summary "Get a user by ID"
            :handler (fn [{{{:keys [id]} :path} :parameters db :db}]
                       (let [user (user/get db id)]
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
                             db :db
                             :as request}]
                         (let [current-user-id (pra/->user-id request)
                               current-user (user/get db current-user-id)
                               is-self? (= id current-user-id)
                               is-admin? (user/admin? current-user)]
                           (cond
                             is-admin?
                             (let [{:keys [success code error]} (user/merge db
                                                                            id
                                                                            {:password password
                                                                             :user/username username
                                                                             :user/is-admin is-admin}
                                                                            current-user-id)]
                               (if success
                                 {:status 200
                                  :body (user/get db id)}
                                 {:status (or code 500)
                                  :body {:error error}}))

                             (and is-self? (not is-admin))
                             (let [{:keys [success code error]} (user/merge db
                                                                            id
                                                                            {:password password
                                                                             :user/username username}
                                                                            current-user-id)]
                               (if success
                                 {:status 200
                                  :body (user/get db id)}
                                 {:status (or code 500)
                                  :body {:error error}}))

                             :else
                             {:status 403
                              :body {:error "You can only modify your own username and password"}})))}

      :delete {:summary (str "Deactivate a user. Users are never hard-deleted (audit attribution must "
                             "survive); deactivation rejects their logins and tokens, strips their project "
                             "memberships and vocab maintainerships, and revokes their API tokens. The "
                             "username stays reserved and the user remains visible in listings with a "
                             "<body>deactivated-at</body> timestamp. Reversible via the activate endpoint, "
                             "which restores login only (not memberships or tokens).")
               :middleware [pra/wrap-admin-required]
               :handler (fn [{{{:keys [id]} :path} :parameters db :db user-id :user/id}]
                          (let [{:keys [success code error]} (user/deactivate db id user-id)]
                            (if success
                              {:status 204}
                              {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]
    ["/activate"
     {:post {:summary (str "Reactivate a deactivated user, restoring their ability to log in. Project "
                           "memberships, vocab maintainerships, and API tokens removed at deactivation "
                           "are NOT restored — re-grant them deliberately. 400 if the user is not "
                           "deactivated.")
             :middleware [pra/wrap-admin-required]
             :handler (fn [{{{:keys [id]} :path} :parameters db :db user-id :user/id}]
                        (let [{:keys [success code error]} (user/reactivate db id user-id)]
                          (if success
                            {:status 200 :body (user/get db id)}
                            {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]]])
