(ns plaid.rest-api.v1.bulk
  (:require [clojure.string :as str]
            [clojure.edn :as edn]
            [ring.util.io :as ring-io]
            [muuntaja.core :as m]))

(defn parse-path-and-query
  "Parse a path like '/api/v1/projects?foo=bar' into uri and query-string"
  [path]
  (let [[uri query] (str/split path #"\?" 2)]
    {:uri          uri
     :query-string query}))

(defn decode-response-body
  "Decode response body based on content type"
  [body content-type]
  (let [body-str (cond
                   (instance? java.io.InputStream body) (slurp body)
                   (nil? body) nil
                   :else (str body))]
    (cond
      (or (nil? body-str) (empty? body-str)) nil
      (str/includes? content-type "application/json") (m/decode "application/json" body-str)
      (str/includes? content-type "application/edn") (edn/read-string body-str)
      :else body-str)))

(defn construct-request
  "Build a Ring request map from a bulk operation spec and the original request"
  [original-request operation]
  (let [{:keys [uri query-string]} (parse-path-and-query (:path operation))
        method (keyword (.toLowerCase (:method operation)))
        headers (merge (select-keys (:headers original-request)
                                    ["authorization" "accept"])
                       (when (:body operation)
                         {"content-type" "application/json"}))]
    (merge
      {:request-method method
       :uri            uri
       :scheme         (:scheme original-request)
       :server-name    (:server-name original-request)
       :server-port    (:server-port original-request)
       :headers        headers
       ;; Preserve important context from original request
       :rest-handler   (:rest-handler original-request)
       :xtdb           (:xtdb original-request)
       :db             (:db original-request)
       :jwt-data       (:jwt-data original-request)
       :secret-key     (:secret-key original-request)}
      (when query-string
        {:query-string query-string})
      (when-let [body (:body operation)]
        {:body-params body}))))

(defn process-bulk-operation
  "Process a single bulk operation through the rest handler"
  [rest-handler original-request operation]
  (try
    (let [request (construct-request original-request operation)
          response (rest-handler request)
          content-type (get-in response [:headers "Content-Type"] "")]
      (update response :body #(decode-response-body % content-type)))
    (catch Exception e
      {:status  500
       :headers {}
       :body    {:error (.getMessage e)}})))

(defn bulk-handler
  [{:keys [rest-handler parameters body-params] :as request}]
  (let [operations (:body parameters)
        responses (mapv #(process-bulk-operation rest-handler request %) operations)]
    {:status 200
     :body   responses}))

(def bulk-routes
  ["/bulk"
   {:post {:summary    (str "Execute multiple API operations in a single request.")
           :openapi    {:x-client-bundle "bulk"
                        :x-client-method "submit"}
           :parameters {:body [:sequential
                               [:map
                                [:path string?]
                                [:method [:enum "get" "GET" "post" "POST" "put" "PUT" "patch" "PATCH" "delete" "DELETE"]]
                                [:body {:optional true} any?]]]}
           :responses  {200 {:description "Array of responses for each operation"}}
           :handler    bulk-handler}}])