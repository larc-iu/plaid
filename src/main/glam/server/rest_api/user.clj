(ns glam.server.rest-api.user
  (:require [glam.server.pathom-parser :refer [parser]]
            [glam.server.id-counter :refer [id?]]
            [glam.models.user :as usr]
            [glam.server.rest-api.util :as util]
            [malli.experimental.lite :as ml])
  (:import (java.util UUID)))


(defn get-user [{{{:keys [id]} :path} :parameters :as req}]
  (let [result (parser req [{[:user/id id] [:user/id :user/name :user/admin?]}])
        data (get result [:user/id id])]
    (if (= 1 (count data))
      {:status 404
       :body {:error true :message "User does not exist."}}
      {:status 200
       :body data})))

(defn change-own-password [{{{:keys [currentPassword newPassword]} :body} :parameters :as req}]
  (let [result (parser req [(list `usr/change-own-password {:current-password currentPassword :new-password newPassword})])
        data (get result `usr/change-own-password)]
    {:body data
     :status (if (:server/error? data) 400 200)}))

(defn change-own-name [{{{:keys [name]} :body} :parameters :as req}]
  (let [result (parser req [(list `usr/change-own-name {:name name})])
        data (get result `usr/change-own-name)]
    {:body data
     :status (if (:server/error? data) 400 200)}))

(def user-routes
  ["/user"
   ["/:id"
    {:get {:handler get-user
           :parameters {:path {:id id?}}}}]
   ["ChangeOwnPassword"
    {:patch {:handler change-own-password
             :parameters {:body {:currentPassword string? :newPassword string?}}}}]
   ["ChangeOwnName"
    {:patch {:handler change-own-name
             :parameters {:body {:name string?}}}}]])

;; Admin --------------------------------------------------------------------------------
(defn all-users [req]
  (let [result (parser req [{:all-users [:user/id :user/name :user/email :user/admin?]}])
        data (get result :all-users)]
    {:status 200
     :body data}))

(defn admin-get-user [{{{:keys [id]} :path} :parameters :as req}]
  (let [result (parser req [{[:user/id id] [:user/id :user/name :user/email :user/admin?]}])
        data (get result [:user/id id])]
    (if (= 1 (count data))
      {:status 404
       :body {:error true :message "User does not exist."}}
      {:status 200
       :body data})))

(defn create-user [{{{:keys [name email password]} :body} :parameters :as req}]
  (let [params {:delta {:user/name {:after name}
                        :user/email {:after email}
                        :user/password {:after password}}
                :ident [:user/id (UUID/randomUUID)]}
        result (parser req [(list `usr/create-user params)])
        data (get result `usr/create-user)]
    (if (:server/error? data)
      {:status 400
       :body   data}
      {:status 200
       :body   {:id (-> data
                        (dissoc :tempids)
                        (assoc :id (-> data :tempids first second)))
                :message "User created."}})))

(defn delete-user [{{{:keys [id]} :path} :parameters :as req}]
  (let [result (parser req [(list `usr/delete-user {:ident [:user/id id]})])
        data (get result `usr/delete-user)]
    (if (:server/error? data)
      {:status 400
       :body {:error true :message "User does not exist."}}
      {:status 200
       :body data})))

(defn patch-user [{{{:keys [id]} :path
                           {:keys [email name password]} :body} :parameters :as req}]
  (let [action-symbol `usr/save-user
        action-params (cond-> {:ident [:user/id id] :delta {}}
                              (some? name) (update :delta assoc :user/name {:after name})
                              (some? email) (update :delta assoc :user/email {:after email})
                              (some? password) (update :delta assoc :user/new-password {:after password}))]
    (let [result (parser req [(list action-symbol action-params)])
          data (get result action-symbol)]
      (if (:server/error? data)
        {:status 400
         :body   data}
        {:status 200
         :body   data}))))

(def user-admin-routes
  [""
   ["/users"
    {:get {:handler all-users}}]
   ["/user"
    [""
     {:post {:parameters  {:body {:name string?
                                  :password string?
                                  :email string?}}
             :description "Creates a new user. ID is given in the response under \"id\"."
             :handler     create-user}}]
    ["/:id"
     [""
      {:get    {:parameters {:path {:id id?}}
                :handler    admin-get-user}
       :delete {:parameters {:path {:id id?}}
                :handler    delete-user}
       :patch
       {:parameters  {:path {:id id?}
                      :body {:email (ml/optional string?)
                             :password (ml/optional string?)
                             :name (ml/optional string?)}}
        :description (str "Updates any of the fields provided.")
        :handler     patch-user}}]]]])

