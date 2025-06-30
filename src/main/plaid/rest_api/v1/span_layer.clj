(ns plaid.rest-api.v1.span-layer
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.layer :refer [layer-config-routes]]
            [reitit.coercion.malli]
            [plaid.xtdb.token-layer :as tokl]
            [plaid.xtdb.span-layer :as sl]))

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
  ["/span-layers"
   {:middleware [[pra/wrap-maintainer-required get-project-id]]}

   [""
    {:post {:summary    "Create a new span layer."
            :parameters {:body [:map
                                [:token-layer-id :uuid]
                                [:name :string]]}
            :handler    (fn [{{{:keys [name token-layer-id]} :body} :parameters xtdb :xtdb user-id :user/id}]
                          (let [attrs {:span-layer/name name}
                                result (sl/create {:node xtdb} attrs token-layer-id user-id)]
                            (if (:success result)
                              {:status 201
                               :body   {:id (:extra result)}}
                              {:status (or (:code result) 500)
                               :body   {:error (:error result)}})))}}]

   ["/:span-layer-id"
    {:parameters {:path [:map [:span-layer-id :uuid]]}}

    [""
     {:get    {:summary "Get a span layer by ID."
               :handler (fn [{{{:keys [span-layer-id]} :path} :parameters db :db}]
                          (let [span-layer (sl/get db span-layer-id)]
                            (if (some? span-layer)
                              {:status 200
                               :body   span-layer}
                              {:status 404
                               :body   {:error "Span layer not found"}})))}
      :patch  {:summary    "Update a span layer's name."
               :parameters {:body [:map [:name :string]]}
               :handler    (fn [{{{:keys [span-layer-id]} :path {:keys [name]} :body} :parameters xtdb :xtdb user-id :user/id}]
                             (let [{:keys [success code error]} (sl/merge {:node xtdb} span-layer-id {:span-layer/name name} user-id)]
                               (if success
                                 {:status 200
                                  :body   (sl/get xtdb span-layer-id)}
                                 {:status (or code 500)
                                  :body   {:error (or error "Internal server error")}})))}
      :delete {:summary "Delete a span layer."
               :handler (fn [{{{:keys [span-layer-id]} :path} :parameters xtdb :xtdb user-id :user/id}]
                          (let [{:keys [success code error]} (sl/delete {:node xtdb} span-layer-id user-id)]
                            (if success
                              {:status 204}
                              {:status (or code 500)
                               :body   {:error (or error "Internal server error")}})))}}]

    ["/shift"
     {:post {:summary    "Shift a span layer's order."
             :parameters {:body [:map [:direction [:enum "up" "down"]]]}
             :handler    (fn [{{{:keys [span-layer-id]} :path {:keys [direction]} :body} :parameters xtdb :xtdb user-id :user/id}]
                           (let [up? (= direction "up")
                                 {:keys [success code error]} (sl/shift-span-layer {:node xtdb} span-layer-id up? user-id)]
                             (if success
                               {:status 204}
                               {:status (or code 400)
                                :body   {:error (or error "Failed to shift span layer")}})))}}]

    (layer-config-routes :span-layer-id)]])