(ns plaid.rest-api.v1.middleware
  (:require [clojure.instant :as instant]
            [plaid.xtdb2.document :as doc]
            [plaid.xtdb2.operation :as op]
            [taoensso.timbre :as log]
            [clojure.string :as str]
            [clojure.data.json :as json]))

(defn assoc-document-versions-in-header [response {:keys [success document-versions]}]
  (-> response
      (cond-> (and success (seq document-versions))
        (assoc-in [:headers "X-Document-Versions"] (json/write-str document-versions)))))

(defn wrap-request-extras [handler xtdb secret-key]
  (fn [request]
    (handler (-> request
                 (assoc :xtdb xtdb)
                 (assoc :secret-key secret-key)))))

(defn wrap-logging [handler]
  (fn [request]
    (let [req-id (hash request)
          uri (:uri request)
          skip? (or (= uri "/api/v1/openapi.json")
                    (str/starts-with? uri "/api/v1/docs"))]
      (when-not skip?
        (log/debug (str "Received request " req-id ": "
                        (select-keys request [:remote-addr :user/id :form-params :parameters :scheme :request-method :uri]))))
      (let [response (handler request)]
        (when-not skip?
          (log/debug (str "Sending response to request " req-id ": " response)))
        response))))

(defn wrap-as-of-db
  "Enriches the request with :xt-map containing the node and optional :snapshot-time for as-of reads."
  [handler]
  (fn [request]
    (let [as-of  (get-in request [:parameters :query :as-of])
          xtdb   (:xtdb request)
          xt-map (cond-> {:node xtdb}
                   as-of (assoc :snapshot-time (java.time.Instant/parse as-of)))]
      (cond
        ;; Forbid as-of on non-GET requests to prevent permission circumvention
        (and as-of (not= (:request-method request) :get))
        {:status 400 :body {:error "as-of query parameter is only allowed with GETs"}}

        :else
        (handler (assoc request :xt-map xt-map))))))

(defn wrap-document-version
  "Middleware that validates document version to prevent concurrent modifications.
  Takes a ->document-id function that extracts the document ID from the request.
  For non-GET requests with a document-version query parameter, ensures the 
  provided version matches the latest audit ID for that document."
  [handler ->document-id]
  (fn [request]
    (let [method (:request-method request)
          document-version (get-in request [:parameters :query :document-version])]

      (if (and document-version
               (not= method :get))
        (if-let [doc-id (->document-id request)]
          (let [xt-map (or (:xt-map request) {:node (:xtdb request)})
                latest-version (:document/version (doc/get xt-map doc-id))]
            (if (not= latest-version document-version)
              {:status 409
               :body {:error "Document version mismatch. The document has been modified since you last fetched it."}}
              (handler request)))
          {:status 400 :body {:error "document-version was provided but no document was found with the provided version."}})
        (handler request)))))

(defn wrap-user-agent
  "Middleware that captures the X-Agent-Name header and binds it to the *user-agent* dynamic var"
  [handler]
  (fn [request]
    (let [user-agent (get-in request [:headers "x-agent-name"])]
      (binding [op/*user-agent* user-agent]
        (handler request)))))
