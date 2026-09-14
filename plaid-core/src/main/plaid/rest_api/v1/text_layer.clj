(ns plaid.rest-api.v1.text-layer
  (:require [plaid.rest-api.v1.layer :refer [layer-routes]]
            [reitit.coercion.malli]
            [plaid.sql.text-layer :as txtl]))

(defn get-project-id [{db :db params :parameters}]
  (let [prj-id (-> params :body :project-id)
        txtl-id (-> params :path :text-layer-id)]
    (cond prj-id
          prj-id

          txtl-id
          (txtl/project-id db txtl-id)

          :else
          nil)))

(def text-layer-routes
  (layer-routes
   {:path "/text-layers"
    :id-key :text-layer-id
    :noun "text layer"
    :project-fn get-project-id
    :get-fn txtl/get
    :merge-fn txtl/merge
    :name-key :text-layer/name
    :delete-fn txtl/delete
    :shift-fn txtl/shift-text-layer
    :shift-summary "Shift a text layer's order within the project."
    :post {:summary "Create a new text layer for a project."
           :parameters {:body [:map
                               [:project-id :uuid]
                               [:name :string]]}
           :handler (fn [{{{:keys [project-id name]} :body} :parameters db :db user-id :user/id}]
                      (let [attrs {:text-layer/name name}
                            result (txtl/create db attrs project-id user-id)]
                        (if (:success result)
                          {:status 201
                           :body   {:id (:extra result)}}
                          {:status (or (:code result) 500)
                           :body   {:error (:error result)}})))}}))
