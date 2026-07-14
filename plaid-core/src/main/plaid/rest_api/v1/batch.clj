(ns plaid.rest-api.v1.batch
  (:require [clojure.string :as str]
            [clojure.edn :as edn]
            [clojure.data.json :as json]
            [muuntaja.core :as m]
            [next.jdbc :as jdbc]
            [plaid.sql.common :as psc]
            [plaid.sql.operation :as op]
            [taoensso.timbre :as log])
  (:import [java.sql SQLException]))

(def ^:private max-batch-ops
  "Hard cap on operations per atomic batch. Picked so an honest client
  has plenty of headroom while a runaway/buggy/malicious client can't
  serialize the whole DB on a single transaction or hold a write lock
  for an unbounded amount of time."
  1000)

(defn- sqlite-busy?
  "Inspect a SQLException to decide whether it's a SQLITE_BUSY /
  SQLITE_LOCKED contention failure. Mirrors the detection idiom in
  `plaid.sql.operation/submit-operation*` — we check the extended
  result code (5/6) when available, then fall back to substring
  matches on the message (the driver subclass sometimes shadows
  getResultCode)."
  [^SQLException e]
  (let [msg (or (.getMessage e) "")
        result-code (when (instance? org.sqlite.SQLiteException e)
                      (try (.code (.getResultCode ^org.sqlite.SQLiteException e))
                           (catch Throwable _ nil)))]
    (or (= 5 result-code)
        (= 6 result-code)
        (str/includes? msg "SQLITE_BUSY")
        (str/includes? msg "SQLITE_LOCKED")
        (str/includes? msg "database is locked"))))

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
      (str/includes? content-type "application/edn") (edn/read-string {:readers *data-readers*} body-str)
      :else body-str)))

(defn construct-request
  "Build a Ring request map from a batch operation spec. Note that :db is
  swapped from the original DataSource to the active tx Connection: the
  sub-handlers' submit-operation! calls detect the in-tx Connection and
  run their bodies INLINE in the outer batch tx (with-tx*; there are no
  savepoints). The load-bearing consequence: any sub-op failure throws
  out of the loop and rolls back the ENTIRE batch, so a half-executed
  sub-op body can never persist."
  [original-request operation tx]
  (let [{:keys [uri query-string]} (parse-path-and-query (:path operation))
        method (keyword (str/lower-case (:method operation)))
        headers (merge (select-keys (:headers original-request) ["authorization" "accept"])
                       (when (:body operation) {"content-type" "application/json"}))]
    (cond-> {:request-method method
             :uri uri
             :scheme (:scheme original-request)
             :server-name (:server-name original-request)
             :server-port (:server-port original-request)
             :headers headers
             :rest-handler (:rest-handler original-request)
             :db tx                                  ; CRITICAL: the tx connection, not the DS
             :jwt-data (:jwt-data original-request)
             :secret-key (:secret-key original-request)}
      query-string (assoc :query-string query-string)
      (:body operation) (assoc :body-params (:body operation)))))

(defn process-batch-operation
  "Process a single batch operation through the rest handler, using the
  given tx connection as the :db."
  [rest-handler original-request operation tx]
  (try
    (let [request (construct-request original-request operation tx)
          response (rest-handler request)
          content-type (get-in response [:headers "Content-Type"] "")]
      (update response :body #(decode-response-body % content-type)))
    (catch Exception e
      ;; Don't leak raw exception text (might include SQL, internal
      ;; paths, etc.) to API clients. Log it server-side so we can
      ;; still diagnose.
      (log/error e "Sub-op threw")
      {:status 500 :headers {} :body {:error "Internal error"}})))

(defn- merge-document-versions
  "Merge X-Document-Versions headers across a sequence of sub-responses.
   Each header is a JSON object `{doc-id integer}`; produce a single map
   keyed by doc-id with the LATEST version (last-write-wins) since
   sub-responses are processed in order and the final committed version
   reflects all sub-writes."
  [responses]
  (reduce (fn [acc response]
            (if-let [h (get-in response [:headers "X-Document-Versions"])]
              (try
                (merge acc (json/read-str h))
                (catch Exception e
                  (log/warn e "Failed to parse X-Document-Versions header in sub-response")
                  acc))
              acc))
          {}
          responses))

(defn atomic-batch-handler
  "Execute multiple API operations atomically. All sub-requests run inside a
  single JDBC transaction; any sub-request returning status >= 300 causes
  the transaction to roll back and the failing response is returned to the
  caller."
  [{:keys [rest-handler parameters db] :as request}]
  (let [batch-id (random-uuid)
        raw-ops (:body parameters)]
    (if (> (count raw-ops) max-batch-ops)
      {:status 400
       :body {:error (str "Batch exceeds max of " max-batch-ops
                          " operations (received " (count raw-ops) ")")}}
      (let [operations raw-ops
            ;; Sub-ops' audit events buffer here instead of publishing —
            ;; while the outer tx is open, an event would announce a
            ;; write listeners can't read back (and that may roll back
            ;; entirely). Flushed below AFTER commit; a throw out of
            ;; with-transaction simply discards the buffer.
            deferred-events (atom [])]
        (try
          (let [result
                (jdbc/with-transaction [tx db]
                  (binding [op/*current-batch-id* batch-id
                            op/*deferred-events* deferred-events
                            psc/*batch-validated-document-versions* (atom {})]
                    (loop [remaining operations responses []]
                      (if (empty? remaining)
                        ;; The access-log line already covers this HTTP request;
                        ;; the per-batch op count is granular detail, so debug.
                        (do (log/debug "Batch" batch-id "ok with" (count responses) "ops")
                            ;; Collect the union of all sub-responses' X-Document-Versions
                            ;; headers (last-write-wins per doc-id) and surface them on
                            ;; the outer batch response so OCC state isn't silently lost
                            ;; for batch writes.
                            (let [merged (merge-document-versions responses)
                                  outer {:status 200 :body responses}]
                              (if (seq merged)
                                (assoc outer :headers {"X-Document-Versions" (json/write-str merged)})
                                outer)))
                        (let [op-spec (first remaining)
                              response (process-batch-operation rest-handler request op-spec tx)
                              status (:status response)]
                          (if (>= status 300)
                            (do (log/warn "Batch" batch-id "failed; rolling back via throw")
                                ;; throwing rolls back the tx; we catch outside and return the failure
                                (throw (ex-info "batch-failed"
                                                {:plaid.batch/failure {:status status :body (:body response)}})))
                            (recur (rest remaining) (conj responses response))))))))]
            ;; The outer tx is committed once with-transaction returns.
            ;; Publish the sub-ops' buffered audit events now — listeners
            ;; that refetch on receipt see committed state. Defensive
            ;; try/catch: the commit is durable, nothing post-commit may
            ;; invert success into a 5xx.
            (try
              (op/flush-deferred-events! @deferred-events)
              (catch Throwable t
                (log/warn t "post-commit batch event flush failed:" (ex-message t))))
            result)
          (catch clojure.lang.ExceptionInfo e
            (if-let [f (:plaid.batch/failure (ex-data e))]
              {:status (:status f) :body (:body f)}
              (do (log/error e "Unexpected batch error" batch-id)
                  {:status 500 :body {:error "Internal error"}})))
          ;; Outer SQLException catch — BEGIN IMMEDIATE can fail at tx
          ;; acquisition before any sub-op runs (SQLITE_BUSY after the
          ;; configured busy_timeout). Surface that as 503 so clients
          ;; can retry, instead of a generic 500 that looks like a bug.
          ;; MUST precede the generic Exception catch.
          (catch SQLException e
            (if (sqlite-busy? e)
              (do (log/warn e "Batch" batch-id "could not acquire write lock (busy/locked)")
                  {:status 503 :body {:error "Database busy, please retry"}})
              (do (log/error e "Unexpected batch SQL error" batch-id)
                  {:status 500 :body {:error "Internal error"}})))
          (catch Exception e
            (log/error e "Unexpected batch error" batch-id)
            {:status 500 :body {:error "Internal error"}}))))))

(def batch-routes
  ["/batch"
   {:post {:summary (str "Execute multiple API operations one after the other. "
                         "If any operation fails (status >= 300), all changes are rolled back. "
                         "Atomicity is guaranteed. "
                         "On success, returns an array of each response associated with each submitted request in the batch. "
                         "On failure, returns a single response map with the first failing response in the batch. ")
           :parameters {:body [:sequential
                               [:map
                                [:path string?]
                                [:method [:enum "get" "GET" "post" "POST" "put" "PUT" "patch" "PATCH" "delete" "DELETE"]]
                                [:body {:optional true} any?]]]}
           :handler atomic-batch-handler}}])
