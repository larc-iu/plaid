(ns glam.server.rest-api.relation-layer
  (:require [glam.server.id-counter :refer [id?]]
            [glam.models.relation-layer :as rl]
            [glam.server.rest-api.util :as util]
            [glam.server.rest-api.common :refer [config-fragment]]
            [malli.experimental.lite :as ml])
  (:import (java.util UUID)))

(defn create-relation-layer [{{{:keys [name span-layer]} :body} :parameters parser :pathom-parser :as req}]
  (let [params {:delta {:relation-layer/name {:after name}}
                :ident [:relation-layer/id (UUID/randomUUID)]
                :parent-ident [:span-layer/id span-layer]}
        result (parser req [(list `rl/create-relation-layer params)])
        data (get result `rl/create-relation-layer)]
    (if (:server/error? data)
      {:status (:server/code data)
       :body   data}
      {:status 200
       :body   {:id (-> data
                        (dissoc :tempids)
                        (assoc :id (-> data :tempids first second)))
                :message "Relation layer created."}})))

(defn get-relation-layer [{{{:keys [id]} :path} :parameters parser :pathom-parser :as req}]
  (let [result (parser req [{[:relation-layer/id id] [:relation-layer/id :relation-layer/name :config]}])
        data (get result [:relation-layer/id id])]
    (if (util/failed-get? data)
      {:status 404
       :body {:error true :message "Relation layer does not exist."}}
      {:status 200
       :body data})))

(defn delete-relation-layer [{{{:keys [id]} :path} :parameters parser :pathom-parser :as req}]
  (let [result (parser req [(list `rl/delete-relation-layer {:ident [:relation-layer/id id]})])
        data (get result `rl/delete-relation-layer)]
    (if (:server/error? data)
      {:status (:server/code data)
       :body {:error true :message "Relation layer does not exist."}}
      {:status 200
       :body data})))

(defn patch-relation-layer [{{{:keys [id]} :path
                          {:keys [action name up]} :body} :parameters
                         parser :pathom-parser :as req}]
  (let [action-symbol ({"setName" `rl/save-relation-layer
                        "shift" `rl/shift-relation-layer} action)
        action-params ({"setName" {:delta {:relation-layer/name {:after name}} :ident [:relation-layer/id id]}
                        "shift"   {:id id :up? up}} action)]
    (if (nil? action-symbol)
      {:status 400
       :body {:error true :message (str "Unknown action: `" action "`")}}
      (let [result (parser req [(list action-symbol action-params)])
            data (get result action-symbol)]
        (if (:server/error? data)
          {:status (:server/code data)
           :body   data}
          {:status 200
           :body   (if (= action-symbol `rl/save-relation-layer)
                     {:message (str "Relation layer name changed to " name)
                      :error   false}
                     data)})))))

(def relation-layer-routes
  ["/relation"
   [""
    {:post {:parameters  {:body {:name        string?
                                 :span-layer id?}}
            :description "Creates a new relation layer. ID is given in the response under \"id\"."
            :handler    create-relation-layer}}]
   ["/:id"
    [""
     {:get    {:parameters {:path {:id id?}}
               :handler    get-relation-layer}
      :delete {:parameters {:path {:id id?}}
               :handler    delete-relation-layer}
      :patch
      {:parameters  {:path {:id id?}
                     :body {:action [:enum "setName" "shift"]
                            :name   (ml/optional string?)
                            :up     (ml/optional boolean?)}}
       :description (str "setName: sets the relation layer's `name` to body param `name`."
                         "\nshift: Moves the relation layer up or down relative to other relation layers, "
                         "depending on whether `up` is true or false.")
       :handler     patch-relation-layer}}]
    config-fragment]])
