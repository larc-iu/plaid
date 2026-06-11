(ns plaid.rest-api.v1.document
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.metadata :as metadata]
            [plaid.rest-api.v1.middleware :as prm]
            [plaid.rest-api.v1.media :as media]
            [plaid.history.read :as hread]
            [plaid.server.locks :as locks]
            [reitit.coercion.malli]
            [plaid.sql.document :as doc]))

;; Defined below; forward-declared so the auth-path history read in
;; get-project-id can be timeout-bounded like the GET handler's read.
(defn get-project-id
  "Resolve the project id for permission checks.

  Order: explicit body `:project-id` wins (POST create); else look up
  the doc's project on the OLTP `:db`; else, for at-time GETs, fall
  through to audit-log reconstruction at `:as-of-ts` so docs that were
  deleted from OLTP but existed at `ts` still resolve their project
  (the privilege check then runs against CURRENT ACL membership —
  historical ACL is out of scope per design)."
  [{db :db params :parameters as-of-ts :as-of-ts}]
  (let [prj-id (-> params :body :project-id)
        doc-id (-> params :path :document-id)]
    (cond
      prj-id prj-id
      doc-id (or (-> (doc/get db doc-id) :document/project)
                 (when as-of-ts
                   ;; Reconstruction fallthrough: doc was deleted from
                   ;; OLTP but may have existed at ts. A :history/pruned
                   ;; throw propagates to wrap-route-as-of (outer to this
                   ;; auth middleware) for a structured 400.
                   (-> (hread/get-at db doc-id as-of-ts)
                       :document/project)))
      :else nil)))

(defn get-document-id [{params :parameters}]
  (-> params :path :document-id))

(def document-routes
  ["/documents"

   ["" {:post {:summary "Create a new document in a project. Requires <body>project-id</body> and <body>name</body>."
               :middleware [[pra/wrap-writer-required get-project-id]
                            metadata/wrap-inline-metadata-shape-guard]
               :parameters {:body [:map
                                   [:project-id :uuid]
                                   [:name :string]
                                   [:metadata {:optional true} [:map-of string? any?]]]}
               :handler (fn [{{{:keys [project-id name metadata]} :body} :parameters db :db user-id :user/id}]
                          (let [attrs {:document/project project-id
                                       :document/name name}
                                result (doc/create db attrs user-id metadata)]
                            (if (:success result)
                              (prm/assoc-document-version-in-header
                               {:status 201
                                :body {:id (:extra result)}}
                               db (:extra result))
                              {:status (or (:code result) 500)
                               :body {:error (:error result)}})))}}]

   ["/:document-id"
    {:parameters {:path [:map [:document-id :uuid]]}}

    ["" {:get {:summary "Get a document. Set <query>include-body</query> to true in order to include all data contained in the document."
               :middleware [[pra/wrap-reader-required get-project-id]]
               :parameters {:query [:map [:include-body {:optional true} boolean?]]}
               :handler (fn [{{{:keys [document-id]} :path
                               {:keys [include-body]} :query} :parameters
                              db :db
                              as-of-ts :as-of-ts}]
                          ;; `wrap-route-as-of` injects :as-of-ts when ?as-of=
                          ;; was supplied. In that case serve the read from the
                          ;; audit log (plaid.history.read); the SQL deep-read
                          ;; shape is the contract on both sides. The version
                          ;; header is OLTP-only — at-time reads can't usefully
                          ;; advise OCC against the current row.
                          (let [document (cond
                                           (and as-of-ts include-body)
                                           (hread/get-with-layer-data-at db document-id as-of-ts)
                                           as-of-ts
                                           (hread/get-at db document-id as-of-ts)
                                           include-body
                                           (doc/get-with-layer-data db document-id)
                                           :else
                                           (doc/get db document-id))]
                            (if (some? document)
                              (if as-of-ts
                                {:status 200 :body document}
                                (prm/assoc-document-version-in-header
                                 {:status 200
                                  :body document}
                                 db document-id))
                              {:status 404
                               :body {:error "Document not found"}})))}
         :patch {:summary "Update a document. Supported keys:\n\n<body>name</body>: update a document's name."
                 :middleware [[pra/wrap-writer-required get-project-id]
                              [prm/wrap-document-version get-document-id]]
                 :parameters {:body [:map [:name :string]]
                              :query [:map [:document-version {:optional true} :int]]}
                 :handler (fn [{{{:keys [document-id]} :path {:keys [name]} :body} :parameters db :db user-id :user/id}]
                            (let [{:keys [success code error]} (doc/merge db document-id {:document/name name} user-id)]
                              (if success
                                (prm/assoc-document-version-in-header
                                 {:status 200
                                  :body (doc/get db document-id)}
                                 db document-id)
                                {:status (or code 500)
                                 :body {:error (or error "Internal server error")}})))}
         :delete {:summary "Delete a document and all data contained."
                  :middleware [[pra/wrap-writer-required get-project-id]
                               [prm/wrap-document-version get-document-id]]
                  :parameters {:query [:map [:document-version {:optional true} :int]]}
                  :handler (fn [{{{:keys [document-id]} :path} :parameters db :db user-id :user/id}]
                             (let [{:keys [success code error]} (doc/delete db document-id user-id)]
                               (if success
                                 {:status 204}
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

    ;; Media operations
    media/media-routes

    ;; Metadata operations
    (metadata/metadata-routes "document" :document-id get-project-id get-document-id doc/get doc/set-metadata doc/delete-metadata doc/patch-metadata)]])
