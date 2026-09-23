(ns plaid.rest-api.v1.metadata
  "Shared metadata REST API routes for different entity types"
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.middleware :as prm]
            [plaid.sql.metadata :as psm]
            [reitit.coercion.malli]))

(def max-metadata-depth
  "Maximum nesting level allowed in a metadata payload."
  psm/max-metadata-depth)

(def max-metadata-key-count
  "Soft cap on the total number of keys in one metadata map."
  psm/max-metadata-key-count)

(def max-metadata-string-length
  "Soft cap on individual string-value length, in characters."
  psm/max-metadata-string-length)

(def max-metadata-total-bytes
  "Cumulative cap on the JSON-serialized size of one metadata map."
  psm/max-metadata-total-bytes)

(def validate-metadata-shape!
  "Public so route handlers that accept inline `:metadata` can call it.
  See `plaid.sql.metadata/validate-metadata-shape!`."
  psm/validate-metadata-shape!)

(defn validate-inline-metadata!
  "Check a request body that may carry an inline `:metadata` key (POST
  /spans, POST /tokens, bulk variants thereof, …). Returns a 400 response
  map if any embedded metadata violates the shape caps, or nil if every
  metadata payload is OK. Tolerates body shapes that are either a single
  map with a `:metadata` key or a sequence of such maps."
  [body]
  (let [check-one (fn [m]
                    ;; A bulk update entry's metadata is a list of ops, whose
                    ;; result `patch-metadata!` checks against the same caps.
                    (when-let [md (and (map? m) (:metadata m))]
                      (when-not (sequential? md)
                        (validate-metadata-shape! md))))
        errs (cond
               (sequential? body) (keep check-one body)
               (map? body) (when-let [e (check-one body)] [e])
               :else nil)
        err (first errs)]
    (when err
      {:status 400 :body {:error err}})))

(defn wrap-inline-metadata-shape-guard
  "Middleware wrapper around `validate-inline-metadata!` for use on routes
  that accept inline `:metadata` in their body. Distinct from
  `wrap-metadata-shape-guard` (which targets the dedicated /metadata
  routes whose entire body IS the metadata map)."
  [handler]
  (fn [request]
    (let [body (get-in request [:parameters :body])]
      (or (validate-inline-metadata! body)
          (handler request)))))

(defn wrap-metadata-shape-guard
  "Reject metadata payloads that exceed the depth/key-count/string-length
  caps. Runs after malli has materialized `:body`, so we can walk a
  real Clojure data structure rather than re-parsing bytes."
  [handler]
  (fn [request]
    (let [body (get-in request [:parameters :body])]
      (if-let [err (and (some? body) (validate-metadata-shape! body))]
        {:status 400 :body {:error err}}
        (handler request)))))

(def metadata-op-schema
  "One metadata edit. See `plaid.sql.metadata/patch-metadata!`."
  [:map
   [:op [:enum "set" "delete"]]
   [:path [:vector {:min 1} string?]]
   [:value {:optional true} any?]])

(def metadata-ops-schema
  "The body of a metadata PATCH, and the `metadata` of a bulk update entry."
  [:sequential metadata-op-schema])

(def patch-summary
  "The shared tail of every metadata PATCH summary."
  (str "with a list of ops applied in order, in one operation. Each op has keys:\n"
       "<body>op</body>, \"set\" or \"delete\"\n"
       "<body>path</body>, a non-empty array of keys into the nested metadata, the first a top-level key\n"
       "<body>value</body>, for set, the value to write (null is an ordinary value)\n"
       "set writes the value at the path, creating any missing objects along it, so a path of one key "
       "replaces that top-level key whole. delete removes the key at the path and is a no-op when it is "
       "absent. A path that runs through a value that is not an object is refused (400). An empty list "
       "changes nothing."))

(defn metadata-routes
  "Generate metadata routes for a given entity type.

   Args:
     entity-type - The entity type string (e.g. 'span', 'relation', 'token', 'text')
     entity-id-key - The path parameter key for entity ID (e.g. :span-id, :relation-id)
     get-project-id-fn - Function to get project ID for authorization
     get-document-id-fn - Function to get document ID
     entity-get-fn - Function to get the entity after metadata operations
     entity-set-metadata-fn - Function to set (replace all) metadata on the entity
     entity-delete-metadata-fn - Function to delete metadata from the entity
     entity-patch-metadata-fn - Function to apply a list of metadata ops to the entity

   Returns:
     Vector of route definitions for metadata operations"
  [entity-type entity-id-key get-project-id-fn get-document-id-fn entity-get-fn entity-set-metadata-fn entity-delete-metadata-fn entity-patch-metadata-fn]

  ["/metadata"
   {:put    {:summary    (str "Replace all metadata for a " entity-type ". The entire metadata map is replaced - existing metadata keys not included in the request will be removed.")
             :middleware [[pra/wrap-writer-required get-project-id-fn]
                          [prm/wrap-document-version get-document-id-fn]
                          wrap-metadata-shape-guard]
             :parameters {:query [:map [:document-version {:optional true} :int]]
                          :body [:map-of string? any?]}
             :handler    (fn [{{path-params :path metadata :body} :parameters db :db user-id :user/id :as request}]
                           (let [entity-id (get path-params entity-id-key)
                                 doc-id (get-document-id-fn request)
                                 {:keys [success code error]} (entity-set-metadata-fn db entity-id metadata user-id)]
                             (if success
                               (prm/assoc-document-version-in-header
                                {:status 200 :body (entity-get-fn db entity-id)}
                                db doc-id)
                               {:status (or code 500) :body {:error (or error "Internal server error")}})))}
    ;; No shape guard here: the caps apply to the metadata the ops build,
    ;; which `patch-metadata!` checks, not to the op list itself.
    :patch  {:summary    (str "Edit metadata for a " entity-type " " patch-summary)
             :middleware [[pra/wrap-writer-required get-project-id-fn]
                          [prm/wrap-document-version get-document-id-fn]]
             :parameters {:query [:map [:document-version {:optional true} :int]]
                          :body metadata-ops-schema}
             :handler    (fn [{{path-params :path ops :body} :parameters db :db user-id :user/id :as request}]
                           (let [entity-id (get path-params entity-id-key)
                                 doc-id (get-document-id-fn request)
                                 {:keys [success code error]} (entity-patch-metadata-fn db entity-id ops user-id)]
                             (if success
                               (prm/assoc-document-version-in-header
                                {:status 200 :body (entity-get-fn db entity-id)}
                                db doc-id)
                               {:status (or code 500) :body {:error (or error "Internal server error")}})))}
    :delete {:summary (str "Remove all metadata from a " entity-type ".")
             :middleware [[pra/wrap-writer-required get-project-id-fn]
                          [prm/wrap-document-version get-document-id-fn]]
             :parameters {:query [:map [:document-version {:optional true} :int]]}
             :handler (fn [{{path-params :path} :parameters db :db user-id :user/id :as request}]
                        (let [entity-id (get path-params entity-id-key)
                              doc-id (get-document-id-fn request)
                              {:keys [success code error]} (entity-delete-metadata-fn db entity-id user-id)]
                          (if success
                            (prm/assoc-document-version-in-header
                             {:status 200 :body (entity-get-fn db entity-id)}
                             db doc-id)
                            {:status (or code 500) :body {:error (or error "Internal server error")}})))}}])
