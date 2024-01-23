(ns glam.server.rest-api.token-layer
  (:require [glam.server.pathom-parser :refer [parser]]
            [glam.server.id-counter :refer [id?]]
            [glam.models.token-layer :as tokl]
            [glam.server.rest-api.util :as util]
            [malli.experimental.lite :as ml])
  (:import (java.util UUID)))

(defn create-token-layer [{{{:keys [name token-layer]} :body} :parameters :as req}]
  (let [params {:delta {:token-layer/name {:after name}}
                :ident [:token-layer/id (UUID/randomUUID)]
                :parent-ident [:token-layer/id token-layer]}
        result (parser req [(list `tokl/create-token-layer params)])
        data (get result `tokl/create-token-layer)]
    (if (:server/error? data)
      {:status 400
       :body   data}
      {:status 200
       :body   {:id (-> data
                        (dissoc :tempids)
                        (assoc :id (-> data :tempids first second)))
                :message "Token layer created."}})))

(defn get-token-layer [{{{:keys [id]} :path} :parameters :as req}]
  (let [result (parser req [{[:token-layer/id id] [:token-layer/id :token-layer/name :config]}])
        data (get result [:token-layer/id id])]
    (if (= 1 (count data))
      {:status 404
       :body {:error true :message "Token layer does not exist."}}
      {:status 200
       :body data})))

(defn delete-token-layer [{{{:keys [id]} :path} :parameters :as req}]
  (let [result (parser req [(list `tokl/delete-token-layer {:ident [:token-layer/id id]})])
        data (get result `tokl/delete-token-layer)]
    (if (:server/error? data)
      {:status 400
       :body {:error true :message "Token layer does not exist."}}
      {:status 200
       :body data})))

(defn patch-token-layer [{{{:keys [id]} :path
                          {:keys [action name up]} :body} :parameters :as req}]
  (let [action-symbol ({"setName" `tokl/save-token-layer
                        "shift" `tokl/shift-token-layer} action)
        action-params ({"setName" {:delta {:token-layer/name {:after name}} :ident [:token-layer/id id]}
                        "shift"   {:id id :up? up}} action)]
    (if (nil? action-symbol)
      {:status 400
       :body {:error true :message (str "Unknown action: `" action "`")}}
      (let [result (parser req [(list action-symbol action-params)])
            data (get result action-symbol)]
        (if (:server/error? data)
          {:status 400
           :body   data}
          {:status 200
           :body   (if (= action-symbol `tokl/save-token-layer)
                     {:message (str "Token layer name changed to " name)
                      :error   false}
                     data)})))))

(def token-layer-routes
  ["/token"
   [""
    {:post {:parameters  {:body {:name        string?
                                 :token-layer id?}}
            :description "Creates a new token layer. ID is given in the response under \"id\"."
            :handler    create-token-layer}}]
   ["/:id"
    {:get {:parameters {:path {:id id?}}
           :handler    get-token-layer}
     :delete {:parameters {:path {:id id?}}
              :handler    delete-token-layer}
     :patch
     {:parameters {:path {:id id?}
                   :body {:action [:enum "setName" "shift"]
                          :name (ml/optional string?)
                          :up   (ml/optional boolean?)}}
      :description (str "setName: sets the token layer's `name` to body param `name`."
                        "\nshift: Moves the token layer up or down relative to other token layers, "
                        "depending on whether `up` is true or false.")
      :handler patch-token-layer}}]])

