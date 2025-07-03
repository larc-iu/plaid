(ns plaid.rest-api.v1.middleware
  (:require [clojure.instant :as instant]
            [plaid.xtdb.document :as doc]
            [taoensso.timbre :as log]
            [xtdb.api :as xt]
            [clojure.string :as str]
            [clojure.data.json :as json]))

(defn assoc-document-versions-in-header [response {:keys [success document-versions]}]
  (-> response
      (cond-> (and success (seq document-versions))
              (assoc-in [:headers "X-Document-Versions"] document-versions))))

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
  "Enriches the request object with :db, which will hold either the current or an historical state of the database."
  [handler]
  (fn [request]
    (let [as-of (get-in request [:parameters :as-of])
          db (if as-of
               (xt/db (:xtdb request) (instant/read-instant-date as-of))
               (xt/db (:xtdb request)))]

      (cond
        ;; Need to forbid as-of with requests which are not GETs because of how they could be used to circumvent
        ;; the current state of a user's permissions: if currently lacks privileges they had in the past, they could
        ;; use an as-of to make the permissions check happen in the past. It's a little annoying to deal with this
        ;; later on in the implementation of permissions checking, so we will just reject any write with an as-of.
        (and as-of (not= (:request-method request) :get))
        {:status 400 :body {:error "as-of query parameter is only allowed with GETs"}}

        as-of
        (handler (assoc request :db (xt/db (:xtdb request) (instant/read-instant-date as-of))))

        :else
        (handler (assoc request :db db))))))

(defn wrap-document-version
  "Middleware that validates document version to prevent concurrent modifications.
  Takes a ->document-id function that extracts the document ID from the request.
  For non-GET requests with a document-version query parameter, ensures the 
  provided version matches the latest audit ID for that document."
  [handler ->document-id]
  (fn [request]
    (let [method (:request-method request)
          document-version (get-in request [:parameters :query :document-version])
          db (:db request)]

      (if (and document-version
               (not= method :get))
        (if-let [doc-id (->document-id request)]
          (let [latest-version (:document/version (doc/get db doc-id))]
            (if (not= latest-version document-version)
              {:status 409
               :body {:error "Document version mismatch. The document has been modified since you last fetched it."}}
              (handler request)))
          {:status 400 :body {:error "document-version was provided but no document was found with the provided version."}})
        (handler request)))))
