(ns plaid.rest-api.v1.middleware
  (:require [plaid.sql.common :as psc]
            [plaid.sql.document :as doc]
            [plaid.sql.operation :as op]
            [taoensso.timbre :as log]
            [clojure.string :as str]
            [clojure.data.json :as json])
  (:import (java.time Instant)
           (java.time.format DateTimeParseException)))

(defn wrap-malformed-json-400
  "Map a request-body decode failure (muuntaja/Jackson can't parse the
  JSON) to HTTP 400 instead of letting it fall through to the ring
  default handler's opaque 500.

  The trigger we hit in practice: a supplementary-plane (\"astral\") char
  in a JSON object KEY — the standard client's
  `json.dumps(ensure_ascii=True)` emits it as an escaped surrogate pair,
  which Jackson's field-name decoder rejects. That's malformed CLIENT
  input → 400, not a server fault.

  Placement matters: this MUST sit OUTSIDE `format-request-middleware`
  (so it catches that middleware's `:muuntaja/decode` throw) but INSIDE
  `format-response-middleware` (so the 400 map we return still gets
  encoded to JSON). See the middleware vector in
  `plaid.rest-api.v1.core/rest-handler`. reitit's own
  `exception-middleware` is intentionally disabled there, so nothing else
  catches this."
  [handler]
  (fn [request]
    (try
      (handler request)
      (catch Exception e
        (if (= :muuntaja/decode (:type (ex-data e)))
          {:status 400 :body {:error (or (ex-message e) "Malformed request body.")}}
          (throw e))))))

(defn assoc-document-version-in-header
  "Set X-Document-Versions on the response. Matches the v2 header name +
  shape (JSON map of doc-id → version), but version is now the integer
  `documents.version` column instead of the v2 audit-id UUID. Same code
  path on the client; only the value type changes."
  [response db doc-id]
  (if (and doc-id (>= (:status response) 200) (< (:status response) 300))
    (if-let [v (:document/version (doc/get db doc-id))]
      (assoc-in response [:headers "X-Document-Versions"]
                (json/write-str {doc-id v}))
      response)
    response))

(defn wrap-request-extras
  "Inject `:db` (the HikariCP DataSource) and `:secret-key` onto every request.
  The atomic batch handler passes through sub-requests with `:db` already set
  to a tx-Connection; preserve that override so sub-handlers share the batch's
  transaction instead of opening fresh ones against the pool."
  [handler db secret-key]
  (fn [request]
    (handler (-> request
                 (update :db #(or % db))
                 (assoc :secret-key secret-key)))))

(defn- method-name [m]
  (some-> m name str/upper-case))

(def ^:private sensitive-name-tokens
  "Lowercased local-name suffixes whose values must be redacted from
  any request/response shape before it lands in a debug log line. We
  match by `(name k)` (case-folded) rather than literal key identity
  so namespaced variants like `:user/password`, `:plaid.auth/token`
  and `:secret-key` (injected onto every request by
  `wrap-request-extras`) all hit. Prior to #116 the matcher used a
  literal set, so namespaced keys leaked through."
  #{"password" "token" "authorization" "secret-key"})

(defn- redact-key?
  "True if key `k` should have its value replaced with <redacted>.
  Accepts keywords, strings, and symbols. Matches on the local name
  (case-insensitive) so namespaces don't smuggle a sensitive field
  past the check."
  [k]
  (when k
    (let [n (cond
              (keyword? k) (name k)
              (symbol? k) (name k)
              (string? k) k
              :else (str k))]
      (contains? sensitive-name-tokens (str/lower-case n)))))

(defn redact-sensitive
  "Walk a request/response shape and replace sensitive values with the
  string \"<redacted>\". Recurses through maps and any seqable values
  (vectors, lists, sets) but leaves scalars untouched."
  [x]
  (cond
    (map? x)
    (reduce-kv (fn [acc k v]
                 (assoc acc k (if (redact-key? k)
                                "<redacted>"
                                (redact-sensitive v))))
               {}
               x)
    (vector? x) (mapv redact-sensitive x)
    (set? x) (set (map redact-sensitive x))
    (seq? x) (doall (map redact-sensitive x))
    :else x))

(defn wrap-logging [handler]
  (fn [request]
    (let [req-id (hash request)
          uri (:uri request)
          ;; /health is served by an outer middleware and won't normally
          ;; reach this point, but include it in the skip set so a future
          ;; reorder doesn't surprise us with health-check spam.
          skip? (or (= uri "/api/v1/openapi.json")
                    (= uri "/health")
                    (str/starts-with? uri "/api/v1/docs"))
          start (System/currentTimeMillis)]
      (when-not skip?
        (log/debug (str "Received request " req-id ": "
                        (redact-sensitive
                         (select-keys request
                                      [:remote-addr :user/id :form-params
                                       :parameters :scheme :request-method :uri])))))
      ;; try/finally so the INFO access log fires even if the handler
      ;; throws. On exception we log the exception class in place of a
      ;; numeric status — better than the request silently disappearing
      ;; from the access log.
      (let [response (volatile! nil)
            thrown   (volatile! nil)]
        (try
          (vreset! response (handler request))
          (catch Throwable t
            (vreset! thrown t))
          (finally
            (let [elapsed (- (System/currentTimeMillis) start)
                  status (cond
                           @thrown (str ":throw " (.getName (class @thrown)))
                           (some? @response) (:status @response)
                           :else "???")]
              (when-not skip?
                (log/info (str (method-name (:request-method request))
                               " " uri
                               " " status
                               " " elapsed "ms"))
                (when @response
                  (log/debug (str "Sending response to request " req-id ": "
                                  (redact-sensitive @response))))))))
        (if @thrown
          (throw @thrown)
          @response)))))

(defn- percent-decode-preserving-plus
  "URL-decode `s` (turn `%3A` → `:`, `%2B` → `+`, etc.) while leaving a
  LITERAL `+` as `+` rather than form-decoding it to a space. ISO-8601
  instants never contain spaces, but their timezone offsets contain `+`
  (e.g. `2026-05-28T09:00:00+00:00`); a client that sends that `+`
  un-percent-encoded must not have it collapsed to a space. We protect
  literal `+` by escaping it to `%2B` before handing the string to
  `URLDecoder` (which would otherwise treat `+` as space). Malformed
  `%`-sequences make `URLDecoder` throw — we fall back to the raw string
  so the caller's `Instant/parse` produces the 400 instead of a 500."
  [^String s]
  (try
    (java.net.URLDecoder/decode (str/replace s "+" "%2B") "UTF-8")
    (catch IllegalArgumentException _ s)))

(defn- raw-as-of-param
  "Pull the `as-of=` value out of the request's query string, or nil if
  absent. Operates on the raw query string because `:as-of` is not
  declared in OpenAPI schemas, so malli would otherwise strip it before
  middleware sees it. The value is percent-decoded (preserving literal
  `+` in timezone offsets) since well-behaved HTTP clients percent-encode
  the `:` separators of an ISO-8601 instant (`%3A`)."
  [request]
  (when-let [qs (:query-string request)]
    (some (fn [^String p]
            ;; Case-insensitive on the param NAME so `As-Of=`/`AS-OF=`
            ;; aren't silently ignored (which would serve CURRENT state
            ;; for a request that asked for a snapshot).
            (let [eq (.indexOf p "=")]
              (when (and (pos? eq)
                         (= "as-of" (str/lower-case (subs p 0 eq))))
                (percent-decode-preserving-plus (subs p (inc eq))))))
          (str/split qs #"&"))))

(defn wrap-reject-as-of
  "Reject `?as-of=` with 400. Applied to every non-document route —
  as-of reconstruction is document-scoped, so a time-travel query
  against `/projects`, `/users`, `/audit-log`, etc. has no defined
  semantics.

  Document GETs replace this with `wrap-route-as-of` (see below)."
  [handler]
  (fn [request]
    (if (some? (raw-as-of-param request))
      {:status 400
       :body {:error "as-of query parameter is not supported on this endpoint. Time travel is only available on document GETs."}}
      (handler request))))

(def ^:private bare-doc-get-path-regex
  ;; `?as-of=` is only meaningful on the top-level doc GET
  ;; (`/api/v1/documents/<uuid>`). Sub-routes (`/lock`, `/media`,
  ;; `/metadata/...`) read non-bitemporal state (filesystem media,
  ;; in-memory locks, or — for metadata — handlers wired only against
  ;; the OLTP `:db`). Injecting `:as-of-ts` for them would silently
  ;; serve CURRENT state instead of state at `ts`, so we reject 400
  ;; rather than mislead the caller. The trailing-`/?` tolerates the
  ;; one-trailing-slash case some proxies emit.
  #"/api/v1/documents/[0-9a-fA-F-]{36}/?")

(defn wrap-route-as-of
  "Document-route variant of as-of handling. When `?as-of=<ISO-8601>`
  is present on the top-level document GET, parse it and inject
  `:as-of-ts` on the request; downstream handlers then serve the read
  from the audit log (`plaid.history.read`) instead of current OLTP
  state.

  Always available: the audit log lives in the same database the write
  committed to, so there is no replica to enable, lag behind, or stall
  — the old 425/staleness and 503-disabled contracts are gone.

  `?as-of=` on a doc SUB-route (lock/media/metadata) is rejected with
  400 — those handlers read non-bitemporal state (filesystem media,
  in-memory locks, OLTP-wired metadata) and would silently serve
  current state, which is worse than failing loud.

  Error mapping:
   * malformed ISO-8601                     → 400
   * as-of on non-top-level doc route       → 400
   * non-GET/HEAD                           → 400
   * `:history/pruned` (T below the
     audit_retention marker)                → 400 + the marker ts
   * any other exception                    → 500 with a correlation id
     (logged; no message leaked to the client)"
  [handler]
  (fn [request]
    (if-let [raw (raw-as-of-param request)]
      (let [parsed (try (Instant/parse raw)
                        (catch DateTimeParseException _ ::parse-error))]
        (cond
          (= parsed ::parse-error)
          {:status 400
           :body {:error (str "Invalid as-of value (expected ISO-8601 instant, e.g. "
                              "2026-05-28T09:00:00Z): " raw)}}

          (not (re-matches bare-doc-get-path-regex (or (:uri request) "")))
          {:status 400
           :body {:error "as-of query parameter is not supported on this endpoint. Time travel is only available on the top-level document GET."}}

          ;; Only GET / HEAD read time-travel. HEAD is the canonical
          ;; "does this exist at T?" probe — ring strips the response
          ;; body, so it routes identically to GET here. Anything else
          ;; (PATCH/DELETE/POST/PUT/OPTIONS) is rejected: silently
          ;; passing `?as-of=` on a writer would have it hit OLTP while
          ;; appearing to operate at `ts` (a permission-bypass shape);
          ;; OPTIONS is CORS preflight and has no time-travel meaning.
          (not (contains? #{:get :head} (:request-method request)))
          {:status 400
           :body {:error "as-of query parameter is only allowed with GET or HEAD requests."}}

          :else
          ;; Single Throwable catch so unknown exceptions can't escape
          ;; this middleware and leak internals via the ring default
          ;; 500 handler. Type-route inside the catch body.
          (try
            (handler (assoc request :as-of-ts parsed))
            (catch Throwable t
              (let [d (when (instance? clojure.lang.ExceptionInfo t)
                        (ex-data t))]
                (if (= :history/pruned (:type d))
                  {:status 400
                   :body {:error "as-of timestamp predates pruned audit history"
                          :pruned-below-ts (:pruned-below-ts d)
                          :requested-ts (:requested-ts d)}}
                  (let [cid (format "as-of-%08x"
                                    (bit-and 0xFFFFFFFF
                                             (hash [(.getName (class t)) (.getMessage t)])))]
                    (log/error t (str "as-of read failed [" cid "] uri=" (:uri request)))
                    {:status 500
                     :body {:error "as-of read failed"
                            :correlation-id cid}})))))))
      (handler request))))

(def ^:private uuid-regex
  ;; canonical 8-4-4-4-12 hex UUID
  #"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

(defn- extract-raw-document-version
  "Pull the raw document-version value out of the request's query-string,
  if present. Operates on the raw string so we can intercept old-format
  v2 UUIDs BEFORE malli coercion converts the failure into its own
  generic 400."
  [request]
  (when-let [qs (:query-string request)]
    (some (fn [param]
            (when (str/starts-with? param "document-version=")
              (subs param (count "document-version="))))
          (str/split qs #"&"))))

(defn wrap-reject-uuid-document-version
  "Reject old-format `?document-version=<uuid>` with a clear 400 BEFORE
  malli's request-coercion gets a chance to convert the value-type error
  into a less-specific 400. v2 used audit-id UUIDs; the SQL port uses
  integer document versions. Silently dropping the OCC check (the v2-port
  bug) is dangerous, so we fail loudly."
  [handler]
  (fn [request]
    (let [raw (extract-raw-document-version request)]
      (if (and raw (re-matches uuid-regex raw))
        {:status 400
         :body {:error (str "Invalid document-version (expected integer; "
                            "v2 UUIDs are no longer supported)")}}
        (handler request)))))

(defn wrap-document-version
  "Optimistic-concurrency middleware. For non-GET requests carrying
  `document-version=<int>` in the query, BINDS the parsed integer to
  `plaid.sql.common/*expected-document-version*` so the authoritative
  check fires inside the write tx in `submit-operation*` — closing the
  TOCTOU window that existed when the middleware did the comparison
  before the handler opened its tx (task #108).

  In v2 this compared against the latest audit-id (an opaque UUID). The
  SQL port uses the integer `documents.version` column that
  `plaid.sql.document/merge` bumps on every change. v2-format UUIDs are
  rejected upstream by `wrap-reject-uuid-document-version`; any
  unparseable value reaching here is also rejected with a 400 rather
  than silently bypassing OCC.

  A pre-flight read still happens here as a fast-fail (avoids opening a
  tx when the version is already known to be stale from a stable read);
  the in-tx check inside `submit-operation*` is the authoritative one
  for racing writers."
  [handler ->document-id]
  (fn [request]
    (let [method (:request-method request)
          document-version (get-in request [:parameters :query :document-version])
          raw-version (extract-raw-document-version request)
          parsed-version (cond
                           (nil? document-version) nil
                           (integer? document-version) document-version
                           (string? document-version) (try (Long/parseLong document-version)
                                                           (catch Exception _ ::parse-error))
                           :else ::parse-error)]
      (cond
        ;; A document-version was given (raw query string carries it) but
        ;; malli/our parsing couldn't produce an integer. Fail loudly rather
        ;; than silently skipping the OCC check.
        (and (some? raw-version)
             (or (= parsed-version ::parse-error)
                 (and (nil? document-version) (seq raw-version))))
        {:status 400
         :body {:error (str "Invalid document-version (expected integer; "
                            "v2 UUIDs are no longer supported)")}}

        (and parsed-version (not= parsed-version ::parse-error) (not= method :get))
        (if-let [doc-id (->document-id request)]
          (let [latest-version (:document/version (doc/get (:db request) doc-id))]
            ;; Fast-fail pre-flight: bail with 409 if the visible version
            ;; is ALREADY ahead of the client. Not authoritative — a
            ;; racing writer can bump between this read and the in-tx
            ;; check — but it cheaply rejects obviously-stale requests
            ;; without opening a transaction. The authoritative check
            ;; runs in `submit-operation*` against the in-tx snapshot.
            (cond
              (and latest-version (not= latest-version parsed-version))
              {:status 409
               :body {:error "Document version mismatch. The document has been modified since you last fetched it."}}
              :else
              (binding [psc/*expected-document-version* parsed-version]
                (handler request))))
          {:status 400 :body {:error "document-version was provided but no document was found with the provided version."}})

        :else
        (handler request)))))

(defn wrap-api-token-id
  "Bind the request's validated API-token id (set by `wrap-read-jwt` from the
  `:token/id` JWT claim, nil for session logins) to
  `plaid.sql.operation/*token-id*` so it lands on the operations row. Must run
  INSIDE `wrap-read-jwt` — it depends on the `:api-token/id` that middleware
  assoc's onto the request."
  [handler]
  (fn [request]
    (binding [op/*token-id* (:api-token/id request)]
      (handler request))))
