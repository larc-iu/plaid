(ns plaid.rest-api.v1.relation-layer
  (:require [plaid.rest-api.v1.layer :refer [layer-routes]]
            [plaid.rest-api.v1.middleware :as prm]
            [plaid.sql.span-layer :as sl]
            [plaid.sql.relation-layer :as rl]))

(defn get-project-id [{db :db params :parameters}]
  (let [sl-id (-> params :body :span-layer-id)
        rl-id (-> params :path :relation-layer-id)]
    (cond sl-id
          (sl/project-id db sl-id)

          rl-id
          (rl/project-id db rl-id)

          :else
          nil)))

(def relation-layer-routes
  (layer-routes
   {:path "/relation-layers"
    :id-key :relation-layer-id
    :table :relation_layers
    :noun "relation layer"
    :project-fn get-project-id
    :get-fn rl/get
    :merge-fn rl/merge
    :name-key :relation-layer/name
    :delete-fn rl/delete
    :shift-fn rl/shift-relation-layer
    :shift-summary "Shift a relation layer's order."
    :post {:summary (str "Create a new relation layer. "
                         "<body>id</body>, optional, is the new relation layer's id, a UUIDv7 the client minted (else the server mints one). An id used before is refused with 409 and <body>id-taken</body>.")
           :parameters {:body [:map
                               [:id {:optional true} :uuid]
                               [:span-layer-id :uuid]
                               [:name :string]]}
           :handler (fn [{{{:keys [id name span-layer-id]} :body} :parameters db :db user-id :user/id}]
                      (let [attrs (cond-> {:relation-layer/name name}
                                    (some? id) (assoc :relation-layer/id id))
                            result (rl/create db attrs span-layer-id user-id)]
                        (if (:success result)
                          {:status 201
                           :body   {:id (:extra result)}}
                          {:status (or (:code result) 500)
                           :body   (prm/error-body result)})))}}))
