(ns glam.server.rest-api.session
  (:require [glam.server.pathom-parser :refer [parser]]
            [glam.models.session :as gms]))

(defn login [{{{:keys [username password]} :body} :parameters :as req}]
  (let [result (parser req [(list `gms/login {:username username :password password})])
        {valid? :session/valid? message :server/message :as session-updates} (`gms/login result)
        new-session (merge (:session req) session-updates)]
    (if valid?
      {:status 200 :body {:message "User logged in."} :session new-session}
      {:status 401 :body {:message message}})))

(defn logout [req]
  (let [result (parser req [(list `gms/logout {})])
        session-updates (`gms/logout result)
        new-session (merge (:session req) session-updates)]
    {:status 200 :body {:message "User logged out."} :session new-session}))

(defn register [{{{:keys [username password]} :body} :parameters :as req}]
  (let [result (parser req [(list `gms/signup {:username username :password password})])
        _ (println (`gms/signup result))
        {valid? :session/valid? message :session/server-error-msg :as session-updates} (`gms/signup result)
        new-session (merge (:session req) session-updates)]
    (if valid?
      {:status 200 :body {:message "User created and logged in."} :session new-session}
      {:status 401 :body {:message message}})))

(def session-routes
  ["/session"
   ["/login"
    {:post {:parameters {:body {:username string? :password string?}}
            :handler login}}]
   ["/logout"
    {:post logout}]
   ["/register"
    {:post {:parameters {:body {:username string? :password string?}}
            :handler register}}]])

