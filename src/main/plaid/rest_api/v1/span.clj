(ns plaid.rest-api.v1.span
  (:require [plaid.rest-api.v1.auth :as pra]
            [reitit.coercion.malli]
            [plaid.xtdb.span :as sp]
            [plaid.xtdb.span-layer :as sl]))

(defn get-project-id
  "Get the project ID from span-layer or existing span."
  [{xtdb :xtdb params :params}]
  (let [sl-id (-> params :body :span-layer-id)
        span-id (-> params :path :span-id)]
    (cond
      sl-id (sl/project-id xtdb sl-id)
      span-id (sp/project-id xtdb span-id)
      :else nil)))

(def span-routes
  ["/spans"

   ;; Create a new span
   ["" {:post {:summary    "Create a new span in a span layer."
               :middleware [[pra/wrap-writer-required get-project-id]]
               :parameters {:body [:map
                                   [:span-layer-id :uuid]
                                   [:tokens [:vector uuid?]]
                                   [:value any?]]}
               :handler    (fn [{{{:keys [span-layer-id tokens value]} :body} :parameters xtdb :xtdb}]
                             (let [attrs {:span/layer  span-layer-id
                                          :span/tokens tokens
                                          :span/value  value}
                                   result (sp/create {:node xtdb} attrs)]
                               (if (:success result)
                                 {:status 201 :body {:id (:extra result)}}
                                 {:status (or (:code result) 400) :body {:error (:error result)}})))}}]

   ;; Operations on a single span
   ["/:span-id" {:parameters {:path [:map [:span-id :uuid]]}}
    ["" {:get    {:summary    "Get a span by ID."
                  :middleware [[pra/wrap-reader-required get-project-id]]
                  :handler    (fn [{{{:keys [span-id]} :path} :parameters xtdb :xtdb}]
                                (if-let [s (sp/get xtdb span-id)]
                                  {:status 200 :body (dissoc s :xt/id)}
                                  {:status 404 :body {:error "Span not found"}}))}
         :patch  {:summary    "Update a span's value."
                  :middleware [[pra/wrap-writer-required get-project-id]]
                  :parameters {:body [:map [:value any?]]}
                  :handler    (fn [{{{:keys [span-id]} :path {:keys [value]} :body} :parameters xtdb :xtdb}]
                                (let [{:keys [success code error]} (sp/merge {:node xtdb} span-id {:span/value value})]
                                  (if success
                                    {:status 200 :body (dissoc (sp/get xtdb span-id) :xt/id)}
                                    {:status (or code 404) :body {:error (or error "Failed to update span or span not found")}})))}
         :delete {:summary    "Delete a span."
                  :middleware [[pra/wrap-writer-required get-project-id]]
                  :handler    (fn [{{{:keys [span-id]} :path} :parameters xtdb :xtdb}]
                                (let [{:keys [success code error]} (sp/delete {:node xtdb} span-id)]
                                  (if success
                                    {:status 204}
                                    {:status (or code 404) :body {:error (or error "Span not found")}})))}}]

    ;; Replace tokens on a span
    ["/tokens" {:put {:summary    "Replace tokens for a span."
                      :middleware [[pra/wrap-writer-required get-project-id]]
                      :parameters {:body [:map [:tokens [:vector uuid?]]]}
                      :handler    (fn [{{{:keys [span-id]} :path {:keys [tokens]} :body} :parameters xtdb :xtdb}]
                                    (let [{:keys [success code error]} (sp/set-tokens {:node xtdb} span-id tokens)]
                                      (if success
                                        {:status 200 :body (dissoc (sp/get xtdb span-id) :xt/id)}
                                        {:status (or code 400) :body {:error (or error "Failed to set span tokens")}})))}}]]])