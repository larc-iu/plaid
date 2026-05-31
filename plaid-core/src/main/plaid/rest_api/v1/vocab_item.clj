(ns plaid.rest-api.v1.vocab-item
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.metadata :as metadata]
            [reitit.coercion.malli]
            [plaid.sql.vocab-item :as vocab-item]))

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

   ["/:id"
    {:parameters {:path [:map [:id :uuid]]}
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
           :middleware [[pra/wrap-vocab-writer-required get-vocab-id-from-item]]
           :openapi {:x-client-method "set-metadata"}
           :parameters {:body [:map-of string? any?]}
           :handler (fn [{{path-params :path metadata :body} :parameters db :db user-id :user/id}]
                      (let [item-id (:id path-params)
                            {:keys [success code error]} (vocab-item/set-metadata db item-id metadata user-id)]
                        (if success
                          {:status 200 :body (vocab-item/get db item-id)}
                          {:status (or code 500) :body {:error (or error "Internal server error")}})))}

     :delete {:summary "Remove all metadata from a vocab item."
              :middleware [[pra/wrap-vocab-writer-required get-vocab-id-from-item]]
              :openapi {:x-client-method "delete-metadata"}
              :handler (fn [{{path-params :path} :parameters db :db user-id :user/id}]
                         (let [item-id (:id path-params)
                               {:keys [success code error]} (vocab-item/delete-metadata db item-id user-id)]
                           (if success
                             {:status 200 :body (vocab-item/get db item-id)}
                             {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]])
