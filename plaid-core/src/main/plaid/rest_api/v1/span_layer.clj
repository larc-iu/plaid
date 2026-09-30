(ns plaid.rest-api.v1.span-layer
  (:require [plaid.rest-api.v1.layer :refer [layer-routes]]
            [plaid.rest-api.v1.middleware :as prm]
            [reitit.coercion.malli]
            [plaid.sql.token-layer :as tokl]
            [plaid.sql.span-layer :as sl]))

(defn get-project-id [{db :db params :parameters}]
  (let [tokl-id (-> params :body :token-layer-id)
        sl-id (-> params :path :span-layer-id)]
    (cond tokl-id
          (tokl/project-id db tokl-id)

          sl-id
          (sl/project-id db sl-id)

          :else
          nil)))

(def span-layer-routes
  (layer-routes
   {:path "/span-layers"
    :id-key :span-layer-id
    :table :span_layers
    :noun "span layer"
    :project-fn get-project-id
    :get-fn sl/get
    :merge-fn sl/merge
    :name-key :span-layer/name
    :delete-fn sl/delete
    :shift-fn sl/shift-span-layer
    :shift-summary "Shift a span layer's order."
    :post {:summary (str "Create a new span layer. "
                         "<body>id</body>, optional, is the new span layer's id, a UUIDv7 the client minted (else the server mints one). An id used before is refused with 409 and <body>id-taken</body>.")
           :parameters {:body [:map
                               [:id {:optional true} :uuid]
                               [:token-layer-id :uuid]
                               [:name :string]]}
           :handler (fn [{{{:keys [id name token-layer-id]} :body} :parameters db :db user-id :user/id}]
                      (let [attrs (cond-> {:span-layer/name name}
                                    (some? id) (assoc :span-layer/id id))
                            result (sl/create db attrs token-layer-id user-id)]
                        (if (:success result)
                          {:status 201
                           :body   {:id (:extra result)}}
                          {:status (or (:code result) 500)
                           :body   (prm/error-body result)})))}}))
