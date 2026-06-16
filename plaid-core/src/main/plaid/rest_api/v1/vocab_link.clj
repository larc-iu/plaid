(ns plaid.rest-api.v1.vocab-link
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.metadata :as metadata]
            [plaid.rest-api.v1.middleware :as prm]
            [reitit.coercion.malli]
            [plaid.sql.vocab-link :as vocab-link]
            [plaid.sql.vocab-item :as vocab-item]
            [plaid.sql.vocab-layer :as vocab-layer]
            [plaid.sql.user :as user]))

(defn get-project-id-from-tokens
  "Get project ID from tokens (for create operations)"
  [{db :db params :parameters}]
  (when-let [tokens (-> params :body :tokens)]
    (when (seq tokens)
      (vocab-link/project-id-from-token db (first tokens)))))

(defn get-project-id-from-vocab-link
  "Get project ID from existing vocab-link (for operations on existing vocab-links)"
  [{db :db params :parameters}]
  (when-let [vocab-link-id (-> params :path :id)]
    (when-let [vocab-link-record (vocab-link/get db vocab-link-id)]
      (when-let [first-token-id (first (:vocab-link/tokens vocab-link-record))]
        (vocab-link/project-id-from-token db first-token-id)))))

(defn get-document-id-from-tokens
  "Get document ID from tokens (for create operations)"
  [{db :db params :parameters}]
  (when-let [tokens (-> params :body :tokens)]
    (when (seq tokens)
      (vocab-link/document-id-from-token db (first tokens)))))

(defn get-document-id-from-vocab-link
  "Get document ID from existing vocab-link (for operations on existing vocab-links)"
  [{db :db params :parameters}]
  (when-let [vocab-link-id (-> params :path :id)]
    (when-let [vocab-link-record (vocab-link/get db vocab-link-id)]
      (when-let [first-token-id (first (:vocab-link/tokens vocab-link-record))]
        (vocab-link/document-id-from-token db first-token-id)))))

(defn- user-can-access-vocab-item?
  "Check if user can access a vocab item (read access to its vocab layer)"
  [db vocab-item-id user-id]
  (let [item (vocab-item/get db vocab-item-id)]
    (when item
      (let [vocab-layer-id (:vocab-item/layer item)
            admin? (user/admin? (user/get db user-id))
            maintainer? (vocab-layer/maintainer? db vocab-layer-id user-id)
            accessible? (vocab-layer/accessible-through-project? db vocab-layer-id user-id)]
        (or admin? maintainer? accessible?)))))

(defn- user-can-write-vocab-layer?
  "Check if user has write access to a vocab layer (the gate single delete uses
  via `wrap-vocab-writer-required`)."
  [db vocab-layer-id user-id]
  (let [admin? (user/admin? (user/get db user-id))
        maintainer? (vocab-layer/maintainer? db vocab-layer-id user-id)
        write? (vocab-layer/write-accessible-through-project? db vocab-layer-id user-id)]
    (or admin? maintainer? write?)))

;; Bulk auth/version resolvers. The body is either an array of
;; {:vocab-item :tokens :metadata} (bulk create) or an array of link ids
;; (bulk delete); both resolve project/document from the FIRST element, as the
;; other bulk endpoints do. The SQL layer enforces single-document, so the
;; first element's project/document covers the whole call.
(defn bulk-get-project-id [{db :db params :parameters}]
  (let [item (-> params :body first)]
    (cond
      (and (map? item) (-> item :tokens seq)) (vocab-link/project-id-from-token db (-> item :tokens first))
      (uuid? item) (vocab-link/project-id db item)
      :else nil)))

(defn bulk-get-document-id [{db :db params :parameters}]
  (let [item (-> params :body first)]
    (cond
      (and (map? item) (-> item :tokens seq)) (vocab-link/document-id-from-token db (-> item :tokens first))
      (uuid? item) (:vocab-link/document (vocab-link/get db item))
      :else nil)))

(defn get-vocab-id-from-vocab-item-body [{:keys [db parameters]}]
  (->> parameters :body :vocab-item (vocab-item/get db) :vocab-item/layer))

(defn get-vocab-id-from-vocab-link-path [{:keys [db parameters]}]
  (->> parameters :path :id (vocab-link/get-vocab-layer db)))

(def vocab-link-routes
  ["/vocab-links"
   [""
    {:post {:summary "Create a new vocab link (link between tokens and vocab item)."
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
                                [:vocab-item :uuid]
                                [:tokens [:vector :uuid]]
                                [:metadata {:optional true} [:map-of string? any?]]]}
            :handler (fn [{{{:keys [vocab-item tokens metadata]} :body} :parameters
                           db :db
                           user-id :user/id :as req}]
                       (let [attrs {:vocab-link/vocab-item vocab-item
                                    :vocab-link/tokens tokens}
                             doc-id (get-document-id-from-tokens req)
                             result (vocab-link/create db attrs user-id metadata)]
                         (if (:success result)
                           (prm/assoc-document-version-in-header
                            {:status 201
                             :body {:id (:extra result)}}
                            db doc-id)
                           {:status (or (:code result) 500)
                            :body {:error (:error result)}})))}}]

   ["/bulk" {:conflicting true
             :post {:summary (str "Create multiple vocab links in a single operation. Provide an array of objects whose keys are:\n"
                                  "<body>vocab-item</body>, the vocab item to link\n"
                                  "<body>tokens</body>, the IDs of the tokens to link\n"
                                  "<body>metadata</body>, an optional map of metadata\n"
                                  "Entries may reference different vocab items, but all tokens across the call must belong to one document.")
                    ;; project-WRITER gates the document; each distinct vocab
                    ;; layer must also be vocab-READABLE (same as single create,
                    ;; relaxed 2026-06-10). The single-id reader middleware can't
                    ;; express N layers, so that check runs in the handler.
                    :middleware [[pra/wrap-writer-required bulk-get-project-id]
                                 [prm/wrap-document-version bulk-get-document-id]
                                 metadata/wrap-inline-metadata-shape-guard]
                    :parameters {:query [:map [:document-version {:optional true} :int]]
                                 :body [:sequential
                                        [:map
                                         [:vocab-item :uuid]
                                         [:tokens [:vector :uuid]]
                                         [:metadata {:optional true} [:map-of string? any?]]]]}
                    :handler (fn [{{links :body} :parameters db :db user-id :user/id user-record :user/record :as req}]
                               ;; Admins bypass the reader gate (as `wrap-vocab-reader-required`
                               ;; does), so an unknown item falls through to the SQL invariant's
                               ;; 400 rather than a misleading 403.
                               (let [item-ids (->> links (map :vocab-item) distinct)
                                     unreadable (when-not (user/admin? user-record)
                                                  (remove #(user-can-access-vocab-item? db % user-id) item-ids))]
                                 (if (seq unreadable)
                                   {:status 403
                                    :body {:error (str "User " user-id " lacks read access to vocab item(s) " (vec unreadable))}}
                                   (let [attrs-vec (mapv (fn [{:keys [vocab-item tokens metadata]}]
                                                           (cond-> {:vocab-link/vocab-item vocab-item
                                                                    :vocab-link/tokens tokens}
                                                             metadata (assoc :metadata metadata)))
                                                         links)
                                         doc-id (bulk-get-document-id req)
                                         result (vocab-link/bulk-create db attrs-vec user-id)]
                                     (if (:success result)
                                       (prm/assoc-document-version-in-header
                                        {:status 201 :body {:ids (:extra result)}}
                                        db doc-id)
                                       {:status (or (:code result) 500)
                                        :body {:error (:error result)}})))))}
             :delete {:summary "Delete multiple vocab links in a single operation. Provide an array of IDs."
                      ;; Mirror single delete's gate: project-WRITER + vocab-WRITER
                      ;; on each distinct vocab layer touched.
                      :middleware [[pra/wrap-writer-required bulk-get-project-id]
                                   [prm/wrap-document-version bulk-get-document-id]]
                      :parameters {:query [:map [:document-version {:optional true} :int]]
                                   :body [:sequential :uuid]}
                      :handler (fn [{{ids :body} :parameters db :db user-id :user/id :as req}]
                                 (let [layer-ids (->> ids (keep #(vocab-link/get-vocab-layer db %)) distinct)
                                       unwritable (remove #(user-can-write-vocab-layer? db % user-id) layer-ids)]
                                   (if (seq unwritable)
                                     {:status 403
                                      :body {:error (str "User " user-id " lacks write access to vocab layer(s) " (vec unwritable))}}
                                     (let [doc-id (bulk-get-document-id req)
                                           {:keys [success code error]} (vocab-link/bulk-delete db ids user-id)]
                                       (if success
                                         (prm/assoc-document-version-in-header
                                          {:status 204}
                                          db doc-id)
                                         {:status (or code 500)
                                          :body {:error (or error "Internal server error")}})))))}}]

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
                                   {:keys [success code error]} (vocab-link/delete db id user-id)]
                               (if success
                                 (prm/assoc-document-version-in-header
                                  {:status 204}
                                  db doc-id)
                                 {:status (or code 500)
                                  :body {:error (or error "Internal server error")}})))}}]

    ;; Metadata operations
    (metadata/metadata-routes "vocab link" :id get-project-id-from-vocab-link get-document-id-from-vocab-link vocab-link/get vocab-link/set-metadata vocab-link/delete-metadata vocab-link/patch-metadata)]])
