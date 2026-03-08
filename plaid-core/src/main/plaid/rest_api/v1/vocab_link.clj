(ns plaid.rest-api.v1.vocab-link
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.metadata :as metadata]
            [plaid.rest-api.v1.middleware :as prm]
            [reitit.coercion.malli]
            [plaid.xtdb2.vocab-link :as vocab-link]
            [plaid.xtdb2.vocab-item :as vocab-item]
            [plaid.xtdb2.vocab-layer :as vocab-layer]
            [plaid.xtdb2.user :as user]))

(defn get-project-id-from-tokens
  "Get project ID from tokens (for create operations)"
  [{xt-map :xt-map params :parameters}]
  (when-let [tokens (-> params :body :tokens)]
    (when (seq tokens)
      (vocab-link/project-id-from-token xt-map (first tokens)))))

(defn get-project-id-from-vocab-link
  "Get project ID from existing vocab-link (for operations on existing vocab-links)"
  [{xt-map :xt-map params :parameters}]
  (when-let [vocab-link-id (-> params :path :id)]
    (when-let [vocab-link-record (vocab-link/get xt-map vocab-link-id)]
      (when-let [first-token-id (first (:vocab-link/tokens vocab-link-record))]
        (vocab-link/project-id-from-token xt-map first-token-id)))))

(defn get-document-id-from-tokens
  "Get document ID from tokens (for create operations)"
  [{xt-map :xt-map params :parameters}]
  (when-let [tokens (-> params :body :tokens)]
    (when (seq tokens)
      (vocab-link/document-id-from-token xt-map (first tokens)))))

(defn get-document-id-from-vocab-link
  "Get document ID from existing vocab-link (for operations on existing vocab-links)"
  [{xt-map :xt-map params :parameters}]
  (when-let [vocab-link-id (-> params :path :id)]
    (when-let [vocab-link-record (vocab-link/get xt-map vocab-link-id)]
      (when-let [first-token-id (first (:vocab-link/tokens vocab-link-record))]
        (vocab-link/document-id-from-token xt-map first-token-id)))))

(defn- user-can-access-vocab-item?
  "Check if user can access a vocab item (read access to its vocab layer)"
  [node-or-map vocab-item-id user-id]
  (let [item (vocab-item/get node-or-map vocab-item-id)]
    (when item
      (let [vocab-layer-id (:vocab-item/layer item)
            admin? (user/admin? (user/get node-or-map user-id))
            maintainer? (vocab-layer/maintainer? node-or-map vocab-layer-id user-id)
            accessible? (vocab-layer/accessible-through-project? node-or-map vocab-layer-id user-id)]
        (or admin? maintainer? accessible?)))))

(defn get-vocab-id-from-vocab-item-body [{:keys [xt-map parameters]}]
  (->> parameters :body :vocab-item (vocab-item/get xt-map) :vocab-item/layer))

(defn get-vocab-id-from-vocab-link-path [{:keys [xt-map parameters]}]
  (->> parameters :path :id (vocab-link/get-vocab-layer xt-map)))

(def vocab-link-routes
  ["/vocab-links"
   [""
    {:post {:summary "Create a new vocab link (link between tokens and vocab item)."
            :middleware [[pra/wrap-vocab-writer-required get-vocab-id-from-vocab-item-body]
                         [pra/wrap-writer-required get-project-id-from-tokens]
                         [prm/wrap-document-version get-document-id-from-tokens]]
            :parameters {:query [:map [:document-version {:optional true} :uuid]]
                         :body [:map
                                [:vocab-item :uuid]
                                [:tokens [:vector :uuid]]
                                [:metadata {:optional true} [:map-of string? any?]]]}
            :handler (fn [{{{:keys [vocab-item tokens metadata]} :body} :parameters
                           xtdb :xtdb
                           user-id :user/id :as req}]
                       (let [attrs {:vocab-link/vocab-item vocab-item
                                    :vocab-link/tokens tokens}
                             result (vocab-link/create {:node xtdb} attrs user-id metadata)]
                         (if (:success result)
                           (prm/assoc-document-versions-in-header
                             {:status 201
                              :body {:id (:extra result)}}
                             result)
                           {:status (or (:code result) 500)
                            :body {:error (:error result)}})))}}]
   ["/:id"
    {:parameters {:path [:map [:id :uuid]]}}

    ["" {:get {:summary "Get a vocab link by ID"
               :middleware [[pra/wrap-vocab-reader-required get-vocab-id-from-vocab-link-path]
                            [pra/wrap-reader-required get-project-id-from-vocab-link]]
               :handler (fn [{{{:keys [id]} :path} :parameters
                              xt-map :xt-map :as req}]
                          (let [vocab-link-record (vocab-link/get xt-map id)]
                            (if vocab-link-record
                              {:status 200
                               :body vocab-link-record}
                              {:status 404
                               :body {:error "vocab link not found"}})))}

         :delete {:summary "Delete a vocab link"
                  :middleware [[pra/wrap-vocab-writer-required get-vocab-id-from-vocab-link-path]
                               [pra/wrap-writer-required get-project-id-from-vocab-link]
                               [prm/wrap-document-version get-document-id-from-vocab-link]]
                  :parameters {:query [:map [:document-version {:optional true} :uuid]]}
                  :handler (fn [{{{:keys [id]} :path} :parameters
                                 xtdb :xtdb
                                 user-id :user/id :as req}]
                             (let [{:keys [success code error] :as result} (vocab-link/delete {:node xtdb} id user-id)]
                               (if success
                                 (prm/assoc-document-versions-in-header
                                   {:status 204}
                                   result)
                                 {:status (or code 500)
                                  :body {:error (or error "Internal server error")}})))}}]

    ;; Metadata operations
    (metadata/metadata-routes "vocab link" :id get-project-id-from-vocab-link get-document-id-from-vocab-link vocab-link/get vocab-link/set-metadata vocab-link/delete-metadata)]])