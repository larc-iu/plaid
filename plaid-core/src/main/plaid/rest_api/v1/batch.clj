(ns plaid.rest-api.v1.batch
  (:require [clojure.string :as str]
            [clojure.edn :as edn]
            [clojure.data.json :as json]
            [muuntaja.core :as m]
            [next.jdbc :as jdbc]
            [plaid.history.core :as history]
            [plaid.sql.operation :as op]
            [plaid.sql.relation :as relation]
            [plaid.sql.span :as span]
            [plaid.sql.text :as text]
            [plaid.sql.token :as token]
            [plaid.sql.vocab-link :as vocab-link]
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

(defn extract-document-version
  "Extract document-version value from a query string, if present"
  [query-string]
  (when query-string
    (some (fn [param]
            (when (str/starts-with? param "document-version=")
              (subs param (count "document-version="))))
          (str/split query-string #"&"))))

(defn remove-document-version-from-query
  "Remove document-version parameter from a query string"
  [query-string]
  (if (nil? query-string)
    nil
    (let [params (str/split query-string #"&")
          filtered-params (remove #(str/starts-with? % "document-version=") params)]
      (when (seq filtered-params)
        (str/join "&" filtered-params)))))

(def ^:private uuid-regex
  ;; canonical 8-4-4-4-12 hex UUID (matches v1 path segments)
  #"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

(defn- parse-uuid-safe [s]
  (try (java.util.UUID/fromString s) (catch Exception _ nil)))

(defn- extract-entity-id
  "Pull the trailing entity UUID out of a sub-op URI like
  '/api/v1/spans/<UUID>' or '/api/v1/spans/<UUID>/tokens'. Returns nil if
  no UUID segment is present (e.g. a bare /api/v1/spans POST whose body
  carries the layer id but no entity id yet exists)."
  [uri]
  (let [segments (str/split uri #"/")
        uuid-segments (keep parse-uuid-safe segments)]
    (first uuid-segments)))

(defn resolve-doc-id
  "Best-effort: given a sub-op URI, return the document-id it operates on,
  or nil if it can't be resolved (e.g. POST /api/v1/spans whose body
  references a layer rather than an existing entity, or a path with no
  UUID segment at all). Used by `preprocess-batch-operations` to key
  the OCC dedupe map by [doc-id, version] rather than by bare version.

  Routes by URI prefix to the appropriate SQL lookup. Returns nil
  silently — callers must fall back to the original bare-version key in
  that case, since we'd rather over-dedupe (and let the in-tx OCC check
  catch it) than blow up the batch."
  [db uri]
  (when (and db uri)
    (try
      (let [eid (extract-entity-id uri)]
        (cond
          (nil? eid) nil

          (str/includes? uri "/documents/")
          eid

          (str/includes? uri "/texts/")
          (:text/document (text/get db eid))

          (str/includes? uri "/tokens/")
          (when-let [tok (token/get db eid)]
            (token/get-doc-id-of-text db (:token/text tok)))

          (str/includes? uri "/spans/")
          (when-let [sp (span/get db eid)]
            (span/get-doc-id-of-token db (first (:span/tokens sp))))

          (str/includes? uri "/relations/")
          (when-let [rel (relation/get db eid)]
            (relation/get-doc-id-of-span db (:relation/source rel)))

          (str/includes? uri "/vocab-links/")
          (when-let [vl (vocab-link/get db eid)]
            (when-let [tok-id (first (:vocab-link/tokens vl))]
              (vocab-link/document-id-from-token db tok-id)))

          :else nil))
      (catch Exception e
        (log/debug e "resolve-doc-id failed for" uri)
        nil))))

(defn preprocess-batch-operations
  "Remove duplicate (document-id, document-version) query parameters across
  all operations in the batch. Keeps only the first occurrence of each
  unique [doc-id, version] pair.

  Prior to task #109 the dedupe key was the bare version string, which
  silently stripped `?document-version=` from ops touching DIFFERENT
  documents that happened to share the same numeric version (the values
  collide trivially since every doc starts at version 1). That dropped
  OCC enforcement entirely for the second-and-later sub-op per
  collision. We now resolve a doc-id per op via `resolve-doc-id` and
  key the dedupe map on [doc-id, version].

  If a sub-op's doc-id can't be resolved (an unsynthesizable path, or
  a create whose entity-id doesn't exist yet), we keep its
  document-version intact and don't suppress any sibling — better to
  let the in-tx OCC check fire twice than to silently skip it."
  ([operations] (preprocess-batch-operations operations nil))
  ([operations db]
   (loop [remaining-ops operations
          seen-keys #{}
          result []]
     (if (empty? remaining-ops)
       result
       (let [operation (first remaining-ops)
             {:keys [uri query-string]} (parse-path-and-query (:path operation))
             doc-version (extract-document-version query-string)
             doc-id (when doc-version (resolve-doc-id db uri))
             ;; Only dedupe ops whose doc-id we could actually resolve.
             ;; Unresolved → keep as-is so the in-tx OCC check still fires.
             dedupe-key (when (and doc-version doc-id) [doc-id doc-version])]
         (if (and dedupe-key (contains? seen-keys dedupe-key))
           ;; Remove document-version from this operation since we've already
           ;; seen this exact (doc-id, version) pair earlier in the batch.
           (let [clean-query (remove-document-version-from-query query-string)
                 new-path (if clean-query
                            (str uri "?" clean-query)
                            uri)
                 updated-operation (assoc operation :path new-path)]
             (recur (rest remaining-ops)
                    seen-keys
                    (conj result updated-operation)))
           ;; Keep operation as-is and track its key if we have one.
           (recur (rest remaining-ops)
                  (if dedupe-key
                    (conj seen-keys dedupe-key)
                    seen-keys)
                  (conj result operation))))))))

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
      (let [operations (preprocess-batch-operations raw-ops db)
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
                            op/*deferred-events* deferred-events]
                    (loop [remaining operations responses []]
                      (if (empty? remaining)
                        (do (log/info "Batch" batch-id "ok with" (count responses) "ops")
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
            ;; that refetch on receipt see committed state — and nudge the
            ;; history tailer once (the per-sub-op nudges fired pre-commit
            ;; and found nothing, so without this the batch waits out the
            ;; tailer heartbeat). Defensive try/catch: the commit is
            ;; durable, nothing post-commit may invert success into a 5xx.
            (try
              (history/nudge!)
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
           :openapi {:x-client-bundle "batch"
                     :x-client-method "submit"}
           :parameters {:body [:sequential
                               [:map
                                [:path string?]
                                [:method [:enum "get" "GET" "post" "POST" "put" "PUT" "patch" "PATCH" "delete" "DELETE"]]
                                [:body {:optional true} any?]]]}
           :handler atomic-batch-handler}}])
