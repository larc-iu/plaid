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

(defn metadata-route-data
  "The PUT, PATCH and DELETE route data for one entity type's metadata,
  written once for all seven.

   Options:
     :entity-type        the noun in the summaries, e.g. \"span\", \"vocab item\"
     :entity-id-key      the path parameter holding the entity's id
     :writer-middleware  the write-access gate, a reitit middleware entry
     :get-document-id-fn optional (fn [request]) -> the entity's document. When
                         given, each route takes ?document-version, checks it,
                         and returns the document's new version in a header.
                         Vocab items, which have no document, leave it out.
     :get-fn             (fn [db id]) -> the entity, returned after each write
     :set-fn             (fn [db id m user-id]), replace all metadata
     :patch-fn           (fn [db id ops user-id]), apply a list of ops
     :delete-fn          (fn [db id user-id]), remove all metadata"
  [{:keys [entity-type entity-id-key writer-middleware get-document-id-fn
           get-fn set-fn patch-fn delete-fn]}]
  (let [versioned? (some? get-document-id-fn)
        middleware (fn [& more]
                     (into (cond-> [writer-middleware]
                             versioned? (conj [prm/wrap-document-version get-document-id-fn]))
                           more))
        query (when versioned?
                {:query [:map [:document-version {:optional true} :int]]})
        ;; The document is looked up before the write. `write` is
        ;; (fn [db entity-id user-id]) and calls the entity's mutator.
        handle (fn [{{path-params :path} :parameters db :db user-id :user/id :as request} write]
                 (let [entity-id (get path-params entity-id-key)
                       doc-id (when versioned? (get-document-id-fn request))
                       {:keys [success code error]} (write db entity-id user-id)]
                   (if success
                     (cond-> {:status 200 :body (get-fn db entity-id)}
                       versioned? (prm/assoc-document-version-in-header db doc-id))
                     {:status (or code 500) :body {:error (or error "Internal server error")}})))]
    {:put    {:summary    (str "Replace all metadata for a " entity-type ". The entire metadata map is replaced - existing metadata keys not included in the request will be removed.")
              :middleware (middleware wrap-metadata-shape-guard)
              :parameters (merge query {:body [:map-of string? any?]})
              :handler    (fn [{{metadata :body} :parameters :as request}]
                            (handle request #(set-fn %1 %2 metadata %3)))}
     ;; No shape guard here: the caps apply to the metadata the ops build,
     ;; which `patch-metadata!` checks, not to the op list itself.
     :patch  {:summary    (str "Edit metadata for a " entity-type " " patch-summary)
              :middleware (middleware)
              :parameters (merge query {:body metadata-ops-schema})
              :handler    (fn [{{ops :body} :parameters :as request}]
                            (handle request #(patch-fn %1 %2 ops %3)))}
     :delete (cond-> {:summary    (str "Remove all metadata from a " entity-type ".")
                      :middleware (middleware)
                      :handler    (fn [request] (handle request delete-fn))}
               versioned? (assoc :parameters query))}))

(defn metadata-routes
  "The `/metadata` routes of a document-scoped entity, gated on project write
  access and on ?document-version. See `metadata-route-data`."
  [entity-type entity-id-key get-project-id-fn get-document-id-fn entity-get-fn entity-set-metadata-fn entity-delete-metadata-fn entity-patch-metadata-fn]
  ["/metadata"
   (metadata-route-data {:entity-type entity-type
                         :entity-id-key entity-id-key
                         :writer-middleware [pra/wrap-writer-required get-project-id-fn]
                         :get-document-id-fn get-document-id-fn
                         :get-fn entity-get-fn
                         :set-fn entity-set-metadata-fn
                         :patch-fn entity-patch-metadata-fn
                         :delete-fn entity-delete-metadata-fn})])
