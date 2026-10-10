(ns plaid.rest-api.v1.bulk
  "The `/bulk` create, update and delete routes of spans, relations, tokens
  and vocab links, which differ only in their body schema, their attribute
  mapping and the sql functions they call."
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.metadata :as metadata]
            [plaid.rest-api.v1.middleware :as prm]))

(defn bulk-routes
  "The `[\"/bulk\" ...]` route of one entity kind.

    :create-summary, :create-entry  the POST's summary and its entry schema
    :->attrs        `(fn [entry])` -> the sql attrs of one entry, without its
                    metadata (added here when the entry has some)
    :bulk-create    `(fn [db attrs-vec user-id])`
    :create-check   optional `(fn [request entries])` -> a refusal response,
                    or nil to go on
    :update-summary, :update-entry, :bulk-update  the PATCH, left out when
                    `:bulk-update` is nil
    :delete-summary, :bulk-delete  the DELETE
    :delete-check   optional `(fn [request ids])`, as `:create-check`
    :project-fn, :document-fn  the create and delete resolvers
    :update-project-fn, :update-document-fn  the update resolvers"
  [{:keys [create-summary create-entry ->attrs bulk-create create-check
           update-summary update-entry bulk-update
           delete-summary bulk-delete delete-check
           project-fn document-fn update-project-fn update-document-fn]}]
  (let [query [:map [:document-version {:optional true} :int]]]
    ["/bulk"
     (cond-> {:conflicting true
              :post {:summary create-summary
                     :middleware [[pra/wrap-writer-required project-fn]
                                  [prm/wrap-document-version document-fn]
                                  metadata/wrap-inline-metadata-shape-guard]
                     :parameters {:query query
                                  :body [:sequential create-entry]}
                     :handler (fn [{{entries :body} :parameters db :db user-id :user/id :as request}]
                                (or (when create-check (create-check request entries))
                                    (let [attrs-vec (mapv (fn [entry]
                                                            (cond-> (->attrs entry)
                                                              (:metadata entry) (assoc :metadata (:metadata entry))))
                                                          entries)
                                          doc-id (document-fn request)
                                          result (bulk-create db attrs-vec user-id)]
                                      (if (:success result)
                                        (prm/assoc-document-version-in-header
                                         {:status 201 :body {:ids (:extra result)}}
                                         db doc-id)
                                        {:status (or (:code result) 500) :body (prm/error-body result)}))))}
              :delete {:summary delete-summary
                       :middleware [[pra/wrap-bulk-delete-of-nothing project-fn]
                                    [pra/wrap-writer-required project-fn]
                                    [prm/wrap-document-version document-fn]]
                       :parameters {:query query
                                    :body [:sequential :uuid]}
                       :handler (fn [{{ids :body} :parameters db :db user-id :user/id :as request}]
                                  (or (when delete-check (delete-check request ids))
                                      (let [doc-id (document-fn request)
                                            {:keys [success code error]} (bulk-delete db ids user-id)]
                                        (if success
                                          (prm/assoc-document-version-in-header {:status 204} db doc-id)
                                          {:status (or code 500) :body {:error (or error "Internal server error")}}))))}}
       bulk-update
       (assoc :patch {:summary update-summary
                      :middleware [[pra/wrap-writer-required update-project-fn]
                                   [prm/wrap-document-version update-document-fn]
                                   metadata/wrap-inline-metadata-shape-guard]
                      :parameters {:query query
                                   :body [:sequential update-entry]}
                      :handler (fn [{{items :body} :parameters db :db user-id :user/id}]
                                 (let [{:keys [success code error extra]} (bulk-update db items user-id)]
                                   (if success
                                     (prm/assoc-document-versions-in-header
                                      {:status 200 :body {:count (:count extra)}}
                                      db (:documents extra))
                                     {:status (or code 500) :body {:error (or error "Internal server error")}})))}))]))
