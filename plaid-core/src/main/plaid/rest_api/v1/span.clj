(ns plaid.rest-api.v1.span
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.bulk :as bulk]
            [plaid.rest-api.v1.metadata :as metadata]
            [plaid.rest-api.v1.schema :as schema]
            [plaid.rest-api.v1.middleware :as prm]
            [reitit.coercion.malli]
            [plaid.sql.span :as s]))

(def ^:private resolvers
  "The gate and document-version resolvers. A create's project is its span
  layer's, its document its first token's."
  (pra/entity-resolvers {:table :spans
                         :path-key :span-id
                         :create-layer [:span-layer-id :span_layers]
                         :create-document [:tokens :tokens]}))

(def get-project-id (:project-id resolvers))
(def get-document-id (:document-id resolvers))
(def ^:private bulk-get-project-id (:bulk-project-id resolvers))
(def ^:private bulk-get-document-id (:bulk-document-id resolvers))
(def ^:private bulk-update-get-project-id (:bulk-update-project-id resolvers))
(def ^:private bulk-update-get-document-id (:bulk-update-document-id resolvers))

(def ^:private create-entry
  "The body of a span create, the POST's and each bulk create entry's."
  [:map
   [:id {:optional true} :uuid]
   [:span-layer-id :uuid]
   [:tokens [:vector uuid?]]
   [:value schema/atomic-value]
   [:metadata {:optional true} [:map-of string? any?]]])

(defn- ->attrs
  "The attributes of the span a create body names."
  [{:keys [id span-layer-id tokens value]}]
  (cond-> {:span/layer span-layer-id
           :span/tokens tokens
           :span/value value}
    (some? id) (assoc :span/id id)))

(def span-routes

  ["/spans"

   ;; Create a new span
   ["" {:post {:summary (str "Create a new span. A span holds a primary atomic value and optional metadata, "
                             "and must at all times be associated with one or more tokens."
                             "\n"
                             "\n<body>span-layer-id</body>: the span's associated layer"
                             "\n<body>tokens</body>: a list of tokens associated with this span. Must contain at least one token. "
                             "All tokens must belong to a single layer which is linked to the span layer indicated by "
                             "<body>span-layer-id</body>."
                             "\n<body>value</body>: the primary value of the span (must be string, number, boolean, or null)."
                             "\n<body>metadata</body>: optional key-value pairs for additional annotation data."
                             "\n<body>id</body>: optional, the new span's id, a UUIDv7 the client minted (else the server mints one). An id used before, even by a span since deleted, is refused with 409 and <body>id-taken</body>.")
               :middleware [[pra/wrap-writer-required get-project-id]
                            [prm/wrap-document-version get-document-id]
                            metadata/wrap-inline-metadata-shape-guard]
               :parameters {:query [:map [:document-version {:optional true} :int]]
                            :body create-entry}
               :handler (fn [{{{:keys [metadata] :as body} :body} :parameters db :db user-id :user/id :as request}]
                          (let [attrs (->attrs body)
                                doc-id (get-document-id request)
                                result (s/create db attrs user-id metadata)]
                            (if (:success result)
                              (prm/assoc-document-version-in-header
                               {:status 201 :body {:id (:extra result)}}
                               db doc-id)
                              {:status (or (:code result) 500) :body (prm/error-body result)})))}}]

   (bulk/bulk-routes
    {:create-summary (str "Create multiple spans in a single operation. Provide an array of objects whose keys "
                          "are:\n"
                          "<body>span-layer-id</body>, the span's layer\n"
                          "<body>tokens</body>, the IDs of the span's constituent tokens\n"
                          "<body>value</body>, the relation's value\n"
                          "<body>metadata</body>, an optional map of metadata\n"
                          "<body>id</body>, optional, the new span's id, a UUIDv7 the client minted (else the server mints one). An id used before is refused with 409 and <body>id-taken</body>, and one named twice with 400.")
     :create-entry create-entry
     :->attrs ->attrs
     :bulk-create s/bulk-create
     :update-summary "Update many spans in a single operation. Provide an array of objects whose keys are:\n<body>id</body>, the span's id\n<body>value</body>, optional: the new value (present with null to set null)\n<body>metadata</body>, optional: a list of metadata ops, as for PATCH on one entity's metadata\nThe spans may lie in several documents of one project; every document touched has its version bumped and its new version is returned in X-Document-Versions (past fifty documents, only their number, in X-Document-Versions-Omitted). An unknown id refuses the whole update. <query>document-version</query> names one document, so it is refused when the entries reach more than one."
     :update-entry [:map [:id :uuid] [:value {:optional true} schema/atomic-value] [:metadata {:optional true} metadata/metadata-ops-schema]]
     :bulk-update s/bulk-update
     :update-project-fn bulk-update-get-project-id
     :update-document-fn bulk-update-get-document-id
     :delete-summary "Delete multiple spans in a single operation. Provide an array of IDs."
     :bulk-delete s/bulk-delete
     :project-fn bulk-get-project-id
     :document-fn bulk-get-document-id})

   ;; Operations on a single span
   ["/:span-id" {:conflicting true
                 :parameters {:path [:map [:span-id :uuid]]}}

    ["" {:get {:summary "Get a span by ID."
               :middleware [[pra/wrap-reader-required get-project-id]]
               :handler (fn [{{{:keys [span-id]} :path} :parameters db :db}]
                          (if-let [sp (s/get db span-id)]
                            {:status 200 :body sp}
                            {:status 404 :body {:error "Span not found"}}))}
         :patch {:summary "Update a span's <body>value</body>."
                 :middleware [[pra/wrap-writer-required get-project-id]
                              [prm/wrap-document-version get-document-id]]
                 :parameters {:query [:map [:document-version {:optional true} :int]]
                              :body [:map
                                     [:value schema/atomic-value]]}
                 :handler (fn [{{{:keys [span-id]} :path {:keys [value]} :body} :parameters db :db user-id :user/id :as request}]
                            (let [doc-id (get-document-id request)
                                  {:keys [success code error]} (s/merge db span-id {:span/value value} user-id)]
                              (if success
                                (prm/assoc-document-version-in-header
                                 {:status 200 :body (s/get db span-id)}
                                 db doc-id)
                                {:status (or code 500) :body {:error (or error "Internal server error")}})))}
         :delete {:summary "Delete a span."
                  :parameters {:query [:map [:document-version {:optional true} :int]]}
                  :middleware [[pra/wrap-writer-required get-project-id]
                               [prm/wrap-document-version get-document-id]]
                  :handler (fn [{{{:keys [span-id]} :path} :parameters db :db user-id :user/id :as request}]
                             (let [doc-id (get-document-id request)
                                   {:keys [success code error]} (s/delete db span-id user-id)]
                               (if success
                                 (prm/assoc-document-version-in-header
                                  {:status 204}
                                  db doc-id)
                                 {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]

    ;; Replace tokens on a span
    ["/tokens" {:put {:summary "Replace tokens for a span."
                      :middleware [[pra/wrap-writer-required get-project-id]
                                   [prm/wrap-document-version get-document-id]]
                      :parameters {:body [:map [:tokens [:vector uuid?]]]
                                   :query [:map [:document-version {:optional true} :int]]}
                      :handler (fn [{{{:keys [span-id]} :path {:keys [tokens]} :body} :parameters db :db user-id :user/id :as request}]
                                 (let [doc-id (get-document-id request)
                                       {:keys [success code error]} (s/set-tokens db span-id tokens user-id)]
                                   (if success
                                     (prm/assoc-document-version-in-header
                                      {:status 200 :body (s/get db span-id)}
                                      db doc-id)
                                     {:status (or code 400) :body {:error (or error "Failed to set span tokens")}})))}}]

    ;; Metadata operations
    (metadata/metadata-routes "span" :span-id get-project-id get-document-id s/get s/set-metadata s/delete-metadata s/patch-metadata)]])
