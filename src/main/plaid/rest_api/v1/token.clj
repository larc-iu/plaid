(ns plaid.rest-api.v1.token
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.metadata :as metadata]
            [plaid.rest-api.v1.middleware :as prm]
            [reitit.coercion.malli]
            [xtdb.api :as xt]
            [plaid.xtdb.token :as tok]
            [plaid.xtdb.token-layer :as tokl]))

(defn get-project-id [{db :db params :parameters}]
  (let [tokl-id (or (-> params :body :token-layer-id))
        token-id (-> params :path :token-id)]
    (cond
      tokl-id (tokl/project-id db tokl-id)
      token-id (tok/project-id db token-id)
      :else nil)))

(defn bulk-get-project-id [{db :db params :parameters}]
  (let [tokl-id (or (-> params :body first :token-layer-id))
        token-id (-> params :body first)]
    (cond
      tokl-id (tokl/project-id db tokl-id)
      token-id (tok/project-id db token-id)
      :else nil)))

(defn get-document-id [{db :db params :parameters}]
  (let [text-id (-> params :body :text)
        token-id (-> params :path :token-id)]
    (cond
      text-id (:text/document (xt/entity db text-id))
      token-id (let [token (tok/get db token-id)]
                 (when token
                   (:text/document (xt/entity db (:token/text token)))))
      :else nil)))

(defn bulk-get-document-id [{db :db params :parameters}]
  (let [text-id (or (-> params :body first :text))
        token-id (-> params :body first)]
    (cond
      text-id (:text/document (xt/entity db text-id))
      token-id (let [token (tok/get db token-id)]
                 (when token
                   (:text/document (xt/entity db (:token/text token)))))
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
                             "\n<body>text</body>: the text in which this token is found."
                             "\n<body>begin</body>: the inclusive character-based offset at which this token begins in the body of the text specified by <body>text</body>"
                             "\n<body>end</body>: the exclusive character-based offset at which this token ends in the body of the text specified by <body>text</body>"
                             "\n<body>precedence</body>: used for tokens with the same <body>begin</body> value in order to indicate their preferred linear order.")
               :middleware [[pra/wrap-writer-required get-project-id]
                            [prm/wrap-document-version get-document-id]]
               :parameters {:query [:map [:document-version {:optional true} :uuid]]
                            :body [:map
                                   [:token-layer-id :uuid]
                                   [:text :uuid]
                                   [:begin int?]
                                   [:end int?]
                                   [:precedence {:optional true} int?]
                                   [:metadata {:optional true} [:map-of string? any?]]]}
               :handler (fn [{{{:keys [token-layer-id text begin end precedence metadata]} :body} :parameters xtdb :xtdb user-id :user/id}]
                          (let [attrs (cond-> {:token/layer token-layer-id
                                               :token/text text
                                               :token/begin begin
                                               :token/end end}
                                        (some? precedence) (assoc :token/precedence precedence))
                                result (tok/create {:node xtdb} attrs user-id metadata)]
                            (if (:success result)
                              (prm/assoc-document-versions-in-header
                                {:status 201 :body {:id (:extra result)}}
                                result)
                              {:status (or (:code result) 500) :body {:error (:error result)}})))}}]

   ["/bulk" {:conflicting true
             :post {:summary (str "Create multiple tokens in a single operation. Provide an array of objects whose keys"
                                  "are:\n"
                                  "<body>token-layer-id</body>, the token's layer\n"
                                  "<body>text</body>, the ID of the token's text\n"
                                  "<body>begin</body>, the character index at which the token begins (inclusive)\n"
                                  "<body>end</body>, the character index at which the token ends (exclusive)\n"
                                  "<body>precedence</body>, optional, an integer controlling which orders appear first in linear order when two or more tokens have the same <body>begin</body>\n"
                                  "<body>metadata</body>, an optional map of metadata")
                    :openapi {:x-client-method "bulk-create"}
                    :middleware [[pra/wrap-writer-required bulk-get-project-id]
                                 [prm/wrap-document-version bulk-get-document-id]]
                    :parameters {:query [:map [:document-version {:optional true} :uuid]]
                                 :body [:sequential
                                        [:map
                                         [:token-layer-id :uuid]
                                         [:text :uuid]
                                         [:begin int?]
                                         [:end int?]
                                         [:precedence {:optional true} int?]
                                         [:metadata {:optional true} [:map-of string? any?]]]]}
                    :handler (fn [{{tokens :body} :parameters xtdb :xtdb user-id :user/id}]
                               (let [tokens-attrs (mapv (fn [token-data]
                                                          (let [{:keys [token-layer-id text begin end precedence metadata]} token-data
                                                                attrs (cond-> {:token/layer token-layer-id
                                                                               :token/text text
                                                                               :token/begin begin
                                                                               :token/end end}
                                                                              (some? precedence) (assoc :token/precedence precedence))]
                                                            (if metadata
                                                              (assoc attrs :metadata metadata)
                                                              attrs)))
                                                        tokens)
                                     result (tok/bulk-create {:node xtdb} tokens-attrs user-id)]
                                 (if (:success result)
                                   (prm/assoc-document-versions-in-header
                                     {:status 201 :body {:ids (:extra result)}}
                                     result)
                                   {:status (or (:code result) 500) :body {:error (:error result)}})))}
             :delete {:summary "Delete multiple tokens in a single operation. Provide an array of IDs."
                      :openapi {:x-client-method "bulkDelete"}
                      :middleware [[pra/wrap-writer-required bulk-get-project-id]
                                   [prm/wrap-document-version bulk-get-document-id]]
                      :parameters {:query [:map [:document-version {:optional true} :uuid]]
                                   :body [:sequential :uuid]}
                      :handler (fn [{{token-ids :body} :parameters xtdb :xtdb user-id :user/id}]
                                 (let [{:keys [success code error] :as result} (tok/bulk-delete {:node xtdb} token-ids user-id)]
                                   (if success
                                     (prm/assoc-document-versions-in-header
                                       {:status 204}
                                       result)
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
                 :middleware [[pra/wrap-writer-required get-project-id]
                              [prm/wrap-document-version get-document-id]]
                 :parameters {:query [:map [:document-version {:optional true} :uuid]]
                              :body [:map
                                     [:begin {:optional true} int?]
                                     [:end {:optional true} int?]
                                     [:precedence {:optional true} int?]]}
                 :handler (fn [{{{:keys [token-id]} :path {:keys [begin end precedence]} :body} :parameters xtdb :xtdb user-id :user/id}]
                            (let [raw-attrs (cond-> {}
                                                    (some? begin) (assoc :token/begin begin)
                                                    (some? end) (assoc :token/end end)
                                                    (some? precedence) (assoc :token/precedence precedence))
                                  {success :success code :code error :error :as result} (tok/merge {:node xtdb} token-id raw-attrs user-id)]
                              (if success
                                (prm/assoc-document-versions-in-header
                                  {:status 200 :body (tok/get xtdb token-id)}
                                  result)
                                {:status (or code 500) :body {:error (or error "Internal server error")}})))}
         :delete {:summary (str "Delete a token and remove it from any spans. If this causes the span to have no "
                                "remaining associated tokens, the span will also be deleted.")
                  :middleware [[pra/wrap-writer-required get-project-id]
                               [prm/wrap-document-version get-document-id]]
                  :parameters {:query [:map [:document-version {:optional true} :uuid]]}
                  :handler (fn [{{{:keys [token-id]} :path} :parameters xtdb :xtdb user-id :user/id}]
                             (let [{:keys [success code error] :as result} (tok/delete {:node xtdb} token-id user-id)]
                               (if success
                                 (prm/assoc-document-versions-in-header
                                   {:status 204}
                                   result)
                                 {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]

    ;; Metadata operations
    (metadata/metadata-routes "token" :token-id get-project-id get-document-id tok/get tok/set-metadata tok/delete-metadata)]])