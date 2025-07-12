(ns plaid.rest-api.v1.batch
  (:require [clojure.string :as str]
            [clojure.edn :as edn]
            [ring.util.io :as ring-io]
            [muuntaja.core :as m]
            [plaid.xtdb.operation :as op]
            [taoensso.timbre :as log]))

(defn parse-path-and-query
  "Parse a path like '/api/v1/projects?foo=bar' into uri and query-string"
  [path]
  (let [[uri query] (str/split path #"\?" 2)]
    {:uri uri
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
  "Build a Ring request map from a batch operation spec and the original request"
  [original-request operation]
  (let [{:keys [uri query-string]} (parse-path-and-query (:path operation))
        method (keyword (.toLowerCase (:method operation)))
        headers (merge (select-keys (:headers original-request)
                                    ["authorization" "accept"])
                       (when (:body operation)
                         {"content-type" "application/json"}))]
    (merge
     {:request-method method
      :uri uri
      :scheme (:scheme original-request)
      :server-name (:server-name original-request)
      :server-port (:server-port original-request)
      :headers headers
       ;; Preserve important context from original request
      :rest-handler (:rest-handler original-request)
      :xtdb (:xtdb original-request)
      :db (:db original-request)
      :jwt-data (:jwt-data original-request)
      :secret-key (:secret-key original-request)}
     (when query-string
       {:query-string query-string})
     (when-let [body (:body operation)]
       {:body-params body}))))

(defn process-batch-operation
  "Process a single batch operation through the rest handler"
  [rest-handler original-request operation]
  (try
    ;; Set dynamic binding to indicate we're in batch context
    (binding [op/*in-batch-context* true]
      (let [request (construct-request original-request operation)
            response (rest-handler request)
            content-type (get-in response [:headers "Content-Type"] "")]
        (update response :body #(decode-response-body % content-type))))
    (catch Exception e
      {:status 500
       :headers {}
       :body {:error (.getMessage e)}})))

(defn atomic-batch-handler
  "Execute multiple API operations atomically - if any operation fails with status >= 300,
   all changes are rolled back and no audit entries are created."
  [{:keys [rest-handler parameters xtdb] :as request}]
  (let [batch-id (random-uuid)
        operations (:body parameters)
        start-tx-id (atom nil)]
    (try
      ;; 1. Request permission to start batch using async coordination
      (log/debug "Requesting batch start for batch" batch-id)
      (let [response (op/request-batch-start! batch-id)]
        (case (:status response)
          :proceed (log/debug "Batch" batch-id "permission granted")
          :error (throw (ex-info (:message response) {:code 423 :batch-id batch-id}))
          :timeout (throw (ex-info "Timeout waiting for operations to complete"
                                   {:code 408 :batch-id batch-id}))))

      ;; 2. Record starting transaction ID for potential rollback
      (reset! start-tx-id (op/current-tx-id xtdb))
      (log/debug "Starting batch" batch-id "from transaction ID" @start-tx-id)

      ;; 3. Create batch progress marker for crash recovery
      (op/write-batch-marker! xtdb batch-id @start-tx-id)
      (log/debug "Created batch progress marker for batch" batch-id)

      ;; 4. Process operations sequentially until failure
      (loop [remaining-ops operations
             responses []]
        (if (empty? remaining-ops)
          ;; Success - all operations completed without error
          (do
            (log/info "Batch" batch-id "completed successfully with" (count responses) "operations")
            {:status 200 :body responses})

          ;; Process next operation
          (let [operation (first remaining-ops)
                response (process-batch-operation rest-handler request operation)
                status (:status response)]

            (log/debug "Batch" batch-id "operation" (:method operation) (:path operation)
                       "returned status" status)

            (if (>= status 300)
              ;; Failure - rollback all changes made during this batch
              (do
                (log/warn "Batch" batch-id "failed on operation" (:method operation) (:path operation)
                          "with status" status ". Rolling back...")

                ;; Rollback all transactions committed since batch started
                (op/rollback-batch! xtdb @start-tx-id)

                (log/info "Batch" batch-id "rollback completed")

                ;; Return the error response from the failed operation
                {:status status
                 :body (:body response)})

              ;; Success - continue processing
              (recur (rest remaining-ops)
                     (conj responses response))))))

      (catch Exception e
        ;; Unexpected error during batch processing
        (log/error e "Unexpected error in batch" batch-id)
        (when @start-tx-id
          (log/info "Rolling back batch" batch-id "due to unexpected error")
          (op/rollback-batch! xtdb @start-tx-id))
        {:status 500
         :body {:error (.getMessage e)}})

      (finally
        ;; Always signal batch completion and clean up progress marker
        (log/debug "Signaling batch completion for batch" batch-id)
        (op/signal-batch-complete!)
        ;; Clean up batch progress marker 
        (when @start-tx-id
          (try
            (op/delete-batch-marker! xtdb batch-id)
            (log/debug "Deleted batch progress marker for batch" batch-id)
            (catch Exception e
              (log/warn e "Failed to delete batch progress marker for batch" batch-id))))))))

(defn batch-handler
  "Legacy non-atomic batch handler - processes operations sequentially but without rollback"
  [{:keys [rest-handler parameters] :as request}]
  (let [operations (:body parameters)
        responses (mapv #(process-batch-operation rest-handler request %) operations)]
    {:status 200
     :body responses}))

(def batch-routes
  ["/batch"
   {:post {:summary (str "Execute multiple API operations one after the other. "
                         "If any operation fails (status >= 300), all changes are rolled back. "
                         "Atomicity is guaranteed. "
                         "On success, returns an array of each response associated with each submitted request in the batch. "
                         "On failure, returns a single response map with the first failing response in the batch. ")
           :openapi {:x-client-bundle "batch"
                     :x-client-method "submit"}
           :parameters {:body [:sequential
                               [:map
                                [:path string?]
                                [:method [:enum "get" "GET" "post" "POST" "put" "PUT" "patch" "PATCH" "delete" "DELETE"]]
                                [:body {:optional true} any?]]]}
           :handler atomic-batch-handler}}])