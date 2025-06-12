(ns plaid.rest-api.v1.relation-layer
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.layer :refer [layer-config-routes]]
            [plaid.xtdb.span-layer :as sl]
            [plaid.xtdb.relation-layer :as rl]
            [plaid.xtdb.common :as pxc]))

(defn get-project-id [{db :db params :params}]
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
   {:middleware [[pra/wrap-maintainer-required get-project-id]]
    :x-client-bundle "relationLayers"}

   [""
    {:post {:summary    "Create a new relation layer."
            :x-client-method "create"
            :parameters {:body [:map
                                [:span-layer-id :uuid]
                                [:name :string]]}
            :handler    (fn [{{{:keys [name span-layer-id]} :body} :parameters xtdb :xtdb user-id :user/id}]
                          (let [attrs {:relation-layer/name name}
                                result (rl/create {:node xtdb} attrs span-layer-id user-id)]
                            (if (:success result)
                              {:status 201
                               :body   {:id (:extra result)}}
                              {:status (or (:code result) 400)
                               :body   {:error (:error result)}})))}}]

   ["/:relation-layer-id"
    {:parameters {:path [:map [:relation-layer-id :uuid]]}}

    [""
     {:get    {:summary "Get a relation layer by ID."
               :x-client-method "get"
               :handler (fn [{{{:keys [relation-layer-id]} :path} :parameters db :db}]
                          (let [relation-layer (rl/get db relation-layer-id)]
                            (if (some? relation-layer)
                              {:status 200
                               :body   (dissoc relation-layer :xt/id)}
                              {:status 404
                               :body   {:error "Relation layer not found"}})))}
      :patch  {:summary    "Update a relation layer's name."
               :x-client-method "update"
               :parameters {:body [:map [:name :string]]}
               :handler    (fn [{{{:keys [relation-layer-id]} :path {:keys [name]} :body} :parameters xtdb :xtdb user-id :user/id}]
                             (let [{:keys [success code error]} (rl/merge {:node xtdb} relation-layer-id {:relation-layer/name name} user-id)]
                               (if success
                                 {:status 200
                                  :body   (dissoc (rl/get xtdb relation-layer-id) :xt/id)}
                                 {:status (or code 404)
                                  :body   {:error (or error "Failed to update relation layer or relation layer not found")}})))}
      :delete {:summary "Delete a relation layer."
               :x-client-method "delete"
               :handler (fn [{{{:keys [relation-layer-id]} :path} :parameters xtdb :xtdb user-id :user/id}]
                          (let [{:keys [success code error]} (rl/delete {:node xtdb} relation-layer-id user-id)]
                            (if success
                              {:status 204}
                              {:status (or code 404)
                               :body   {:error (or error "Relation layer not found")}})))}}]

    ["/shift"
     {:post {:summary    "Shift a relation layer's order."
             :x-client-method "shift"
             :parameters {:body [:map [:direction [:enum "up" "down"]]]}
             :handler    (fn [{{{:keys [relation-layer-id]} :path {:keys [direction]} :body} :parameters xtdb :xtdb user-id :user/id}]
                           (let [up? (= direction "up")
                                 {:keys [success code error]} (rl/shift-relation-layer {:node xtdb} relation-layer-id up? user-id)]
                             (if success
                               {:status 204}
                               {:status (or code 400)
                                :body   {:error (or error "Failed to shift relation layer")}})))}}]

    (layer-config-routes :relation-layer-id)]])