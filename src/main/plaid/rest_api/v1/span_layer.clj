(ns plaid.rest-api.v1.span-layer
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.layer :refer [layer-config-routes]]
            [reitit.coercion.malli]
            [plaid.xtdb.token-layer :as tokl]
            [plaid.xtdb.span-layer :as sl]))

(defn get-project-id [{xtdb :xtdb params :params}]
  (let [tokl-id (-> params :body :token-layer-id)
        sl-id (-> params :path :span-layer-id)]
    (cond tokl-id
          (tokl/project-id xtdb tokl-id)

          sl-id
          (sl/project-id xtdb sl-id)

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
            :handler    (fn [{{{:keys [name token-layer-id]} :body} :parameters xtdb :xtdb :as req}]
                          (let [attrs {:span-layer/name name}
                                result (sl/create {:node xtdb} attrs token-layer-id)]
                            (if (:success result)
                              {:status 201
                               :body   {:id (:extra result)}}
                              {:status (or (:code result) 500)
                               :body   {:error (:error result)}})))}}]

   ["/:span-layer-id"
    {:parameters {:path [:map [:span-layer-id :uuid]]}}

    [""
     {:get    {:summary "Get a span layer by ID."
               :handler (fn [{{{:keys [span-layer-id]} :path} :parameters xtdb :xtdb}]
                          (let [span-layer (sl/get xtdb span-layer-id)]
                            (if (some? span-layer)
                              {:status 200
                               :body   (dissoc span-layer :xt/id)}
                              {:status 404
                               :body   {:error "Span layer not found"}})))}
      :patch  {:summary    "Update a span layer's name."
               :parameters {:body [:map [:name :string]]}
               :handler    (fn [{{{:keys [span-layer-id]} :path {:keys [name]} :body} :parameters xtdb :xtdb}]
                             (let [{:keys [success code error]} (sl/merge {:node xtdb} span-layer-id {:span-layer/name name})]
                               (if success
                                 {:status 200
                                  :body   (dissoc (sl/get xtdb span-layer-id) :xt/id)}
                                 {:status (or code 404)
                                  :body   {:error (or error "Failed to update span layer or span layer not found")}})))}
      :delete {:summary "Delete a span layer."
               :handler (fn [{{{:keys [span-layer-id]} :path} :parameters xtdb :xtdb}]
                          (let [{:keys [success code error]} (sl/delete {:node xtdb} span-layer-id)]
                            (if success
                              {:status 204}
                              {:status (or code 404)
                               :body   {:error (or error "Span layer not found")}})))}}]

    ["/shift"
     {:post {:summary    "Shift a span layer's order."
             :parameters {:body [:map [:direction [:enum "up" "down"]]]}
             :handler    (fn [{{{:keys [span-layer-id]} :path {:keys [direction]} :body} :parameters xtdb :xtdb}]
                           (let [up? (= direction "up")
                                 {:keys [success code error]} (sl/shift-span-layer {:node xtdb} span-layer-id up?)]
                             (if success
                               {:status 204}
                               {:status (or code 400)
                                :body   {:error (or error "Failed to shift span layer")}})))}}]

    (layer-config-routes :span-layer-id)]])