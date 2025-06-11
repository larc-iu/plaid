(ns plaid.rest-api.v1.document
  (:require [plaid.rest-api.v1.auth :as pra]
            [reitit.coercion.malli]
            [plaid.xtdb.document :as doc]))

(defn get-project-id [{xtdb :xtdb params :params}]
  (let [prj-id (-> params :body :project-id)
        doc-id (-> params :path :document-id)]
    (cond
      prj-id prj-id
      doc-id (-> (doc/get xtdb doc-id) :document/project)
      :else nil)))

(def document-routes
  ["/documents"

   ["" {:post {:summary    "Create a new document for a project."
               :middleware [[pra/wrap-writer-required get-project-id]]
               :parameters {:body [:map
                                   [:project-id :uuid]
                                   [:name :string]]}
               :handler    (fn [{{{:keys [project-id name]} :body} :parameters xtdb :xtdb}]
                             (let [attrs {:document/project project-id
                                          :document/name    name}
                                   result (doc/create {:node xtdb} attrs)]
                               (if (:success result)
                                 {:status 201
                                  :body   {:id (:extra result)}}
                                 {:status (or (:code result) 500)
                                  :body   {:error (:error result)}})))}}]

   ["/:document-id"
    {:parameters {:path [:map [:document-id :uuid]]}}

    ["" {:get    {:summary    "Get a document by ID. If includeBody is true, also includes all layers with data."
                  :middleware [[pra/wrap-reader-required get-project-id]]
                  :parameters {:query [:map [:include-body {:optional true} boolean?]]}
                  :handler    (fn [{{{:keys [document-id]} :path
                                     {:keys [include-body]} :query} :parameters
                                    xtdb :xtdb}]
                                (let [document (if include-body
                                                 (doc/get-with-layer-data xtdb document-id)
                                                 (doc/get xtdb document-id))]
                                  (if (some? document)
                                    {:status 200
                                     :body   (dissoc document :xt/id)}
                                    {:status 404
                                     :body   {:error "Document not found"}})))}
         :patch  {:summary    "Update a document's name."
                  :middleware [[pra/wrap-writer-required get-project-id]]
                  :parameters {:body [:map [:name :string]]}
                  :handler    (fn [{{{:keys [document-id]} :path {:keys [name]} :body} :parameters xtdb :xtdb}]
                                (let [{:keys [success code error]} (doc/merge {:node xtdb} document-id {:document/name name})]
                                  (if success
                                    {:status 200
                                     :body   (dissoc (doc/get xtdb document-id) :xt/id)}
                                    {:status (or code 404)
                                     :body   {:error (or error "Failed to update document or document not found")}})))}
         :delete {:summary    "Delete a document."
                  :middleware [[pra/wrap-writer-required get-project-id]]
                  :handler    (fn [{{{:keys [document-id]} :path} :parameters xtdb :xtdb}]
                                (let [{:keys [success code error]} (doc/delete {:node xtdb} document-id)]
                                  (if success
                                    {:status 204}
                                    {:status (or code 404)
                                     :body   {:error (or error "Document not found")}})))}}]]])