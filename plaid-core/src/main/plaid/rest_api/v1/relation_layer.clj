(ns plaid.rest-api.v1.relation-layer
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.layer :refer [layer-config-routes]]
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
  ["/relation-layers"

   [""
    {:post {:summary    "Create a new relation layer."
            :middleware [[pra/wrap-maintainer-required get-project-id]]
            :parameters {:body [:map
                                [:span-layer-id :uuid]
                                [:name :string]]}
            :handler    (fn [{{{:keys [name span-layer-id]} :body} :parameters db :db user-id :user/id}]
                          (let [attrs {:relation-layer/name name}
                                result (rl/create db attrs span-layer-id user-id)]
                            (if (:success result)
                              {:status 201
                               :body   {:id (:extra result)}}
                              {:status (or (:code result) 400)
                               :body   {:error (:error result)}})))}}]

   ["/:relation-layer-id"
    {:parameters {:path [:map [:relation-layer-id :uuid]]}}

    [""
     {:get    {:summary "Get a relation layer by ID."
               :middleware [[pra/wrap-reader-required get-project-id]]
               :handler (fn [{{{:keys [relation-layer-id]} :path} :parameters db :db}]
                          (let [relation-layer (rl/get db relation-layer-id)]
                            (if (some? relation-layer)
                              {:status 200
                               :body   relation-layer}
                              {:status 404
                               :body   {:error "Relation layer not found"}})))}
      :patch  {:summary    "Update a relation layer's name."
               :middleware [[pra/wrap-maintainer-required get-project-id]]
               :parameters {:body [:map [:name :string]]}
               :handler    (fn [{{{:keys [relation-layer-id]} :path {:keys [name]} :body} :parameters db :db user-id :user/id}]
                             (let [{:keys [success code error]} (rl/merge db relation-layer-id {:relation-layer/name name} user-id)]
                               (if success
                                 {:status 200
                                  :body   (rl/get db relation-layer-id)}
                                 {:status (or code 500)
                                  :body   {:error (or error "Internal server error")}})))}
      :delete {:summary "Delete a relation layer."
               :middleware [[pra/wrap-maintainer-required get-project-id]]
               :handler (fn [{{{:keys [relation-layer-id]} :path} :parameters db :db user-id :user/id}]
                          (let [{:keys [success code error]} (rl/delete db relation-layer-id user-id)]
                            (if success
                              {:status 204}
                              {:status (or code 500)
                               :body   {:error (or error "Internal server error")}})))}}]

    ["/shift"
     {:post {:summary    "Shift a relation layer's order."
             :middleware [[pra/wrap-maintainer-required get-project-id]]
             :parameters {:body [:map [:direction [:enum "up" "down"]]]}
             :handler    (fn [{{{:keys [relation-layer-id]} :path {:keys [direction]} :body} :parameters db :db user-id :user/id}]
                           (let [up? (= direction "up")
                                 {:keys [success code error]} (rl/shift-relation-layer db relation-layer-id up? user-id)]
                             (if success
                               {:status 204}
                               {:status (or code 400)
                                :body   {:error (or error "Failed to shift relation layer")}})))}}]

    (layer-config-routes :relation-layer-id get-project-id)]])
