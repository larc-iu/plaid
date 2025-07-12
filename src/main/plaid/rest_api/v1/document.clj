(ns plaid.rest-api.v1.document
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.metadata :as metadata]
            [plaid.rest-api.v1.middleware :as prm]
            [plaid.server.locks :as locks]
            [reitit.coercion.malli]
            [plaid.xtdb.document :as doc]
            [clojure.data.json :as json]))

(defn get-project-id [{db :db params :parameters}]
  (let [prj-id (-> params :body :project-id)
        doc-id (-> params :path :document-id)]
    (cond
      prj-id prj-id
      doc-id (-> (doc/get db doc-id) :document/project)
      :else nil)))

(defn get-document-id [{params :parameters}]
  (-> params :path :document-id))

(def document-routes
  ["/documents"

   ["" {:post {:summary "Create a new document in a project. Requires <body>project-id</body> and <body>name</body>."
               :middleware [[pra/wrap-writer-required get-project-id]]
               :parameters {:body [:map
                                   [:project-id :uuid]
                                   [:name :string]
                                   [:metadata {:optional true} [:map-of string? any?]]]}
               :handler (fn [{{{:keys [project-id name metadata]} :body} :parameters xtdb :xtdb user-id :user/id}]
                          (let [attrs {:document/project project-id
                                       :document/name name}
                                result (doc/create {:node xtdb} attrs user-id metadata)]
                            (if (:success result)
                              (prm/assoc-document-versions-in-header
                                {:status 201
                                 :body {:id (:extra result)}}
                                result)
                              {:status (or (:code result) 500)
                               :body {:error (:error result)}})))}}]

   ["/:document-id"
    {:parameters {:path [:map [:document-id :uuid]]}}

    ["" {:get {:summary "Get a document. Set <query>include-body</query> to true in order to include all data contained in the document."
               :middleware [[pra/wrap-reader-required get-project-id]]
               :parameters {:query [:map [:include-body {:optional true} boolean?]]}
               :handler (fn [{{{:keys [document-id]} :path
                               {:keys [include-body]} :query} :parameters
                              db :db}]
                          (let [document (if include-body
                                           (doc/get-with-layer-data db document-id)
                                           (doc/get db document-id))]
                            (if (some? document)
                              {:status 200
                               :body document
                               :headers {"X-Document-Versions" (json/write-str {(:document/id document) (:document/version document)})}}
                              {:status 404
                               :body {:error "Document not found"}})))}
         :patch {:summary "Update a document. Supported keys:\n\n<body>name</body>: update a document's name."
                 :middleware [[pra/wrap-writer-required get-project-id]
                              [prm/wrap-document-version get-document-id]]
                 :parameters {:body [:map [:name :string]]
                              :query [:map [:document-version {:optional true} :uuid]]}
                 :handler (fn [{{{:keys [document-id]} :path {:keys [name]} :body} :parameters xtdb :xtdb user-id :user/id}]
                            (let [{:keys [success code error] :as result} (doc/merge {:node xtdb} document-id {:document/name name} user-id)]
                              (if success
                                (prm/assoc-document-versions-in-header
                                  {:status 200
                                   :body (doc/get xtdb document-id)}
                                  result)
                                {:status (or code 500)
                                 :body {:error (or error "Internal server error")}})))}
         :delete {:summary "Delete a document and all data contained."
                  :middleware [[pra/wrap-writer-required get-project-id]
                               [prm/wrap-document-version get-document-id]]
                  :parameters {:query [:map [:document-version {:optional true} :uuid]]}
                  :handler (fn [{{{:keys [document-id]} :path} :parameters xtdb :xtdb user-id :user/id}]
                             (let [{:keys [success code error] :as result} (doc/delete {:node xtdb} document-id user-id)]
                               (if success
                                 (prm/assoc-document-versions-in-header
                                   {:status 204}
                                   result)
                                 {:status (or code 500)
                                  :body {:error (or error "Internal server error")}})))}}]

    ["/lock"
     {:get {:summary "Get information about a document lock"
            :middleware [[pra/wrap-reader-required get-project-id]]
            :openapi {:x-client-method "check-lock"}
            :handler (fn [{{{:keys [document-id]} :path} :parameters}]
                       (if-let [lock-info (locks/get-lock-info document-id)]
                         {:status 200
                          :body {:user-id (:user-id lock-info)
                                 :expires-at (:expires-at lock-info)}}
                         {:status 204}))}

      :post {:summary "Acquire or refresh a document lock"
             :middleware [[pra/wrap-writer-required get-project-id]]
             :openapi {:x-client-method "acquire-lock"}
             :handler (fn [{{{:keys [document-id]} :path} :parameters user-id :user/id}]
                        (let [result (locks/acquire-lock! document-id user-id)]
                          (case result
                            :acquired {:status 200 :body (locks/get-lock-info document-id)}
                            :refreshed {:status 200 :body (locks/get-lock-info document-id)}
                            :conflict {:status 423
                                       :body {:error "Document is locked by another user"
                                              :user-id (:user-id (locks/get-lock-info document-id))}})))}

      :delete {:summary "Release a document lock"
               :middleware [[pra/wrap-writer-required get-project-id]]
               :openapi {:x-client-method "release-lock"}
               :handler (fn [{{{:keys [document-id]} :path} :parameters user-id :user/id}]
                          (let [result (locks/release-lock! document-id user-id)]
                            (case result
                              :released {:status 204}
                              :not-held {:status 204})))}}]

    ;; Metadata operations
    (metadata/metadata-routes "document" :document-id get-project-id get-document-id doc/get doc/set-metadata doc/delete-metadata)]])