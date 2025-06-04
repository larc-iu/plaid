(ns plaid.rest-api.v1.token
  (:require [plaid.rest-api.v1.auth :as pra]
            [reitit.coercion.malli]
            [plaid.xtdb.token :as tok]
            [plaid.xtdb.token-layer :as tokl]))

(defn get-project-id [{xtdb :xtdb params :params}]
  (let [tokl-id (-> params :body :token-layer-id)
        token-id (-> params :path :token-id)]
    (cond
      tokl-id (tokl/project-id xtdb tokl-id)
      token-id (tok/project-id xtdb token-id)
      :else nil)))

(def token-routes
  ["/tokens"

   ["" {:post {:summary    "Create a new token in a token layer."
               :middleware [[pra/wrap-writer-required get-project-id]]
               :parameters {:body [:map
                                   [:token-layer-id :uuid]
                                   [:text-id :uuid]
                                   [:begin int?]
                                   [:end int?]
                                   [:precedence {:optional true} int?]]}
               :handler    (fn [{{{:keys [token-layer-id text-id begin end precedence]} :body} :parameters xtdb :xtdb}]
                             (let [attrs (cond-> {:token/layer token-layer-id
                                                  :token/text  text-id
                                                  :token/begin begin
                                                  :token/end   end}
                                                 (some? precedence) (assoc :token/precedence precedence))
                                   result (tok/create {:node xtdb} attrs)]
                               (if (:success result)
                                 {:status 201 :body {:id (:extra result)}}
                                 {:status (or (:code result) 500) :body {:error (:error result)}})))}}]

   ["/:token-id"
    {:parameters {:path [:map [:token-id :uuid]]}}

    ["" {:get    {:summary    "Get a token by ID."
                  :middleware [[pra/wrap-reader-required get-project-id]]
                  :handler    (fn [{{{:keys [token-id]} :path} :parameters xtdb :xtdb}]
                                (let [token (tok/get xtdb token-id)]
                                  (if (some? token)
                                    {:status 200 :body (dissoc token :xt/id)}
                                    {:status 404 :body {:error "Token not found"}})))}
         :patch  {:summary    "Update a token's extent and/or precedence."
                  :middleware [[pra/wrap-writer-required get-project-id]]
                  :parameters {:body [:map
                                      [:begin {:optional true} int?]
                                      [:end {:optional true} int?]
                                      [:precedence {:optional true} int?]]}
                  :handler    (fn [{{{:keys [token-id]} :path {:keys [begin end precedence]} :body} :parameters xtdb :xtdb}]
                                (let [raw-attrs (cond-> {}
                                                        (some? begin) (assoc :token/begin begin)
                                                        (some? end) (assoc :token/end end)
                                                        (some? precedence) (assoc :token/precedence precedence))
                                      {success :success code :code error :error} (tok/merge {:node xtdb} token-id raw-attrs)]
                                  (if success
                                    {:status 200 :body (dissoc (tok/get xtdb token-id) :xt/id)}
                                    {:status (or code 404) :body {:error (or error "Failed to update token or token not found")}})))}
         :delete {:summary    "Delete a token."
                  :middleware [[pra/wrap-writer-required get-project-id]]
                  :handler    (fn [{{{:keys [token-id]} :path} :parameters xtdb :xtdb}]
                                (let [{:keys [success code error]} (tok/delete {:node xtdb} token-id)]
                                  (if success
                                    {:status 204}
                                    {:status (or code 404) :body {:error (or error "Token not found")}})))}}]]]) 