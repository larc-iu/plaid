(ns glam.server.rest-api.span-layer
  (:require [glam.server.pathom-parser :refer [parser]]
            [glam.server.id-counter :refer [id?]]
            [glam.models.span-layer :as sl]
            [glam.server.rest-api.util :as util]
            [malli.experimental.lite :as ml])
  (:import (java.util UUID)))

(defn create-span-layer [{{{:keys [name token-layer]} :body} :parameters :as req}]
  (let [params {:delta {:span-layer/name {:after name}}
                :ident [:span-layer/id (UUID/randomUUID)]
                :parent-ident [:token-layer/id token-layer]}
        result (parser req [(list `sl/create-span-layer params)])
        data (get result `sl/create-span-layer)]
    (if (:server/error? data)
      {:status 400
       :body   data}
      {:status 200
       :body   {:id (-> data
                        (dissoc :tempids)
                        (assoc :id (-> data :tempids first second)))
                :message "Span layer created."}})))

(defn get-span-layer [{{{:keys [id]} :path} :parameters :as req}]
  (let [result (parser req [{[:span-layer/id id] [:span-layer/id :span-layer/name :config]}])
        data (get result [:span-layer/id id])]
    (if (= 1 (count data))
      {:status 404
       :body {:error true :message "Span layer does not exist."}}
      {:status 200
       :body data})))

(defn delete-span-layer [{{{:keys [id]} :path} :parameters :as req}]
  (let [result (parser req [(list `sl/delete-span-layer {:ident [:span-layer/id id]})])
        data (get result `sl/delete-span-layer)]
    (if (:server/error? data)
      {:status 400
       :body {:error true :message "Span layer does not exist."}}
      {:status 200
       :body data})))

(defn patch-span-layer [{{{:keys [id]} :path
                          {:keys [action name up]} :body} :parameters :as req}]
  (let [action-symbol ({"setName" `sl/save-span-layer
                        "shift" `sl/shift-span-layer} action)
        action-params ({"setName" {:delta {:span-layer/name {:after name}} :ident [:span-layer/id id]}
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
           :body   (if (= action-symbol `sl/save-span-layer)
                     {:message (str "Span layer name changed to " name)
                      :error   false}
                     data)})))))

(def span-layer-routes
  ["/span"
   [""
    {:post {:parameters  {:body {:name        string?
                                 :token-layer id?}}
            :description "Creates a new span layer. ID is given in the response under \"id\"."
            :handler    create-span-layer}}]
   ["/:id"
    {:get {:parameters {:path {:id id?}}
           :handler    get-span-layer}
     :delete {:parameters {:path {:id id?}}
              :handler    delete-span-layer}
     :patch
     {:parameters {:path {:id id?}
                   :body {:action [:enum "setName" "shift"]
                          :name (ml/optional string?)
                          :up   (ml/optional boolean?)}}
      :description (str "setName: sets the span layer's `name` to body param `name`."
                        "\nshift: Moves the span layer up or down relative to other span layers, "
                        "depending on whether `up` is true or false.")
      :handler patch-span-layer}}]])
