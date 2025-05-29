(ns plaid.rest-api.v1.user
  (:require [reitit.coercion.malli]
            [buddy.hashers :as hashers]
            [plaid.xtdb.user :as pxu]
            [plaid.rest-api.v1.middleware :as prm]
            [xtdb.api :as xt]))

(defn filter-keys
  [u]
  (-> u
      (dissoc :user/password-hash)
      (dissoc :user/password-changes)
      (dissoc :xt/id)))

(def user-routes-admin
  ["/users"
   {:openapi {:security [{:auth []}]}}

   [""
    {:get  {:summary "List all users"
            :handler (fn [{xtdb :xtdb}]
                       {:status 200
                        :body   (->> (pxu/get-all xtdb)
                                     (map filter-keys))})}
     :post {:summary    "Create a new user"
            :parameters {:body {:username string? :password string? :is-admin boolean?}}
            :handler    (fn [{{{:keys [username password is-admin]} :body} :parameters xtdb :xtdb}]
                          (let [result (pxu/create {:node xtdb} username is-admin password)]
                            (if (:success result)
                              {:status 201
                               :body   {:id (:extra result)}}
                              {:status (or (:code result) 500)
                               :body   {:error (:error result)}})))}}]

   ["/:id"
    {:get    {:summary    "Get a user by ID"
              :parameters {:path [:map [:id string?]]}
              :handler    (fn [{{{:keys [id]} :path} :parameters xtdb :xtdb}]
                            (let [user (pxu/get xtdb id)]
                              (if (some? user)
                                {:status 200
                                 :body   (filter-keys user)}
                                {:status 404
                                 :body   {:error "User not found"}})))}

     :delete {:summary    "Delete a user"
              :parameters {:path [:map [:id string?]]}
              :handler    (fn [{{{:keys [id]} :path} :parameters xtdb :xtdb}]
                            (let [{:keys [success code error]} (pxu/delete {:node xtdb} id)]
                              (if success
                                {:status 204}
                                {:status (or code 404) :body {:error error}})))}}]])