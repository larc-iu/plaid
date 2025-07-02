(ns plaid.rest-api.v1.vmap
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.metadata :as metadata]
            [plaid.rest-api.v1.middleware :as prm]
            [reitit.coercion.malli]
            [plaid.xtdb.vmap :as vmap]
            [plaid.xtdb.vocab-layer :as vocab-layer]
            [plaid.xtdb.user :as user]))

(defn get-project-id-from-tokens
  "Get project ID from tokens (for create operations)"
  [{db :db params :parameters}]
  (when-let [tokens (-> params :body :tokens)]
    (when (seq tokens)
      (vmap/project-id-from-token db (first tokens)))))

(defn get-project-id-from-vmap
  "Get project ID from existing vmap (for operations on existing vmaps)"
  [{db :db params :parameters}]
  (when-let [vmap-id (-> params :path :id)]
    (when-let [vmap-record (vmap/get db vmap-id)]
      (when-let [first-token-id (first (:vmap/tokens vmap-record))]
        (vmap/project-id-from-token db first-token-id)))))

(defn get-document-id-from-tokens
  "Get document ID from tokens (for create operations)"
  [{db :db params :parameters}]
  (when-let [tokens (-> params :body :tokens)]
    (when (seq tokens)
      (vmap/document-id-from-token db (first tokens)))))

(defn get-document-id-from-vmap
  "Get document ID from existing vmap (for operations on existing vmaps)"
  [{db :db params :parameters}]
  (when-let [vmap-id (-> params :path :id)]
    (when-let [vmap-record (vmap/get db vmap-id)]
      (when-let [first-token-id (first (:vmap/tokens vmap-record))]
        (vmap/document-id-from-token db first-token-id)))))

(defn- user-can-access-vocab-item?
  "Check if user can access a vocab item (read access to its vocab layer)"
  [xtdb vocab-item-id user-id]
  (let [vocab-item (plaid.xtdb.vocab-item/get xtdb vocab-item-id)]
    (when vocab-item
      (let [vocab-layer-id (:vocab-item/layer vocab-item)
            admin? (user/admin? (user/get xtdb user-id))
            maintainer? (vocab-layer/maintainer? xtdb vocab-layer-id user-id)
            accessible? (vocab-layer/accessible-through-project? xtdb vocab-layer-id user-id)]
        (or admin? maintainer? accessible?)))))

(def vmap-routes
  ["/vmaps"

   [""
    {:post {:summary "Create a new vmap (vocabulary mapping between tokens and vocab item)"
            :middleware [[pra/wrap-writer-required get-project-id-from-tokens]
                         [prm/wrap-document-version get-document-id-from-tokens]]
            :parameters {:query [:map [:document-version {:optional true} :uuid]]
                         :body [:map
                                [:vocab-item-id :uuid]
                                [:tokens [:vector :uuid]]
                                [:metadata {:optional true} [:map-of string? any?]]]}
            :handler (fn [{{{:keys [vocab-item-id tokens metadata]} :body} :parameters
                           xtdb :xtdb
                           user-id :user/id :as req}]
                       ;; Additional check: user must have read access to the vocab item
                       (if (user-can-access-vocab-item? xtdb vocab-item-id user-id)
                         (let [attrs {:vmap/vocab-item vocab-item-id
                                      :vmap/tokens tokens}
                               result (vmap/create {:node xtdb} attrs user-id metadata)]
                           (if (:success result)
                             {:status 201
                              :body {:id (:extra result)}}
                             {:status (or (:code result) 500)
                              :body {:error (:error result)}}))
                         {:status 403
                          :body {:error "Insufficient privileges to access the specified vocab item"}}))}}]

   ["/:id"
    {:parameters {:path [:map [:id :uuid]]}
     :get {:summary "Get a vmap by ID"
           :middleware [[pra/wrap-reader-required get-project-id-from-vmap]]
           :handler (fn [{{{:keys [id]} :path} :parameters
                          db :db :as req}]
                      (let [vmap-record (vmap/get db id)]
                        (if vmap-record
                          {:status 200
                           :body vmap-record}
                          {:status 404
                           :body {:error "VMap not found"}})))}

     :delete {:summary "Delete a vmap"
              :middleware [[pra/wrap-writer-required get-project-id-from-vmap]]
              :handler (fn [{{{:keys [id]} :path} :parameters
                             xtdb :xtdb
                             user-id :user/id :as req}]
                         (let [{:keys [success code error]} (vmap/delete {:node xtdb} id user-id)]
                           (if success
                             {:status 204}
                             {:status (or code 500)
                              :body {:error (or error "Internal server error")}})))}}]

    ;; Metadata operations
    (metadata/metadata-routes "vmap" :id get-project-id-from-vmap get-document-id-from-vmap vmap/get vmap/set-metadata vmap/delete-metadata)])