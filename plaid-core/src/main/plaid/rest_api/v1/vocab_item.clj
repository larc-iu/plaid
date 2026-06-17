(ns plaid.rest-api.v1.vocab-item
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.metadata :as metadata]
            [reitit.coercion.malli]
            [plaid.sql.vocab-item :as vocab-item]
            [plaid.sql.vocab-layer :as vocab-layer]
            [plaid.sql.user :as user]))

(defn get-vocab-id-from-layer
  "Get vocab layer ID from request parameters (for create operations)"
  [{params :parameters}]
  (-> params :body :vocab-layer-id))

(defn get-vocab-id-from-item
  "Get vocab layer ID from existing vocab item (for operations on existing items)"
  [{db :db params :parameters}]
  (when-let [item-id (-> params :path :id)]
    (when-let [item (vocab-item/get db item-id)]
      (:vocab-item/layer item))))

(defn- user-can-write-vocab-layer?
  "Check if user has write access to a vocab layer (the gate single
  create/delete uses via `wrap-vocab-writer-required`). The bulk endpoint
  can touch N distinct layers, which the single-id middleware can't express,
  so the per-layer check runs in the handler."
  [db vocab-layer-id user-id]
  (let [admin? (user/admin? (user/get db user-id))
        maintainer? (vocab-layer/maintainer? db vocab-layer-id user-id)
        write? (vocab-layer/write-accessible-through-project? db vocab-layer-id user-id)]
    (or admin? maintainer? write?)))

;; Bulk auth resolvers. Both resolve the coarse vocab-layer gate from the
;; FIRST element (create: each entry carries :vocab-layer-id; delete: the
;; entry is an item id whose layer we look up); the handler then checks
;; every distinct layer.
(defn bulk-get-layer-id [{params :parameters}]
  (-> params :body first :vocab-layer-id))

(defn bulk-get-layer-id-from-item [{db :db params :parameters}]
  (let [id (-> params :body first)]
    (when (uuid? id)
      (:vocab-item/layer (vocab-item/get db id)))))

(def vocab-item-routes
  ["/vocab-items"

   [""
    {:post {:summary "Create a new vocab item"
            :middleware [[pra/wrap-vocab-writer-required get-vocab-id-from-layer]
                         metadata/wrap-inline-metadata-shape-guard]
            :parameters {:body [:map
                                [:vocab-layer-id :uuid]
                                [:form string?]
                                [:metadata {:optional true} [:map-of string? any?]]]}
            :handler (fn [{{{:keys [vocab-layer-id form metadata]} :body} :parameters
                           db :db
                           user-id :user/id :as req}]
                       (let [attrs {:vocab-item/layer vocab-layer-id
                                    :vocab-item/form form}
                             result (vocab-item/create db attrs user-id metadata)]
                         (if (:success result)
                           {:status 201
                            :body {:id (:extra result)}}
                           {:status (or (:code result) 500)
                            :body {:error (:error result)}})))}}]

   ["/bulk" {:conflicting true
             :post {:summary (str "Create multiple vocab items in a single operation. Provide an array of objects whose keys are:\n"
                                  "<body>vocab-layer-id</body>, the vocab layer to create the item in\n"
                                  "<body>form</body>, the item's form\n"
                                  "<body>metadata</body>, an optional map of metadata\n"
                                  "Entries may target different vocab layers; the user must have write access to each.")
                    ;; vocab-WRITER on the first entry's layer is the coarse
                    ;; gate; the handler then checks write access on EVERY
                    ;; distinct layer, which the single-id middleware can't.
                    :middleware [[pra/wrap-vocab-writer-required bulk-get-layer-id]
                                 metadata/wrap-inline-metadata-shape-guard]
                    :parameters {:body [:sequential
                                        [:map
                                         [:vocab-layer-id :uuid]
                                         [:form string?]
                                         [:metadata {:optional true} [:map-of string? any?]]]]}
                    :handler (fn [{{items :body} :parameters db :db user-id :user/id}]
                               (let [layer-ids (->> items (map :vocab-layer-id) distinct)
                                     unwritable (remove #(user-can-write-vocab-layer? db % user-id) layer-ids)]
                                 (if (seq unwritable)
                                   {:status 403
                                    :body {:error (str "User " user-id " lacks write access to vocab layer(s) " (vec unwritable))}}
                                   (let [attrs-vec (mapv (fn [{:keys [vocab-layer-id form metadata]}]
                                                           (cond-> {:vocab-item/layer vocab-layer-id
                                                                    :vocab-item/form form}
                                                             metadata (assoc :metadata metadata)))
                                                         items)
                                         result (vocab-item/bulk-create db attrs-vec user-id)]
                                     (if (:success result)
                                       {:status 201 :body {:ids (:extra result)}}
                                       {:status (or (:code result) 500)
                                        :body {:error (:error result)}})))))}
             :delete {:summary "Delete multiple vocab items in a single operation. Provide an array of IDs. Each item's descendant vocab links are deleted too."
                      :middleware [[pra/wrap-vocab-writer-required bulk-get-layer-id-from-item]]
                      :parameters {:body [:sequential :uuid]}
                      :handler (fn [{{ids :body} :parameters db :db user-id :user/id}]
                                 (let [layer-ids (vocab-item/get-layer-ids db ids)
                                       unwritable (remove #(user-can-write-vocab-layer? db % user-id) layer-ids)]
                                   (if (seq unwritable)
                                     {:status 403
                                      :body {:error (str "User " user-id " lacks write access to vocab layer(s) " (vec unwritable))}}
                                     (let [{:keys [success code error]} (vocab-item/bulk-delete db ids user-id)]
                                       (if success
                                         {:status 204}
                                         {:status (or code 500)
                                          :body {:error (or error "Internal server error")}})))))}}]

   ["/:id"
    {:conflicting true
     :parameters {:path [:map [:id :uuid]]}
     :get {:summary "Get a vocab item by ID"
           :middleware [[pra/wrap-vocab-reader-required get-vocab-id-from-item]]
           :handler (fn [{{{:keys [id]} :path} :parameters
                          db :db :as req}]
                      (let [vi (vocab-item/get db id)]
                        (if vi
                          {:status 200
                           :body vi}
                          {:status 404
                           :body {:error "Vocab item not found"}})))}

     :patch {:summary "Update a vocab item's form"
             :middleware [[pra/wrap-vocab-writer-required get-vocab-id-from-item]]
             :parameters {:body [:map [:form string?]]}
             :handler (fn [{{{:keys [id]} :path {:keys [form]} :body} :parameters
                            db :db
                            user-id :user/id :as req}]
                        (let [result (vocab-item/merge db id {:vocab-item/form form} user-id)]
                          (if (:success result)
                            {:status 200
                             :body (vocab-item/get db id)}
                            {:status (or (:code result) 500)
                             :body {:error (:error result)}})))}

     :delete {:summary "Delete a vocab item"
              :middleware [[pra/wrap-vocab-writer-required get-vocab-id-from-item]]
              :handler (fn [{{{:keys [id]} :path} :parameters
                             db :db
                             user-id :user/id :as req}]
                         (let [{:keys [success code error]} (vocab-item/delete db id user-id)]
                           (if success
                             {:status 204}
                             {:status (or code 500)
                              :body {:error (or error "Internal server error")}})))}}]

   ;; Metadata operations
   ["/:id/metadata"
    {:parameters {:path [:map [:id :uuid]]}
     :put {:summary "Replace all metadata for a vocab item. The entire metadata map is replaced - existing metadata keys not included in the request will be removed."
           :middleware [[pra/wrap-vocab-writer-required get-vocab-id-from-item]
                        metadata/wrap-metadata-shape-guard]
           :parameters {:body [:map-of string? any?]}
           :handler (fn [{{path-params :path metadata :body} :parameters db :db user-id :user/id}]
                      (let [item-id (:id path-params)
                            {:keys [success code error]} (vocab-item/set-metadata db item-id metadata user-id)]
                        (if success
                          {:status 200 :body (vocab-item/get db item-id)}
                          {:status (or code 500) :body {:error (or error "Internal server error")}})))}

     :patch {:summary "Patch (shallow-merge) metadata for a vocab item. Keys present in the request are set or overwritten; keys NOT present are left untouched; a key whose value is null is deleted. Merging is top-level only (nested objects are replaced wholesale, not deep-merged), so a literal null cannot be stored as a value. An empty body changes no metadata."
             :middleware [[pra/wrap-vocab-writer-required get-vocab-id-from-item]
                          metadata/wrap-metadata-shape-guard]
             :parameters {:body [:map-of string? any?]}
             :handler (fn [{{path-params :path metadata :body} :parameters db :db user-id :user/id}]
                        (let [item-id (:id path-params)
                              {:keys [success code error]} (vocab-item/patch-metadata db item-id metadata user-id)]
                          (if success
                            {:status 200 :body (vocab-item/get db item-id)}
                            {:status (or code 500) :body {:error (or error "Internal server error")}})))}

     :delete {:summary "Remove all metadata from a vocab item."
              :middleware [[pra/wrap-vocab-writer-required get-vocab-id-from-item]]
              :handler (fn [{{path-params :path} :parameters db :db user-id :user/id}]
                         (let [item-id (:id path-params)
                               {:keys [success code error]} (vocab-item/delete-metadata db item-id user-id)]
                           (if success
                             {:status 200 :body (vocab-item/get db item-id)}
                             {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]])
