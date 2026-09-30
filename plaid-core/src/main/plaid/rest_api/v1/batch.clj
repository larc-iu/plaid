(ns plaid.rest-api.v1.batch
  (:require [clojure.string :as str]
            [clojure.edn :as edn]
            [clojure.data.json :as json]
            [muuntaja.core :as m]
            [next.jdbc :as jdbc]
            [plaid.server.log-buffer :as log-buffer]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.constraints.layer :as lc]
            [plaid.sql.datasource :as psd]
            [plaid.sql.operation :as op]
            [taoensso.timbre :as log])
  (:import [java.sql SQLException]))

(def max-batch-ops
  "Hard cap on operations per atomic batch. Picked so an honest client
  has plenty of headroom while a runaway/buggy/malicious client can't
  serialize the whole DB on a single transaction or hold a write lock
  for an unbounded amount of time."
  1000)

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
             :remote-addr (:remote-addr original-request)
             :headers headers
             :rest-handler (:rest-handler original-request)
             ;; One batch is one request in the access log: its sub-ops are
             ;; logged at debug and kept out of the request buffer, which a
             ;; thousand of them would otherwise empty. See
             ;; `log-buffer/sub-request-key`.
             log-buffer/sub-request-key true
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

;; ============================================================
;; References to an earlier operation's new id
;;
;; A create and the write that uses what it created (an entry and the link
;; to it, a word and its gloss) belong in one transaction, so a refusal of
;; the second cannot leave the first behind. The second cannot know the id
;; the first will get, so the operation lists, beside its body, where that
;; id goes: `"refs": [{"at": ["vocab-item"], "op": 0}]` puts the id
;; operation 0 of this batch answered (counted from 0) at that path of the
;; body, and `{"at": [...], "op": n, "index": k}` the k-th of the `ids` a
;; bulk create answered. A path is a list of object keys and list indexes,
;; and must lead to a null the client left there. The body itself is never
;; searched, so user data of any shape is stored as it was sent.
;; ============================================================

(defn- refusal
  "Throw out of the batch loop with a 400, which rolls the batch back."
  [msg]
  (throw (ex-info "batch-failed" {:plaid.batch/failure {:status 400 :body {:error msg}}})))

(defn- resolve-ref
  "The id `{:op n :index k}` stands for, given the responses of the
  operations before this one, `responses`."
  [{n :op k :index} responses]
  (when-not (and (int? n) (<= 0 n) (< n (count responses)))
    (refusal (str "\"op\": " (pr-str n) " in a ref must name an operation before this one, counted from 0")))
  (when-not (or (nil? k) (and (int? k) (<= 0 k)))
    (refusal (str "\"index\" in a ref must be a whole number, not " (pr-str k))))
  (let [body (:body (nth responses n))
        field (fn [key] (or (get body key) (get body (name key))))]
    (if (nil? k)
      (or (when (map? body) (field :id))
          (refusal (str "Operation " n " answered no id for a ref to stand for")))
      (let [ids (when (map? body) (field :ids))]
        (if (and (sequential? ids) (< k (count ids)))
          (nth ids k)
          (refusal (str "Operation " n " answered no id at index " k)))))))

(defn- ref-keys
  "The `get-in` keys of the path `at` in `body`, or nil unless it leads to a
  null. A JSON key arrives as a keyword (the API's JSON decoder), an index
  as a number."
  [body at]
  (loop [node body path at ks []]
    (let [[step & more] path
          k (cond (and (string? step) (map? node)) (keyword nil step)
                  (and (int? step) (vector? node) (< -1 step (count node))) step)]
      (cond
        (or (nil? k) (and (map? node) (not (contains? node k)))) nil
        (empty? more) (when (nil? (get node k)) (conj ks k))
        :else (recur (get node k) more (conj ks k))))))

(defn resolve-refs
  "`op-spec`'s body with the id each of its `refs` stands for put at that
  ref's path, given the responses of the operations before it."
  [{:keys [body refs]} responses]
  (let [n (count responses)]
    (when-not (sequential? refs)
      (refusal (str "\"refs\" of operation " n " must be a list")))
    (reduce (fn [body {:keys [at] :as ref}]
              (when-not (and (map? ref) (sequential? at) (seq at))
                (refusal (str "A ref of operation " n " must be {\"at\": [...], \"op\": n}, with a path in \"at\"")))
              (let [ks (or (ref-keys body at)
                           (refusal (str "A ref of operation " n " names " (json/write-str at)
                                         ", which is not a null in its body")))]
                (assoc-in body ks (str (resolve-ref ref responses)))))
            body
            refs)))

;; A document lock lives in memory, outside the database, so a rollback
;; cannot take back a lock a batch took or gave up: a batch that took one and
;; then failed would keep it with no work behind it. So the lock routes are
;; refused inside a batch, before it runs. Reading a lock is fine.
(def ^:private lock-path
  #"^/api/v1/(?:documents/[^/]+/lock|admin/locks(?:/[^/]+)?)$")

(defn lock-operation-refusal
  "The 400 for a batch with an operation that takes, renews or releases a
  document lock, or nil. Checked before the batch runs, so nothing is
  written."
  [operations]
  (some (fn [[n {:keys [path method]}]]
          (when (and (re-find lock-path (:uri (parse-path-and-query path)))
                     (not= "get" (str/lower-case method)))
            {:status 400
             :body {:error (str "Operation " n " takes or releases a document lock, "
                                "which a batch cannot do. Send it on its own.")}}))
        (map-indexed vector operations)))

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

(def ^:dynamic *pending-key*
  "Bound by `plaid.rest-api.v1.idempotency/wrap-idempotency-key` around a
  `/batch` request that carries an Idempotency-Key, to
  {:check (fn [tx]) :store! (fn [tx response])}. The batch's own
  transaction runs both, so the key is looked up again under the write lock
  and stored with the writes, never in a transaction of its own."
  nil)

(defn- busy-or-500
  [e what]
  (if (psd/sqlite-busy? e)
    (do (log/warn e what "could not acquire write lock (busy/locked)")
        {:status 503 :body {:error "Database busy, please retry"}})
    (do (log/error e "Unexpected error in" what)
        {:status 500 :body {:error "Internal error"}})))

(defn with-atomic-tx
  "Run `(f tx)` in one write transaction and answer the response it returns.
  A response with a status of 300 or more rolls every write back and is
  answered as it is. While `f` runs, audit events and file work wait for the
  commit (`op/*deferred-events*`, `op/*deferred-files*`), every operation row
  carries one batch id, and a document's claimed version is checked once
  (`psaw/*batch-validated-document-versions*`). After the commit the events
  are published and the file work runs. A write lock that cannot be taken
  answers 503. `f` may also refuse by throwing
  `{:plaid.batch/failure response}`.

  The transaction shell of `/batch`, and of a single write sent with an
  Idempotency-Key, whose stored answer must commit with it."
  [db f]
  (let [batch-id (random-uuid)
        ;; While the tx is open an event would announce a write listeners
        ;; cannot read back yet, and that may still roll back. Flushed below
        ;; after the commit, dropped with the buffer on a throw.
        deferred-events (atom [])
        ;; A file a write deletes is not brought back by a rollback, so the
        ;; work waits here for the commit too.
        deferred-files (atom [])]
    (try
      (let [result
            ;; psd/with-tx* rather than jdbc/with-transaction directly: it
            ;; opens and closes the transaction in SQL, so the write lock is
            ;; taken once and a commit never answers for anything but its
            ;; own work. See plaid.sql.datasource/with-tx*.
            (psd/with-tx [tx db]
              (binding [op/*current-batch-id* batch-id
                        op/*deferred-events* deferred-events
                        op/*deferred-files* deferred-files
                        psaw/*batch-validated-document-versions* (atom {})]
                (let [response (f tx)]
                  (when (>= (:status response) 300)
                    (log/debug "Transaction" batch-id "refused with" (:status response) ", rolling back")
                    (throw (ex-info "batch-failed" {:plaid.batch/failure response})))
                  response)))]
        ;; Committed. Nothing after this may turn success into a 5xx.
        (try
          (op/flush-deferred-events! @deferred-events)
          (catch Throwable t
            (log/warn t "post-commit event flush failed:" (ex-message t))))
        (op/run-deferred-files! @deferred-files)
        result)
      (catch clojure.lang.ExceptionInfo e
        (if-let [failure (:plaid.batch/failure (ex-data e))]
          failure
          (busy-or-500 e (str "transaction " batch-id))))
      ;; BEGIN IMMEDIATE can fail before anything runs (SQLITE_BUSY after
      ;; busy_timeout), a retryable 503, not a 500.
      (catch SQLException e
        (busy-or-500 e (str "transaction " batch-id)))
      (catch Exception e
        (busy-or-500 e (str "transaction " batch-id))))))

(defn- run-operations
  "Run the batch's operations in order on `tx` and answer the batch's
  response, or throw the first refusal."
  [request operations tx]
  (loop [remaining operations responses []]
    (if (empty? remaining)
      ;; Collect the union of all sub-responses' X-Document-Versions headers
      ;; (last-write-wins per doc-id) and surface them on the outer batch
      ;; response so OCC state isn't silently lost for batch writes.
      (let [merged (merge-document-versions responses)
            outer {:status 200 :body responses}]
        (if (seq merged)
          (assoc outer :headers {"X-Document-Versions" (json/write-str merged)})
          outer))
      (let [spec (first remaining)
            op-spec (if (contains? spec :refs)
                      (assoc spec :body (resolve-refs spec responses))
                      spec)
            response (process-batch-operation (:rest-handler request) request op-spec tx)
            status (:status response)]
        (if (>= status 300)
          (throw (ex-info "batch-failed"
                          {:plaid.batch/failure {:status status :body (:body response)}}))
          (recur (rest remaining) (conj responses response)))))))

(defn atomic-batch-handler
  "Execute multiple API operations atomically. All sub-requests run inside a
  single JDBC transaction; any sub-request returning status >= 300 causes
  the transaction to roll back and the failing response is returned to the
  caller."
  [{:keys [parameters db] :as request}]
  (let [raw-ops (:body parameters)]
    (if-let [refused (if (> (count raw-ops) max-batch-ops)
                       {:status 400
                        :body {:error (str "Batch exceeds max of " max-batch-ops
                                           " operations (received " (count raw-ops) ")")}}
                       (lock-operation-refusal raw-ops))]
      refused
      (let [pending *pending-key*]
        (with-atomic-tx
          db
          (fn [tx]
            (or (when pending ((:check pending) tx))
                (let [response (binding [*pending-key* nil]
                                 ;; Layer constraints, checked once after
                                 ;; the last operation.
                                 (lc/check-batch! tx (:user/id request)
                                                  #(run-operations request raw-ops tx)))]
                  (when pending ((:store! pending) tx response))
                  response))))))))

(def batch-routes
  ["/batch"
   {:plaid/idempotency :batch
    :post {:summary (str "Execute multiple API operations one after the other. "
                         "If any operation fails (status >= 300), all changes are rolled back. "
                         "Atomicity is guaranteed. "
                         "On success, returns an array of each response associated with each submitted request in the batch. "
                         "On failure, returns a single response map with the first failing response in the batch. "
                         "An operation's refs, [{\"at\": [key or index, ...], \"op\": n}], put the id operation n of the batch "
                         "(counted from 0) answered with at each path of its body, where the body holds null, and "
                         "{\"at\": [...], \"op\": n, \"index\": k} the k-th of the ids a bulk create answered with, "
                         "so a write can use what an earlier write in the same batch created. The body is never searched. "
                         "Taking, renewing or releasing a document lock is not an operation a batch can hold, and refuses the batch with a 400.")
           :parameters {:body [:sequential
                               [:map
                                [:path string?]
                                [:method [:enum "get" "GET" "post" "POST" "put" "PUT" "patch" "PATCH" "delete" "DELETE"]]
                                [:body {:optional true} any?]
                                [:refs {:optional true} any?]]]}
           :handler atomic-batch-handler}}])
