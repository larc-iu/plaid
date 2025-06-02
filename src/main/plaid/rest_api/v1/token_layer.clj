(ns plaid.rest-api.v1.token-layer
  (:require [plaid.rest-api.v1.auth :as pra]
            [reitit.coercion.malli]
            [plaid.xtdb.text-layer :as txtl]
            [plaid.xtdb.token-layer :as tokl]))

(defn get-project-id [{xtdb :xtdb params :params}]
  (let [txtl-id (-> params :body :text-layer-id)
        tokl-id (-> params :path :token-layer-id)]
    (cond txtl-id
          (txtl/project-id xtdb txtl-id)

          tokl-id
          (tokl/project-id xtdb tokl-id)

          :else
          nil)))

(def token-layer-routes
  ["/token-layers"
   {:middleware [[pra/wrap-maintainer-required get-project-id]]}

   [""
    {:post {:summary    "Create a new token layer."
            :parameters {:body [:map
                                [:text-layer-id :uuid]
                                [:name :string]]}
            :handler    (fn [{{{:keys [name text-layer-id]} :body} :parameters xtdb :xtdb :as req}]
                          (let [attrs {:token-layer/name name}
                                result (tokl/create {:node xtdb} attrs text-layer-id)]
                            (if (:success result)
                              {:status 201
                               :body   {:id (:extra result)}}
                              {:status (or (:code result) 500)
                               :body   {:error (:error result)}})))}}]

   ["/:token-layer-id"
    {:parameters {:path [:map [:token-layer-id :string]]}}

    [""
     {:get    {:summary "Get a token layer by ID."
               :handler (fn [{{{:keys [token-layer-id]} :path} :parameters xtdb :xtdb}]
                          (let [token-layer (tokl/get xtdb token-layer-id)]
                            (if (some? token-layer)
                              {:status 200
                               :body   (dissoc token-layer :xt/id)}
                              {:status 404
                               :body   {:error "Token layer not found"}})))}

      :patch  {:summary    "Update a token layer's name."
               :parameters {:body [:map [:name :string]]}
               :handler    (fn [{{{:keys [token-layer-id]} :path {:keys [name]} :body} :parameters xtdb :xtdb}]
                             (let [{:keys [success code error]} (tokl/merge {:node xtdb} token-layer-id {:token-layer/name name})]
                               (if success
                                 {:status 200
                                  :body   (dissoc (tokl/get xtdb token-layer-id) :xt/id)}
                                 {:status (or code 404)
                                  :body   {:error (or error "Failed to update token layer or token layer not found")}})))}
      :delete {:summary "Delete a token layer."
               :handler (fn [{{{:keys [token-layer-id]} :path} :parameters xtdb :xtdb}]
                          (let [{:keys [success code error]} (tokl/delete {:node xtdb} token-layer-id)]
                            (if success
                              {:status 204}
                              {:status (or code 404)
                               :body   {:error (or error "Token layer not found")}})))}}]

    ["/shift"
     {:post {:summary    "Shift a token layer's order."
             :parameters {:body [:map [:direction [:enum "up" "down"]]
                                 [:text-layer-id :string]]}
             :handler    (fn [{{{:keys [token-layer-id]} :path {:keys [direction]} :body} :parameters xtdb :xtdb}]
                           (let [up? (= direction "up")
                                 {:keys [success code error]} (tokl/shift-token-layer {:node xtdb} token-layer-id up?)]
                             (if success
                               {:status 204}
                               {:status (or code 400)
                                :body   {:error (or error "Failed to shift token layer")}})))}}]]])