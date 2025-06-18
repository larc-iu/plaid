(ns plaid.rest-api.v1.metadata
  "Shared metadata REST API routes for different entity types"
  (:require [plaid.rest-api.v1.auth :as pra]
            [reitit.coercion.malli]))

(defn metadata-routes
  "Generate metadata routes for a given entity type.
   
   Args:
     entity-type - The entity type string (e.g. 'span', 'relation', 'token', 'text')
     entity-id-key - The path parameter key for entity ID (e.g. :span-id, :relation-id)
     get-project-id-fn - Function to get project ID for authorization
     entity-get-fn - Function to get the entity after metadata operations
     entity-set-metadata-fn - Function to set metadata on the entity
     entity-delete-metadata-fn - Function to delete metadata from the entity
   
   Returns:
     Vector of route definitions for metadata operations"
  [entity-type entity-id-key get-project-id-fn entity-get-fn entity-set-metadata-fn entity-delete-metadata-fn]
  
  ["/metadata" 
   {:put    {:summary    (str "Replace all metadata for a " entity-type ". The entire metadata map is replaced - existing metadata keys not included in the request will be removed.")
             :middleware [[pra/wrap-writer-required get-project-id-fn]]
             :openapi    {:x-client-method "set-metadata"}
             :parameters {:body [:map-of string? any?]}
             :handler    (fn [{{path-params :path metadata :body} :parameters xtdb :xtdb user-id :user/id}]
                           (let [entity-id (get path-params entity-id-key)
                                 {:keys [success code error]} (entity-set-metadata-fn {:node xtdb} entity-id metadata user-id)]
                             (if success
                               {:status 200 :body (entity-get-fn xtdb entity-id)}
                               {:status (or code 500) :body {:error (or error "Internal server error")}})))}
    :delete {:summary    (str "Remove all metadata from a " entity-type ".")
             :middleware [[pra/wrap-writer-required get-project-id-fn]]
             :openapi    {:x-client-method "delete-metadata"}
             :handler    (fn [{{path-params :path} :parameters xtdb :xtdb user-id :user/id}]
                           (let [entity-id (get path-params entity-id-key)
                                 {:keys [success code error]} (entity-delete-metadata-fn {:node xtdb} entity-id user-id)]
                             (if success
                               {:status 200 :body (entity-get-fn xtdb entity-id)}
                               {:status (or code 500) :body {:error (or error "Internal server error")}})))}}])