(ns plaid.rest-api.v1.vocab-link
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.bulk :as bulk]
            [plaid.rest-api.v1.metadata :as metadata]
            [plaid.rest-api.v1.middleware :as prm]
            [reitit.coercion.malli]
            [plaid.sql.vocab-link :as vocab-link]
            [plaid.sql.vocab-item :as vocab-item]
            [plaid.sql.user :as user]))

(def ^:private resolvers
  "The gate and document-version resolvers. A create's document is its first
  token's, and its project that document's."
  (pra/entity-resolvers {:table :vocab_links
                         :path-key :id
                         :create-document [:tokens :tokens]}))

(def ^:private get-project-id-from-tokens (:project-id resolvers))
(def ^:private get-project-id-from-vocab-link (:project-id resolvers))
(def ^:private get-document-id-from-tokens (:document-id resolvers))
(def ^:private get-document-id-from-vocab-link (:document-id resolvers))

(defn- user-can-access-vocab-item?
  "Read access to a vocab item, which is read access to its vocab layer. An
  item that does not exist is not accessible."
  [db vocab-item-id user-id]
  (when-let [item (vocab-item/get db vocab-item-id)]
    (pra/vocab-reader? db (:vocab-item/layer item) user-id)))

;; Bulk auth/version resolvers. The body is either an array of
;; {:vocab-item :tokens :metadata} (bulk create) or an array of link ids
;; (bulk delete). Both resolve project/document from the first entry that
;; RESOLVES (`pra/bulk-resolver`), as the other bulk endpoints do, so a link
;; a colleague already deleted at the head of the list does not turn the
;; call's own answer into a 403. The SQL layer enforces single-document, so
;; one resolved entry's project/document covers the whole call.
(def ^:private bulk-get-project-id (:bulk-project-id resolvers))
(def ^:private bulk-get-document-id (:bulk-document-id resolvers))

(defn get-vocab-id-from-vocab-item-body [{:keys [db parameters]}]
  (->> parameters :body :vocab-item (vocab-item/get db) :vocab-item/layer))

(defn get-vocab-id-from-vocab-link-path [{:keys [db parameters]}]
  (->> parameters :path :id (vocab-link/get-vocab-layer db)))

(def vocab-link-routes
  ["/vocab-links"
   [""
    {:post {:summary (str "Create a new vocab link (link between tokens and vocab item). <body>id</body>, optional, "
                          "is the new link's id, a UUIDv7 the client minted (else the server mints one). An id used "
                          "before, even by a link since deleted, is refused with 409 and <body>id-taken</body>.")
            ;; Linking annotates the DOCUMENT, not the vocabulary — the
            ;; vocab itself is untouched. So the gate is project-WRITER
            ;; (below) + vocab-READER (the vocab must be visible to the
            ;; user); vocab-writer was over-restrictive (decided 2026-06-10).
            :middleware [[pra/wrap-vocab-reader-required get-vocab-id-from-vocab-item-body]
                         [pra/wrap-writer-required get-project-id-from-tokens]
                         [prm/wrap-document-version get-document-id-from-tokens]
                         metadata/wrap-inline-metadata-shape-guard]
            :parameters {:query [:map [:document-version {:optional true} :int]]
                         :body [:map
                                [:id {:optional true} :uuid]
                                [:vocab-item :uuid]
                                [:tokens [:vector :uuid]]
                                [:metadata {:optional true} [:map-of string? any?]]]}
            :handler (fn [{{{:keys [id vocab-item tokens metadata]} :body} :parameters
                           db :db
                           user-id :user/id :as req}]
                       (let [attrs (cond-> {:vocab-link/vocab-item vocab-item
                                            :vocab-link/tokens tokens}
                                     (some? id) (assoc :vocab-link/id id))
                             doc-id (get-document-id-from-tokens req)
                             result (vocab-link/create db attrs user-id metadata)]
                         (if (:success result)
                           (prm/assoc-document-version-in-header
                            {:status 201
                             :body {:id (:extra result)}}
                            db doc-id)
                           (prm/op-error result {:extras? true}))))}}]

   (bulk/bulk-routes
    {:create-summary (str "Create multiple vocab links in a single operation. Provide an array of objects whose keys are:\n"
                          "<body>vocab-item</body>, the vocab item to link\n"
                          "<body>tokens</body>, the IDs of the tokens to link\n"
                          "<body>metadata</body>, an optional map of metadata\n"
                          "<body>id</body>, optional, the new link's id, a UUIDv7 the client minted (else the server mints one). An id used before is refused with 409 and <body>id-taken</body>, and one named twice with 400.\n"
                          "Entries may reference different vocab items, but all tokens across the call must belong to one document.")
     :create-entry [:map
                    [:id {:optional true} :uuid]
                    [:vocab-item :uuid]
                    [:tokens [:vector :uuid]]
                    [:metadata {:optional true} [:map-of string? any?]]]
     :->attrs (fn [{:keys [id vocab-item tokens]}]
                (cond-> {:vocab-link/vocab-item vocab-item
                         :vocab-link/tokens tokens}
                  (some? id) (assoc :vocab-link/id id)))
     :bulk-create vocab-link/bulk-create
     ;; project-WRITER gates the document; each distinct vocab layer must
     ;; also be vocab-READABLE (same as single create, relaxed 2026-06-10).
     ;; The single-id reader middleware can't express N layers, so the check
     ;; runs here. Admins bypass it (as `wrap-vocab-reader-required` does), so
     ;; an unknown item falls through to the SQL invariant's 400 rather than a
     ;; misleading 403.
     :create-check (fn [{db :db user-id :user/id user-record :user/record} links]
                     (let [item-ids (->> links (map :vocab-item) distinct)
                           unreadable (when-not (user/admin? user-record)
                                        (remove #(user-can-access-vocab-item? db % user-id) item-ids))]
                       (when (seq unreadable)
                         {:status 403
                          :body {:error (str "User " user-id " lacks read access to vocab item(s) " (vec unreadable))}})))
     :delete-summary "Delete multiple vocab links in a single operation. Provide an array of IDs."
     :bulk-delete vocab-link/bulk-delete
     ;; Mirror single delete's gate: project-WRITER + vocab-WRITER on each
     ;; distinct vocab layer touched.
     :delete-check (fn [{db :db user-id :user/id} ids]
                     (pra/vocab-layers-refusal db (keep #(vocab-link/get-vocab-layer db %) ids) user-id))
     :project-fn bulk-get-project-id
     :document-fn bulk-get-document-id})

   ["/:id"
    {:conflicting true
     :parameters {:path [:map [:id :uuid]]}}

    ["" {:get {:summary "Get a vocab link by ID"
               :middleware [[pra/wrap-vocab-reader-required get-vocab-id-from-vocab-link-path]
                            [pra/wrap-reader-required get-project-id-from-vocab-link]]
               :handler (fn [{{{:keys [id]} :path} :parameters
                              db :db :as req}]
                          (let [vocab-link-record (vocab-link/get db id)]
                            (if vocab-link-record
                              {:status 200
                               :body vocab-link-record}
                              {:status 404
                               :body {:error "vocab link not found"}})))}

         :delete {:summary "Delete a vocab link"
                  :middleware [[pra/wrap-vocab-writer-required get-vocab-id-from-vocab-link-path]
                               [pra/wrap-writer-required get-project-id-from-vocab-link]
                               [prm/wrap-document-version get-document-id-from-vocab-link]]
                  :parameters {:query [:map [:document-version {:optional true} :int]]}
                  :handler (fn [{{{:keys [id]} :path} :parameters
                                 db :db
                                 user-id :user/id :as req}]
                             (let [doc-id (get-document-id-from-vocab-link req)
                                   {:keys [success] :as result} (vocab-link/delete db id user-id)]
                               (if success
                                 (prm/assoc-document-version-in-header
                                  {:status 204}
                                  db doc-id)
                                 (prm/op-error result))))}}]

    ;; Metadata operations
    (metadata/metadata-routes "vocab link" :id get-project-id-from-vocab-link get-document-id-from-vocab-link vocab-link/get vocab-link/set-metadata vocab-link/delete-metadata vocab-link/patch-metadata)]])
