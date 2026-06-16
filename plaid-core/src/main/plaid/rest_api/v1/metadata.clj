(ns plaid.rest-api.v1.metadata
  "Shared metadata REST API routes for different entity types"
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.middleware :as prm]
            [clojure.data.json :as json]
            [reitit.coercion.malli]))

(def ^:private max-metadata-depth
  "Maximum nesting level allowed in a metadata payload. 10 is plenty
  for any structured metadata a real user would author; deeper than
  that and we start worrying about pathological JSON aimed at exhausting
  stack/serializer time."
  10)
(def ^:private max-metadata-key-count
  "Soft cap on the total number of keys (across all nesting levels) in
  a single metadata payload. Stops an unbounded `{k1:..,k2:..,...}`
  blob from monopolizing the audit/serialization pipeline."
  500)
(def ^:private max-metadata-string-length
  "Soft cap on individual string-value length, in characters."
  (* 10 1024))
(def ^:private max-metadata-total-bytes
  "Cumulative cap on the JSON-serialized size of a single metadata
  payload (#118). Stops an attacker from stitching together many
  small-but-numerous values that individually pass the per-key/per-
  string limits yet collectively monopolize audit/serialization. 1 MB
  is generous for any realistic structured metadata blob."
  (* 1024 1024))

(defn- safe-json-byte-count
  "Approximate the wire-bytes a value will take when JSON-encoded.
  Used by the cumulative-bytes cap. If encoding fails (e.g. a value
  with no JSON representation reaches us here), fall back to its
  printed length so a hostile payload can't dodge the cap by including
  a serialization-bomb value — better to over-count than to silently
  short-circuit the check."
  [v]
  (try
    (count (json/write-str v))
    (catch Exception _
      (count (pr-str v)))))

(defn validate-metadata-shape!
  "Walk `m` (a metadata map or nested value) and return either nil if
  it satisfies our shape caps, or a humane error string. Cumulative
  key-count and total-byte counters are tracked via atoms so an
  attacker can't split a single oversize blob into many smaller
  maps/values to dodge the limit.

  Public so route handlers that accept inline `:metadata` (POST /spans,
  POST /tokens, etc.) can call it before submitting the operation,
  not just the dedicated /metadata routes wrapped by
  `wrap-metadata-shape-guard`. See task #110."
  [m]
  (let [key-count (atom 0)
        total-bytes (atom 0)
        err (atom nil)
        check (fn check [v depth]
                (cond
                  @err nil
                  (> depth max-metadata-depth)
                  (reset! err (str "Metadata exceeds max depth of " max-metadata-depth))

                  (map? v)
                  (do (swap! key-count + (count v))
                      (when (> @key-count max-metadata-key-count)
                        (reset! err (str "Metadata exceeds max key count of "
                                         max-metadata-key-count)))
                      (when-not @err
                        (doseq [[_ vv] v :while (nil? @err)]
                          (check vv (inc depth)))))

                  (sequential? v)
                  (doseq [vv v :while (nil? @err)]
                    (check vv (inc depth)))

                  (and (string? v) (> (count v) max-metadata-string-length))
                  (reset! err (str "Metadata string value exceeds max length of "
                                   max-metadata-string-length " characters"))

                  :else nil))]
    (check m 0)
    ;; Cumulative-bytes pass: cheaper to encode once at the root than to
    ;; thread a byte counter through every walk above (and equivalent for
    ;; the JSON shapes we accept — maps/vectors/strings/scalars).
    (when-not @err
      (reset! total-bytes (safe-json-byte-count m))
      (when (> @total-bytes max-metadata-total-bytes)
        (reset! err (str "Metadata exceeds max total size of "
                         max-metadata-total-bytes " bytes"))))
    @err))

(defn validate-inline-metadata!
  "Check a request body that may carry an inline `:metadata` key (POST
  /spans, POST /tokens, bulk variants thereof, …). Returns a 400 response
  map if any embedded metadata violates the shape caps, or nil if every
  metadata payload is OK. Tolerates body shapes that are either a single
  map with a `:metadata` key or a sequence of such maps."
  [body]
  (let [check-one (fn [m]
                    (when-let [md (and (map? m) (:metadata m))]
                      (validate-metadata-shape! md)))
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
     entity-patch-metadata-fn - Function to shallow-merge a metadata patch into the entity

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
    :patch  {:summary    (str "Patch (shallow-merge) metadata for a " entity-type ". Keys present "
                              "in the request are set or overwritten; keys NOT present are left "
                              "untouched; a key whose value is null is deleted. Merging is "
                              "top-level only (nested objects are replaced wholesale, not "
                              "deep-merged), so a literal null cannot be stored as a value. An "
                              "empty body changes no metadata.")
             :middleware [[pra/wrap-writer-required get-project-id-fn]
                          [prm/wrap-document-version get-document-id-fn]
                          wrap-metadata-shape-guard]
             :parameters {:query [:map [:document-version {:optional true} :int]]
                          :body [:map-of string? any?]}
             :handler    (fn [{{path-params :path metadata :body} :parameters db :db user-id :user/id :as request}]
                           (let [entity-id (get path-params entity-id-key)
                                 doc-id (get-document-id-fn request)
                                 {:keys [success code error]} (entity-patch-metadata-fn db entity-id metadata user-id)]
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
