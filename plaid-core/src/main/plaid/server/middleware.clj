(ns plaid.server.middleware
  (:require [mount.core :as mount]
            [ring.middleware.defaults :refer [wrap-defaults]]
            [ring.middleware.cors :refer [wrap-cors]]
            [ring.util.response :as response]
            [ring.util.mime-type :as mime]
            [plaid.server.config :refer [config]]
            [plaid.server.sql :refer [datasource]]
            [plaid.sql.common :as psc]
            [plaid.rest-api.v1.core :refer [rest-handler]]
            [clojure.data.json :as json]
            [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [taoensso.timbre :as log])
  (:import (java.io File)
           (java.nio.file Files)
           (java.nio.file.attribute PosixFilePermission)
           (java.util EnumSet)))

;; Secret key handling
(defn generate-secret-key []
  (let [random-bytes (byte-array 32)]
    (.nextBytes (java.security.SecureRandom.) random-bytes)
    (str/join (map #(format "%02x" %) random-bytes))))

(defn- set-owner-only-perms!
  "Restrict a file to 0600 on POSIX systems. Silently no-ops on Windows
   or any filesystem that doesn't support POSIX permissions."
  [^File f]
  (try
    (Files/setPosixFilePermissions
     (.toPath f)
     (EnumSet/of PosixFilePermission/OWNER_READ
                 PosixFilePermission/OWNER_WRITE))
    (catch UnsupportedOperationException _
      ;; Windows / non-POSIX filesystem — best effort only.
      nil)
    (catch Exception e
      (log/warn e "Could not restrict permissions on" (.getPath f)))))

;; NOTE: Rotating the JWT secret (changing PLAID_JWT_SECRET or deleting
;; data/jwt-secret.txt and restarting) invalidates all currently-issued
;; JWTs — every signed-in user will need to log in again.
(defn load-or-generate-secret
  "Resolve a JWT secret, preferring the env var when set, falling back to
  a generated file under `db-dir`. `env-secret` is the value of the
  PLAID_JWT_SECRET env var (or nil). Pulled out of `ensure-secret-key-exists`
  so tests can drive it without needing to redefine System/getenv."
  [env-secret db-dir]
  (if (and env-secret (not (str/blank? env-secret)))
    (do (log/info "Using JWT secret from PLAID_JWT_SECRET env var")
        env-secret)
    (let [_ (.mkdirs (io/file db-dir))
          secret-path (str db-dir File/separator "jwt-secret.txt")
          secret-file (io/file secret-path)
          ;; Resolve to an absolute path so the log line is unambiguous when the
          ;; server is launched from a directory other than the deploy root.
          resolved-path (.getAbsolutePath secret-file)]
      (if (.exists secret-file)
        (do (log/info "Loaded JWT secret from" resolved-path)
            (slurp secret-file))
        (let [new-secret (generate-secret-key)]
          (spit secret-file new-secret)
          (set-owner-only-perms! secret-file)
          (log/info "Generated new JWT secret at" resolved-path)
          new-secret)))))

(defn ensure-secret-key-exists []
  (let [db-path (-> config :plaid.server.sql/config :main-db-path (or "data/plaid.db"))
        db-dir (or (some-> ^String db-path (File.) (.getParentFile) (.getPath)) "data")]
    (load-or-generate-secret (System/getenv "PLAID_JWT_SECRET") db-dir)))

(mount/defstate secret-key
  :start (ensure-secret-key-exists))

;; Process start instant; used by the /health endpoint to report uptime.
;; A defstate (not a defonce) so mount/start advances it on test restart,
;; matching production semantics where boot = first /health uptime = 0.
(mount/defstate start-time-ms
  :start (System/currentTimeMillis))

(def ^:private health-version
  "Version string surfaced by /health. Read from `version.edn` on the
  classpath, which the release workflow (.github/workflows/release.yml)
  writes into the jar from the git tag at build time. Absent in local /
  unreleased runs, where we report \"dev\"."
  (or (try
        (some-> (io/resource "version.edn")
                slurp
                (edn/read-string)
                :version)
        (catch Exception _ nil))
      "dev"))

(def ^:private bytes-per-mb
  "Binary MB (1024*1024). Reported as `store_size_mb` in /health."
  (* 1024 1024))

(defn- audit-block
  "Build the /health :audit block — disk visibility for the audit log,
   which effectively IS the database (98% of file size in practice) and
   is also the as-of read source. Cheap: one pragma pair + one count(*)
   (an index-only scan). Degrades to {:error ...} rather than tanking
   /health."
  [ds]
  (try
    (let [size-bytes (:bytes (psc/q1 ds ["SELECT page_count*page_size AS bytes
                                          FROM pragma_page_count(), pragma_page_size()"]))
          audit-rows (:n (psc/q1 ds ["SELECT count(*) AS n FROM audit_writes"]))]
      {:db_size_mb (long (Math/round (double (/ size-bytes bytes-per-mb))))
       :audit_rows audit-rows})
    (catch Throwable t
      (log/warn t "audit /health probe failed")
      {:error (or (.getMessage t) (.. t getClass getSimpleName))})))

(defn- health-body [ds]
  (let [base {:ok true
              :version health-version
              :uptime-ms (- (System/currentTimeMillis) start-time-ms)}]
    (assoc base :audit (audit-block ds))))

(defn- health-response
  ([] (health-response datasource))
  ([ds]
   {:status 200
    :headers {"Content-Type" "application/json"}
    :body (json/write-str (health-body ds))}))

(defn wrap-health
  "Serve GET /health (unauthenticated, unlogged) without going through the
  REST router. Anything else passes through."
  [handler]
  (fn [{:keys [uri request-method] :as req}]
    (if (and (= request-method :get) (= uri "/health"))
      (health-response)
      (handler req))))

;; Route handling
(defn wrap-rest-routes
  [handler db]
  (let [rest-handler (rest-handler db secret-key)]
    (fn [{:keys [uri] :as req}]
      (if (str/starts-with? uri "/api/v1/")
        (rest-handler req)
        (handler req)))))

(defn wrap-static-resources
  "Serves static files from a filesystem directory — ONLY when the
  operator explicitly configured [server] static_resources_path. This
  endpoint is unauthenticated by design (it fronts SPAs/assets), so the
  old cwd-relative \"resources\" default silently published whatever
  sat in ./resources — in a source checkout that's the config templates
  and the full schema migrations. The bundled-SPA classpath serving
  (/ud, /igt — see bundled-spa-roots) is separate and unaffected."
  [handler]
  (let [resources-path (-> config :plaid.server.middleware/static-resources-path)]
    (if resources-path
      (log/info (format "Serving static files from `%s/`" resources-path))
      (log/debug "No static_resources_path configured; filesystem static serving disabled"))
    (fn [{:keys [uri request-method] :as request}]
      (if (and resources-path
               (= :get request-method)
               (not (str/starts-with? uri "/api/"))
               (not (str/starts-with? uri "/_")))
        (let [file-path (subs uri 1)
              ;; If URI ends with /, try to serve index.html from that directory
              actual-path (if (or (= file-path "")
                                  (nil? file-path)
                                  (str/ends-with? file-path "/"))
                            (str file-path "index.html")
                            file-path)
              file (io/file resources-path actual-path)]
          (if (and (.exists file)
                   (.isFile file)
                   ;; Security: ensure the file is within our resources directory
                   (str/starts-with? (.getCanonicalPath file)
                                     (.getCanonicalPath (io/file resources-path))))
            (-> (response/file-response (.getPath file))
                (response/content-type (mime/ext-mime-type (.getName file))))
            (handler request)))
        (handler request)))))

(def ^:private bundled-spa-roots
  "URL prefix -> classpath resource root for each SPA bundled into the uberjar.
  The release workflow copies each app's Vite build (built with base `/ud/`,
  `/igt/`) into `resources/{ud,igt}/`, landing them on the classpath as
  `ud/**` / `igt/**`."
  {"/ud" "ud"
   "/igt" "igt"})

(defn- bundled-spa-resource-path
  "If `uri` targets a bundled SPA, return the classpath resource path to serve;
  else nil. A bare prefix or trailing slash maps to that app's index.html.
  Both apps use HashRouter, so client routes live in the URL fragment and never
  reach the server — no index.html fallback for unknown paths is needed."
  [uri]
  (when-not (str/includes? uri "..")
    (some (fn [[prefix root]]
            (cond
              (or (= uri prefix) (= uri (str prefix "/")))
              (str root "/index.html")

              (str/starts-with? uri (str prefix "/"))
              (str root (subs uri (count prefix)))))
          bundled-spa-roots)))

(defn wrap-bundled-spa
  "Serve the bundled SPAs (plaid-ud at /ud, plaid-igt at /igt) from the
  CLASSPATH so they work inside the distributed uberjar (where there is no
  filesystem `resources/` directory). Only serves real files; misses fall
  through to the next handler."
  [handler]
  (fn [{:keys [uri request-method] :as request}]
    (if-let [resource-path (and (= :get request-method)
                                (bundled-spa-resource-path uri))]
      (or (some-> (response/resource-response resource-path)
                  (response/content-type (mime/ext-mime-type resource-path)))
          (handler request))
      (handler request))))

(def ^:private root-landing-html
  "<!DOCTYPE html>
<html lang=\"en\">
<head>
  <meta charset=\"UTF-8\">
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
  <title>Plaid</title>
  <style>
    body { font-family: sans-serif; max-width: 480px; margin: 80px auto; padding: 0 1rem; }
    h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
    ul { list-style: none; padding: 0; }
    li { margin: 0.6rem 0; }
    a { font-size: 1.1rem; }
  </style>
</head>
<body>
  <h1>Plaid</h1>
  <ul>
    <li><a href=\"/ud/\">UD Editor</a></li>
    <li><a href=\"/igt/\">IGT Editor</a></li>
    <li><a href=\"/api/v1/docs/\">API Docs</a></li>
  </ul>
</body>
</html>")

(defn wrap-root-landing
  "Intercepts GET / and returns a minimal HTML page linking to the bundled
  apps and the API docs. All other requests fall through."
  [handler]
  (fn [{:keys [uri request-method] :as request}]
    (if (and (= :get request-method) (= "/" uri))
      {:status 200
       :headers {"Content-Type" "text/html; charset=utf-8"}
       :body root-landing-html}
      (handler request))))

(defn- ^java.util.regex.Pattern origin-string->exact-pattern
  "Build an anchored, regex-escaped pattern that matches `origin` EXACTLY
  (no metacharacter interpretation). Operators configure CORS allowlists
  with origin strings (e.g. \"https://app.example.com\"), not regexes;
  the older `re-pattern` path silently treated `.` as wildcard and was
  trivially over-permissive."
  [^String origin]
  (re-pattern (str "^" (java.util.regex.Pattern/quote origin) "$")))

;; ---------------------------------------------------------------------------
;; Task #118: per-content-type body cap
;;
;; http-kit's `:max-body` is a single per-connection number — every
;; inbound request is held to the same ceiling. We size that ceiling for
;; multipart media uploads (200MB default) so legitimate large binaries
;; can come through, then layer this middleware on top to enforce a
;; tighter limit for non-multipart JSON/EDN bodies. Without the split a
;; client could submit a 200MB JSON document that the body parser fully
;; materializes in memory.
;; ---------------------------------------------------------------------------

(def ^:private json-body-cap-headers
  {"Content-Type" "application/json"})

(defn- parse-long-header [s]
  (try (when s (Long/parseLong (str/trim s)))
       (catch NumberFormatException _ nil)))

(defn- json-content-type?
  "True iff the request's Content-Type is a non-multipart JSON-ish media
  type. Heuristic: anything that ISN'T multipart/form-data falls under
  the JSON cap. The actual handlers we care about (REST/EDN/JSON) all
  carry small structured bodies; the only legitimate large-body path is
  multipart media uploads, and those are explicitly excluded here."
  [content-type]
  (let [ct (or content-type "")]
    (and (not (str/blank? ct))
         (not (str/starts-with? (str/lower-case ct) "multipart/")))))

(defn wrap-json-body-cap
  "Reject non-multipart requests whose declared body size exceeds the
  configured JSON cap with a 413. The cap is the SMALLER of the two
  limits — see the task #118 note in http-server.clj for why http-kit's
  connection-level cap is sized for multipart instead.

  Only the Content-Length header is checked — chunked encodings without
  a declared length pass through and are still bounded by http-kit's
  outer cap. That's a deliberate trade-off: enforcing chunked-body caps
  would require consuming and counting bytes here, which would either
  duplicate the downstream body-reader work or break streaming
  handlers."
  [handler max-json-body-bytes]
  (fn [{:keys [headers] :as req}]
    (let [ct (or (get headers "content-type") (get headers "Content-Type"))
          cl (parse-long-header (or (get headers "content-length")
                                    (get headers "Content-Length")))]
      (if (and cl
               (json-content-type? ct)
               (> cl max-json-body-bytes))
        {:status 413
         :headers {"Content-Type" "application/json"}
         :body (str "{\"error\":\"Request body exceeds JSON cap of "
                    max-json-body-bytes " bytes\"}")}
        (handler req)))))

(defn- cors-origin-has-regex-meta?
  "True when an operator-supplied CORS origin string contains characters
  that ring-cors's `Pattern/quote` will treat literally — typically a
  sign the operator meant to write a regex (e.g. `https://.*\\.example\\.com`)
  but the pre-`#101` quoting now treats those bytes as themselves. Used
  by the boot-time warn so misconfigured origins surface in logs instead
  of silently never matching anything."
  [^String origin]
  (boolean (re-find #"[.*+?\[\]\\(){|]" origin)))

(mount/defstate middleware
  :start
  (let [defaults-config (:ring.middleware/defaults-config config)
        cors-config (or (:plaid.server.middleware/cors-config config)
                        {:access-control-allow-origin []
                         :access-control-allow-methods [:get :put :post :patch :delete :options]
                         :access-control-allow-headers ["Authorization" "Content-Type"]})
        allow-origins (vec (:access-control-allow-origin cors-config))
        ;; Task #118: pull the JSON-body cap from config; default 10MB.
        ;; Multiplied to bytes once at boot so the per-request middleware
        ;; just does an integer compare. The outer http-kit per-connection
        ;; cap stays sized for multipart media uploads.
        max-json-body-mb (or (get-in config [:plaid.server.http-server :max-json-body-mb]) 10)
        max-json-body-bytes (* max-json-body-mb 1024 1024)]
    (when (some #{".*" "*"} allow-origins)
      (log/warn "CORS :access-control-allow-origin includes a wildcard ('.*' or '*'). "
                "This allows cross-origin requests from ANY origin and is unsafe with "
                "credentialed endpoints. Replace with the exact origin string(s) of your "
                "frontend deployments."))
    ;; Task #119 (CORS regex-meta warn): origin strings are
    ;; `Pattern/quote`-d by `origin-string->exact-pattern`, so any
    ;; regex metacharacter in an operator-supplied origin will be
    ;; matched LITERALLY — typically a typo'd "I meant a regex"
    ;; subdomain wildcard that now matches nothing. Surface it in
    ;; logs at boot so the operator notices before deploy.
    (doseq [origin allow-origins
            :when (and (not (#{".*" "*"} origin))
                       (cors-origin-has-regex-meta? origin))]
      (log/warn (str "CORS allow-origin '" origin "' contains regex metacharacters "
                     "(., +, *, ?, [, ], \\, (, ), {, |). The middleware uses "
                     "Pattern/quote on each origin, so those characters are "
                     "matched LITERALLY, not as regex. If you meant an exact "
                     "origin string this is fine; if you meant a wildcard "
                     "subdomain pattern, list each exact origin instead.")))
    (-> (fn [_] {:status 404 :body "Not Found"})
        (wrap-rest-routes datasource)
        wrap-root-landing
        wrap-bundled-spa
        wrap-static-resources
        wrap-health
        (wrap-defaults defaults-config)
        ;; JSON body cap sits AFTER wrap-defaults so the upstream
        ;; handlers see Content-Length on raw bytes (not on what a
        ;; downstream parser might inflate). Placed inside wrap-cors
        ;; because OPTIONS pre-flight requests can't carry a body and
        ;; should never trip this cap.
        (wrap-json-body-cap max-json-body-bytes)
        (wrap-cors :access-control-allow-origin (map origin-string->exact-pattern allow-origins)
                   :access-control-allow-methods (:access-control-allow-methods cors-config)
                   :access-control-allow-headers (:access-control-allow-headers cors-config)))))
