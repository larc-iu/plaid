(ns plaid.rest-api.v1.token
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.metadata :as metadata]
            [reitit.coercion.malli]
            [plaid.xtdb.token :as tok]
            [plaid.xtdb.token-layer :as tokl]))

(defn get-project-id [{db :db params :params}]
  (let [tokl-id (or (-> params :body :token-layer-id))
        token-id (-> params :path :token-id)]
    (cond
      tokl-id (tokl/project-id db tokl-id)
      token-id (tok/project-id db token-id)
      :else nil)))

(defn bulk-get-project-id [{db :db params :params}]
  (let [tokl-id (or (-> params :body first :token-layer-id))
        token-id (-> params :body first)]
    (cond
      tokl-id (tokl/project-id db tokl-id)
      token-id (tok/project-id db token-id)
      :else nil)))

(def token-routes
  ["/tokens"

   ["" {:post {:summary (str "Create a new token in a token layer. Tokens define text substrings using"
                             "<body>begin</body> and <body>end</body> offsets in the text. Tokens may be zero-width, "
                             "and they may overlap with each other. For tokens which share the same <body>begin</body>, "
                             "<body>precedence</body> may be used to indicate a preferred linear ordering, with "
                             "tokens with lower <body>precedence</body> occurring earlier."
                             "\n"
                             "\n<body>token-layer-id</body>: the layer in which to insert this token."
                             "\n<body>text-id</body>: the text in which this token is found."
                             "\n<body>begin</body>: the inclusive character-based offset at which this token begins in the body of the text specified by <body>text-id</body>"
                             "\n<body>end</body>: the exclusive character-based offset at which this token ends in the body of the text specified by <body>text-id</body>"
                             "\n<body>precedence</body>: used for tokens with the same <body>begin</body> value in order to indicate their preferred linear order.")
               :middleware [[pra/wrap-writer-required get-project-id]]
               :parameters {:body [:map
                                   [:token-layer-id :uuid]
                                   [:text-id :uuid]
                                   [:begin int?]
                                   [:end int?]
                                   [:precedence {:optional true} int?]
                                   [:metadata {:optional true} [:map-of string? any?]]]}
               :handler (fn [{{{:keys [token-layer-id text-id begin end precedence metadata]} :body} :parameters xtdb :xtdb user-id :user/id}]
                          (let [attrs (cond-> {:token/layer token-layer-id
                                               :token/text text-id
                                               :token/begin begin
                                               :token/end end}
                                        (some? precedence) (assoc :token/precedence precedence))
                                result (tok/create {:node xtdb} attrs user-id metadata)]
                            (if (:success result)
                              {:status 201 :body {:id (:extra result)}}
                              {:status (or (:code result) 500) :body {:error (:error result)}})))}}]

   ["/bulk" {:conflicting true
             :post {:summary "Create multiple tokens in a single operation."
                    :openapi {:x-client-method "bulkCreate"}
                    :middleware [[pra/wrap-writer-required bulk-get-project-id]]
                    :parameters {:body [:sequential
                                        [:map
                                         [:token-layer-id :uuid]
                                         [:text-id :uuid]
                                         [:begin int?]
                                         [:end int?]
                                         [:precedence {:optional true} int?]
                                         [:metadata {:optional true} [:map-of string? any?]]]]}
                    :handler (fn [{{tokens :body} :parameters xtdb :xtdb user-id :user/id}]
                               (let [tokens-attrs (mapv (fn [token-data]
                                                          (let [{:keys [token-layer-id text-id begin end precedence metadata]} token-data
                                                                attrs (cond-> {:token/layer token-layer-id
                                                                               :token/text text-id
                                                                               :token/begin begin
                                                                               :token/end end}
                                                                              (some? precedence) (assoc :token/precedence precedence))]
                                                            (if metadata
                                                              (assoc attrs :metadata metadata)
                                                              attrs)))
                                                        tokens)
                                     result (tok/bulk-create {:node xtdb} tokens-attrs user-id)]
                                 (if (:success result)
                                   {:status 201 :body {:ids (:extra result)}}
                                   {:status (or (:code result) 500) :body {:error (:error result)}})))}
             :delete {:summary "Delete multiple tokens in a single operation."
                      :openapi {:x-client-method "bulkDelete"}
                      :middleware [[pra/wrap-writer-required bulk-get-project-id]]
                      :parameters {:body [:sequential :uuid]}
                      :handler (fn [{{token-ids :body} :parameters xtdb :xtdb user-id :user/id}]
                                 (let [{:keys [success code error]} (tok/bulk-delete {:node xtdb} token-ids user-id)]
                                   (if success
                                     {:status 204}
                                     {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]

   ["/:token-id"
    {:conflicting true
     :parameters {:path [:map [:token-id :uuid]]}}

    ["" {:get {:summary "Get a token."
               :middleware [[pra/wrap-reader-required get-project-id]]
               :handler (fn [{{{:keys [token-id]} :path} :parameters db :db}]
                          (let [token (tok/get db token-id)]
                            (if (some? token)
                              {:status 200 :body token}
                              {:status 404 :body {:error "Token not found"}})))}
         :patch {:summary (str "Update a token. Supported keys:"
                               "\n"
                               "\n<body>begin</body>: start index of the token"
                               "\n<body>end</body>: end index of the token"
                               "\n<body>precedence</body>: ordering value for the token relative to other tokens with the same <body>begin</body>--lower means earlier")
                 :middleware [[pra/wrap-writer-required get-project-id]]
                 :parameters {:body [:map
                                     [:begin {:optional true} int?]
                                     [:end {:optional true} int?]
                                     [:precedence {:optional true} int?]]}
                 :handler (fn [{{{:keys [token-id]} :path {:keys [begin end precedence]} :body} :parameters xtdb :xtdb user-id :user/id}]
                            (let [raw-attrs (cond-> {}
                                              (some? begin) (assoc :token/begin begin)
                                              (some? end) (assoc :token/end end)
                                              (some? precedence) (assoc :token/precedence precedence))
                                  {success :success code :code error :error} (tok/merge {:node xtdb} token-id raw-attrs user-id)]
                              (if success
                                {:status 200 :body (tok/get xtdb token-id)}
                                {:status (or code 500) :body {:error (or error "Internal server error")}})))}
         :delete {:summary (str "Delete a token and remove it from any spans. If this causes the span to have no "
                                "remaining associated tokens, the span will also be deleted.")
                  :middleware [[pra/wrap-writer-required get-project-id]]
                  :handler (fn [{{{:keys [token-id]} :path} :parameters xtdb :xtdb user-id :user/id}]
                             (let [{:keys [success code error]} (tok/delete {:node xtdb} token-id user-id)]
                               (if success
                                 {:status 204}
                                 {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]

    ;; Metadata operations
    (metadata/metadata-routes "token" :token-id get-project-id tok/get tok/set-metadata tok/delete-metadata)]])