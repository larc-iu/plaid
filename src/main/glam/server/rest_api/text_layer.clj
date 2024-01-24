(ns glam.server.rest-api.text-layer
  (:require [glam.server.pathom-parser :refer [parser]]
            [glam.server.id-counter :refer [id?]]
            [glam.models.text-layer :as txtl]
            [glam.server.rest-api.util :as util]
            [glam.server.rest-api.common :refer [config-fragment]]
            [malli.experimental.lite :as ml])
  (:import (java.util UUID)))

(defn create-text-layer [{{{:keys [name project]} :body} :parameters :as req}]
  (let [params {:delta {:text-layer/name {:after name}}
                :ident [:text-layer/id (UUID/randomUUID)]
                :parent-ident [:project/id project]}
        result (parser req [(list `txtl/create-text-layer params)])
        data (get result `txtl/create-text-layer)]
    (if (:server/error? data)
      {:status 400
       :body   data}
      {:status 200
       :body   {:id (-> data
                        (dissoc :tempids)
                        (assoc :id (-> data :tempids first second)))
                :message "Text layer created."}})))

(defn get-text-layer [{{{:keys [id]} :path} :parameters :as req}]
  (let [result (parser req [{[:text-layer/id id] [:text-layer/id :text-layer/name :config]}])
        data (get result [:text-layer/id id])]
    (if (= 1 (count data))
      {:status 404
       :body {:error true :message "Text layer does not exist."}}
      {:status 200
       :body data})))

(defn delete-text-layer [{{{:keys [id]} :path} :parameters :as req}]
  (let [result (parser req [(list `txtl/delete-text-layer {:ident [:text-layer/id id]})])
        data (get result `txtl/delete-text-layer)]
    (if (:server/error? data)
      {:status 400
       :body {:error true :message "Text layer does not exist."}}
      {:status 200
       :body data})))

(defn patch-text-layer [{{{:keys [id]} :path
                           {:keys [action name up]} :body} :parameters :as req}]
  (let [action-symbol ({"setName" `txtl/save-text-layer
                        "shift" `txtl/shift-text-layer} action)
        action-params ({"setName" {:delta {:text-layer/name {:after name}} :ident [:text-layer/id id]}
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
           :body   (if (= action-symbol `txtl/save-text-layer)
                     {:message (str "Text layer name changed to " name)
                      :error   false}
                     data)})))))

(def text-layer-routes
  ["/text"
   [""
    {:post {:parameters  {:body {:name    string?
                                 :project id?}}
            :description "Creates a new text layer. ID is given in the response under \"id\"."
            :handler    create-text-layer}}]
   ["/:id"
    [""
     {:get    {:parameters {:path {:id id?}}
               :handler    get-text-layer}
      :delete {:parameters {:path {:id id?}}
               :handler    delete-text-layer}
      :patch
      {:parameters  {:path {:id id?}
                     :body {:action [:enum "setName" "shift"]
                            :name   (ml/optional string?)
                            :up     (ml/optional boolean?)}}
       :description (str "setName: sets the text layer's `name` to body param `name`."
                         "\nshift: Moves the text layer up or down relative to other text layers, "
                         "depending on whether `up` is true or false.")
       :handler     patch-text-layer}}]
    config-fragment]])

