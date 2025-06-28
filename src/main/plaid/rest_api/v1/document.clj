(ns plaid.rest-api.v1.document
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.metadata :as metadata]
            [reitit.coercion.malli]
            [plaid.xtdb.document :as doc]))

(defn get-project-id [{db :db params :params}]
  (let [prj-id (-> params :body :project-id)
        doc-id (-> params :path :document-id)]
    (cond
      prj-id prj-id
      doc-id (-> (doc/get db doc-id) :document/project)
      :else nil)))

(def document-routes
  ["/documents"

   ["" {:post {:summary    "Create a new document in a project. Requires <body>project-id</body> and <body>name</body>."
               :middleware [[pra/wrap-writer-required get-project-id]]
               :parameters {:body [:map
                                   [:project-id :uuid]
                                   [:name :string]
                                   [:metadata {:optional true} [:map-of string? any?]]]}
               :handler    (fn [{{{:keys [project-id name metadata]} :body} :parameters xtdb :xtdb user-id :user/id}]
                             (let [attrs {:document/project project-id
                                          :document/name    name}
                                   result (doc/create {:node xtdb} attrs user-id metadata)]
                               (if (:success result)
                                 {:status 201
                                  :body   {:id (:extra result)}}
                                 {:status (or (:code result) 500)
                                  :body   {:error (:error result)}})))}}]

   ["/:document-id"
    {:parameters {:path [:map [:document-id :uuid]]}}

    ["" {:get    {:summary    "Get a document. Set <query>include-body</query> to true in order to include all data contained in the document."
                  :middleware [[pra/wrap-reader-required get-project-id]]
                  :parameters {:query [:map [:include-body {:optional true} boolean?]]}
                  :handler    (fn [{{{:keys [document-id]} :path
                                     {:keys [include-body]} :query} :parameters
                                    db :db}]
                                (let [document (if include-body
                                                 (doc/get-with-layer-data db document-id)
                                                 (doc/get db document-id))]
                                  (if (some? document)
                                    {:status 200
                                     :body   document}
                                    {:status 404
                                     :body   {:error "Document not found"}})))}
         :patch  {:summary    "Update a document. Supported keys:\n\n<body>name</body>: update a document's name."
                  :middleware [[pra/wrap-writer-required get-project-id]]
                  :parameters {:body [:map [:name :string]]}
                  :handler    (fn [{{{:keys [document-id]} :path {:keys [name]} :body} :parameters xtdb :xtdb user-id :user/id}]
                                (let [{:keys [success code error]} (doc/merge {:node xtdb} document-id {:document/name name} user-id)]
                                  (if success
                                    {:status 200
                                     :body   (doc/get xtdb document-id)}
                                    {:status (or code 500)
                                     :body   {:error (or error "Internal server error")}})))}
         :delete {:summary    "Delete a document and all data contained."
                  :middleware [[pra/wrap-writer-required get-project-id]]
                  :handler    (fn [{{{:keys [document-id]} :path} :parameters xtdb :xtdb user-id :user/id}]
                                (let [{:keys [success code error]} (doc/delete {:node xtdb} document-id user-id)]
                                  (if success
                                    {:status 204}
                                    {:status (or code 500)
                                     :body   {:error (or error "Internal server error")}})))}}]

    ;; Metadata operations
    (metadata/metadata-routes "document" :document-id get-project-id doc/get doc/set-metadata doc/delete-metadata)]])