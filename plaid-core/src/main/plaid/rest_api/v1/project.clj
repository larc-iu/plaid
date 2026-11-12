(ns plaid.rest-api.v1.project
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.schema :as schema]
            [plaid.rest-api.v1.middleware :as prm]
            [plaid.rest-api.v1.layer :refer [layer-config-routes]]
            [plaid.rest-api.v1.pagination :as pagination]
            [plaid.server.project-removal :as removal]
            [reitit.coercion.malli]
            [plaid.sql.operation :as op]
            [plaid.sql.project :as prj]
            [plaid.sql.vocab-layer :as vocab]))

(defn get-project-id [{params :parameters}]
  (-> params :path :id))

(def project-routes
  ["/projects"

   [""
    {:get {:summary "List all projects accessible to user"
           :parameters {:query (into [:map] pagination/query-params)}
           :handler (fn [{db :db user-id :user/id {query :query} :parameters}]
                      (pagination/list-response
                       query
                       (fn [opts] (prj/get-accessible db user-id opts))))}
     :post {:summary (str "Create a new project. Note: this also registers the user as a maintainer. "
                          "<body>id</body>, optional, is the new project's id, a UUIDv7 the client minted (else "
                          "the server mints one). An id used before is refused with 409 and <body>id-taken</body>.")
            :parameters {:body [:map
                                [:id {:optional true} :uuid]
                                [:name string?]]}
            :handler (fn [{{{:keys [id name]} :body} :parameters db :db user-id :user/id :as req}]
                       (let [result (prj/create db (cond-> {:project/name name
                                                            :project/maintainers [user-id]}
                                                     (some? id) (assoc :project/id id))
                                                user-id)]
                         (if (:success result)
                           {:status 201
                            :body {:id (:extra result)}}
                           (prm/op-error result {:extras? true}))))}}]

   ["/:id"
    {:parameters {:path [:map [:id :uuid]]}
     :get {:summary "Get a project by ID."
           :middleware [[pra/wrap-reader-required get-project-id]]
           :handler (fn [{{{:keys [id]} :path} :parameters
                          db :db}]
                      (let [project (prj/get db id)]
                        (if (some? project)
                          {:status 200
                           :body project}
                          {:status 404
                           :body {:error "Project not found"}})))}

     :patch {:summary "Update a project's name."
             :middleware [[pra/wrap-maintainer-required get-project-id]]
             :parameters {:body [:map [:name string?]]}
             :handler (fn [{{{:keys [id]} :path {:keys [name]} :body} :parameters db :db user-id :user/id :as req}]
                        (let [{:keys [success] :as result} (prj/merge db id {:project/name name} user-id)]
                          (if success
                            {:status 200
                             :body (prj/get db id)}
                            (prm/op-error result {:message nil}))))}

     :delete {:summary (str "Delete a project, with its own vocabularies. It is gone at once, and what it holds is "
                            "removed in the background. Refused (409) while another project links one of its "
                            "vocabularies, for everyone, admins included, the body counting those projects as "
                            "<body>other-projects</body> without naming them. Takes no query parameter but the audit "
                            "labels (400 otherwise, nothing deleted). What it would take is "
                            "GET /projects/{id}/deletion.")
              :middleware [[pra/wrap-maintainer-required get-project-id]
                           [prm/wrap-only-query-params #{}]]
              :handler (fn [{{{:keys [id]} :path} :parameters
                             datasource :plaid/datasource user-id :user/id db :db}]
                         (let [{:keys [success] :as result} (prj/delete db id user-id)]
                           (if success
                             (do
                               ;; After the commit: inside an atomic batch the
                               ;; delete may still roll back.
                               (op/after-commit! #(removal/schedule! datasource id))
                               {:status 204})
                             (prm/op-error result {:extras? true}))))}}]

   ["/:id/deletion"
    {:parameters {:path [:map [:id :uuid]]}
     :get {:summary (str "What deleting a project would take beside its documents, without writing: "
                         "{vocabularies: [{id, name}]}, its own vocabularies by name. A read, never the delete. The "
                         "same people may ask as may delete it, and it answers the delete's refusals: 409 with "
                         "<body>other-projects</body> while another project links one of its vocabularies, 404 for a "
                         "project being deleted.")
           :middleware [[pra/wrap-maintainer-required get-project-id]]
           :handler (fn [{{{:keys [id]} :path} :parameters db :db}]
                      (try
                        {:status 200 :body (prj/delete-preview db id)}
                        (catch clojure.lang.ExceptionInfo e (prm/refusal-response e))))}}]

   ;; Documents (keyset-paginated)
   ["/:id/documents"
    {:get {:summary "List documents in a project."
           :middleware [[pra/wrap-reader-required get-project-id]]
           :parameters {:path [:map [:id :uuid]]
                        :query (into [:map] pagination/query-params)}
           :handler (fn [{{{:keys [id]} :path query :query} :parameters db :db}]
                      (pagination/list-response
                       query
                       (fn [opts] (prj/get-documents-page db id opts))))}}]

   ;; Access management endpoints
   ["/:id"
    {:middleware [[pra/wrap-maintainer-required get-project-id]]}
    (for [[role grant-summary revoke-summary]
          [["reader" "Set a user's access level to read-only for this project."
            "Remove a user's reader privileges for this project."]
           ["writer" "Set a user's access level to read and write for this project."
            "Remove a user's writer privileges for this project."]
           ["maintainer" "Assign a user as a maintainer for this project."
            "Remove a user's maintainer privileges for this project."]]
          :let [handler (fn [f]
                          (fn [{{{:keys [id user-id]} :path} :parameters db :db actor-user-id :user/id}]
                            (let [{:keys [success] :as result} (f db id user-id role actor-user-id)]
                              (if success
                                {:status 204}
                                (prm/op-error result {:message nil})))))
                parameters {:path [:map [:id :uuid] [:user-id schema/user-id]]}]]
      [(str "/" role "s/:user-id")
       {:post {:summary grant-summary
               :parameters parameters
               :handler (handler prj/grant-role)}
        :delete {:summary revoke-summary
                 :parameters parameters
                 :handler (handler prj/revoke-role)}}])]

   ;; Vocabs. A vocabulary belongs to one project, its home; another project
   ;; may link it as a borrower, read only. Linking or unlinking changes who
   ;; reaches the vocabulary, which a delegated token may not do
   ;; (`pra/token-scope-gate`).
   ["/:id/vocabs/:vocab-id"
    {:plaid/vocabulary-admin true
     :parameters {:path [:map [:id :uuid] [:vocab-id :uuid]]}
     :post {:summary (str "Link a vocabulary to a project, which then borrows it: its members read it and link "
                          "tokens to its entries, and change none. Requires maintainer rights on the project and "
                          "any role on the vocabulary's home project. Linking a vocabulary to its home changes "
                          "nothing.")
            ;; The link grants every member of the project read access to
            ;; the vocabulary, so the person making it must reach the
            ;; vocabulary's home themselves.
            :middleware [[pra/wrap-maintainer-required get-project-id]
                         [pra/wrap-vocab-home-member-required
                          (fn [{p :parameters}] (-> p :path :vocab-id))
                          prj/borrow-refusal]]
            :handler (fn [{{{:keys [id vocab-id]} :path} :parameters db :db user-id :user/id :as req}]
                       (if (= (str id) (str (vocab/home-of db vocab-id)))
                         {:status 204}
                         (let [{:keys [success] :as result} (prj/add-vocab db id vocab-id user-id)]
                           (if success
                             {:status 204}
                             (prm/op-error result {:message nil})))))}

     :delete {:summary (str "Unlink a vocabulary from a project that borrows it, removing its links in that "
                            "project's documents. Requires maintainer rights on that project, or on the "
                            "vocabulary's home project, whose maintainers may end any project's borrowing. Refused "
                            "(409) for the vocabulary's home, which cannot unlink its own vocabulary. Takes no query "
                            "parameter but the audit labels (400 otherwise, nothing unlinked). What it would remove "
                            "is GET /projects/{id}/vocabs/{vocab-id}/unlinking.")
              :middleware [[pra/wrap-vocab-unlink-required get-project-id (fn [{p :parameters}] (-> p :path :vocab-id))]
                           [prm/wrap-only-query-params #{}]]
              :handler (fn [{{{:keys [id vocab-id]} :path} :parameters
                             db :db user-id :user/id :as req}]
                         (let [{:keys [success documents] :as result}
                               (prj/remove-vocab db id vocab-id user-id)]
                           (if success
                             ;; Unlinking drops the vocabulary's links in this
                             ;; project's documents and bumps their versions,
                             ;; named only where the caller may read them.
                             (prm/assoc-document-versions-in-header
                              {:status 204} db (pra/readable-document-ids req documents))
                             (prm/op-error result {:message nil}))))}}]

   ["/:id/vocabs/:vocab-id/unlinking"
    {:plaid/vocabulary-admin true
     :parameters {:path [:map [:id :uuid] [:vocab-id :uuid]]}
     :get {:summary (str "What unlinking a vocabulary from a project would remove, without writing: {links}, the "
                         "links in that project's documents to its entries, and nothing else about them. A read, "
                         "never the unlink. The same people may ask as may unlink, and it answers the unlink's "
                         "refusals: 409 for the vocabulary's home.")
           :middleware [[pra/wrap-vocab-unlink-required get-project-id (fn [{p :parameters}] (-> p :path :vocab-id))]]
           :handler (fn [{{{:keys [id vocab-id]} :path} :parameters db :db}]
                      (try
                        {:status 200 :body (prj/remove-vocab-preview db id vocab-id)}
                        (catch clojure.lang.ExceptionInfo e (prm/refusal-response e))))}}]

   ;; Config endpoints
   ["/:id"
    {:middleware [[pra/wrap-maintainer-required get-project-id]]}
    (layer-config-routes :projects :id)]])
