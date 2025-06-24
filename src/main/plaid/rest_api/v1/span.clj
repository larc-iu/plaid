(ns plaid.rest-api.v1.span
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.metadata :as metadata]
            [reitit.coercion.malli]
            [plaid.xtdb.span :as s]
            [plaid.xtdb.span-layer :as sl]))

(defn get-project-id
  "Get the project ID from span-layer or existing span."
  [{db :db params :params}]
  (let [sl-id (-> params :body :span-layer-id)
        span-id (-> params :path :span-id)]
    (cond
      sl-id (sl/project-id db sl-id)
      span-id (s/project-id db span-id)
      :else nil)))

(defn bulk-get-project-id [{db :db params :params}]
  (let [sl-id (or (-> params :body first :span-layer-id))
        span-id (-> params :body first)]
    (cond
      sl-id (sl/project-id db sl-id)
      span-id (s/project-id db span-id)
      :else nil)))


(def span-routes
  ["/spans"

   ;; Create a new span
   ["" {:post {:summary    (str "Create a new span. A span holds a primary atomic value and optional metadata, "
                                "and must at all times be associated with one or more tokens."
                                "\n"
                                "\n<body>span-layer-id</body>: the span's associated layer"
                                "\n<body>tokens</body>: a list of tokens associated with this span. Must contain at least one token. "
                                "All tokens must belong to a single layer which is linked to the span layer indicated by "
                                "<body>span-layer-id</body>."
                                "\n<body>value</body>: the primary value of the span (must be string, number, boolean, or null)."
                                "\n<body>metadata</body>: optional key-value pairs for additional annotation data.")
               :middleware [[pra/wrap-writer-required get-project-id]]
               :parameters {:body [:map
                                   [:span-layer-id :uuid]
                                   [:tokens [:vector uuid?]]
                                   [:value [:or string? number? boolean? nil?]]
                                   [:metadata {:optional true} [:map-of string? any?]]]}
               :handler    (fn [{{{:keys [span-layer-id tokens value metadata]} :body} :parameters xtdb :xtdb user-id :user/id}]
                             (let [attrs {:span/layer  span-layer-id
                                          :span/tokens tokens
                                          :span/value  value}
                                   result (s/create {:node xtdb} attrs user-id metadata)]
                               (if (:success result)
                                 {:status 201 :body {:id (:extra result)}}
                                 {:status (or (:code result) 400) :body {:error (:error result)}})))}}]

   ["/bulk" {:conflicting true
             :post {:summary "Create multiple spans in a single operation."
                    :openapi {:x-client-method "bulkCreate"}
                    :middleware [[pra/wrap-writer-required bulk-get-project-id]]
                    :parameters {:body [:sequential
                                        [:map
                                         [:span-layer-id :uuid]
                                         [:tokens [:vector uuid?]]
                                         [:value [:or string? number? boolean? nil?]]
                                         [:metadata {:optional true} [:map-of string? any?]]]]}
                    :handler (fn [{{spans :body} :parameters xtdb :xtdb user-id :user/id}]
                               (let [spans-attrs (mapv (fn [span-data]
                                                         (let [{:keys [span-layer-id tokens value metadata]} span-data
                                                               attrs {:span/layer span-layer-id
                                                                      :span/tokens tokens
                                                                      :span/value value}]
                                                           (if metadata
                                                             (assoc attrs :metadata metadata)
                                                             attrs)))
                                                       spans)
                                     result (s/bulk-create {:node xtdb} spans-attrs user-id)]
                                 (if (:success result)
                                   {:status 201 :body {:ids (:extra result)}}
                                   {:status (or (:code result) 500) :body {:error (:error result)}})))}
             :delete {:summary "Delete multiple spans in a single operation."
                      :openapi {:x-client-method "bulkDelete"}
                      :middleware [[pra/wrap-writer-required bulk-get-project-id]]
                      :parameters {:body [:sequential :uuid]}
                      :handler (fn [{{span-ids :body} :parameters xtdb :xtdb user-id :user/id}]
                                 (let [{:keys [success code error]} (s/bulk-delete {:node xtdb} span-ids user-id)]
                                   (if success
                                     {:status 204}
                                     {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]

   ;; Operations on a single span
   ["/:span-id" {:conflicting true
                 :parameters {:path [:map [:span-id :uuid]]}}

    ["" {:get    {:summary    "Get a span by ID."
                  :middleware [[pra/wrap-reader-required get-project-id]]
                  :handler    (fn [{{{:keys [span-id]} :path} :parameters db :db}]
                                (if-let [s (s/get db span-id)]
                                  {:status 200 :body s}
                                  {:status 404 :body {:error "Span not found"}}))}
         :patch  {:summary    "Update a span's <body>value</body>."
                  :middleware [[pra/wrap-writer-required get-project-id]]
                  :parameters {:body [:map
                                      [:value [:or string? number? boolean? nil?]]]}
                  :handler    (fn [{{{:keys [span-id]} :path {:keys [value]} :body} :parameters xtdb :xtdb user-id :user/id}]
                                (let [{:keys [success code error]} (s/merge {:node xtdb} span-id {:span/value value} user-id)]
                                  (if success
                                    {:status 200 :body (s/get xtdb span-id)}
                                    {:status (or code 500) :body {:error (or error "Internal server error")}})))}
         :delete {:summary    "Delete a span."
                  :middleware [[pra/wrap-writer-required get-project-id]]
                  :handler    (fn [{{{:keys [span-id]} :path} :parameters xtdb :xtdb user-id :user/id}]
                                (let [{:keys [success code error]} (s/delete {:node xtdb} span-id user-id)]
                                  (if success
                                    {:status 204}
                                    {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]

    ;; Replace tokens on a span
    ["/tokens" {:put {:summary    "Replace tokens for a span."
                      :middleware [[pra/wrap-writer-required get-project-id]]
                      :openapi    {:x-client-method "set-tokens"}
                      :parameters {:body [:map [:tokens [:vector uuid?]]]}
                      :handler    (fn [{{{:keys [span-id]} :path {:keys [tokens]} :body} :parameters xtdb :xtdb user-id :user/id}]
                                    (let [{:keys [success code error]} (s/set-tokens {:node xtdb} span-id tokens user-id)]
                                      (if success
                                        {:status 200 :body (s/get xtdb span-id)}
                                        {:status (or code 400) :body {:error (or error "Failed to set span tokens")}})))}}]

    ;; Metadata operations
    (metadata/metadata-routes "span" :span-id get-project-id s/get s/set-metadata s/delete-metadata)]])