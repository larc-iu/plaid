(ns plaid.server.config
  "Operator-facing configuration.

   Operators edit a friendly, commented TOML file (see resources/config.toml
   for the shipped template). On first launch the template is written verbatim
   to data/config.toml so every available key is discoverable on disk.

   Internally, components still consume a map keyed by namespaced keywords
   (e.g. `:plaid.media/config`). `translate` is the bridge: it maps the
   friendly TOML names onto that internal shape. The internal representation
   never changes, so component code is untouched."
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [mount.core :refer [defstate args]]
            [taoensso.timbre :as log]
            [taoensso.timbre.appenders.community.rolling :as rolling])
  (:import (org.tomlj Toml TomlArray TomlTable)))

(defn- deep-merge [a b]
  (cond
    (nil? b) a
    (and (map? a) (map? b)) (merge-with deep-merge a b)
    :else b))

;; -----------------------------------------------------------------------------
;; Internal-only defaults
;; -----------------------------------------------------------------------------
;; Config that is intentionally NOT exposed in config.toml: deep middleware /
;; security plumbing operators should not hand-edit, plus logging knobs with no
;; friendly equivalent. Merged UNDER the TOML-derived config, so any overlapping
;; TOML value wins.
(def ^:private internal-only-defaults
  {:ring.middleware/defaults-config {:params {:keywordize true
                                              :multipart true
                                              :nested true
                                              :urlencoded true}
                                     :cookies false
                                     :session false
                                     :responses {:absolute-redirects true
                                                 :content-types true
                                                 :default-charset "utf-8"
                                                 :not-modified-responses true}
                                     :static {:resources "public"}
                                     :security {:anti-forgery false
                                                :hsts true
                                                :ssl-redirect false
                                                :frame-options nil
                                                :xss-protection {:enable? false
                                                                 :mode :block}}}

   :taoensso.timbre/logging-config {:ns-whitelist []
                                    :ns-blacklist []}

   ;; Third-party LIBRARY log stream (slf4j-simple). Defaults to :warn so
   ;; library chatter (Hikari pool banner, etc.) stays quiet unless an
   ;; operator opts into it via [logging] library_level. The template
   ;; supplies :warn too; this is the floor if the key is deleted.
   :plaid.logging/config {:library-level :warn}})

;; -----------------------------------------------------------------------------
;; TOML -> internal translation
;; -----------------------------------------------------------------------------
(defn- ->kw [s] (keyword (str/lower-case (str s))))
(defn- ->kw-vec [xs] (mapv ->kw xs))
(defn- ->vec [xs] (vec xs))

(def ^:private translation
  "Each entry: [toml-path internal-path coerce-fn]. `toml-path` is the friendly
   nested key (e.g. [\"server\" \"port\"]); `internal-path` is where it lands in
   the namespaced-keyword config map. Keys absent from a given TOML file are
   skipped, so partial overlays fall back to defaults via deep-merge. Commented
   advanced keys (pool tuning, slow-query threshold) live here too so they work
   the moment an operator uncomments them."
  [[["server" "port"]                     [:org.httpkit.server/config :port]                                 identity]
   [["server" "max_json_body_mb"]         [:plaid.server.http-server :max-json-body-mb]                      identity]
   [["server" "static_resources_path"]    [:plaid.server.middleware/static-resources-path]                  identity]

   [["logging" "level"]                   [:taoensso.timbre/logging-config :min-level]                       ->kw]
   [["logging" "library_level"]           [:plaid.logging/config :library-level]                             ->kw]
   [["logging" "file"]                    [:plaid.logging/config :file]                                      identity]

   [["auth" "jwt_ttl_seconds"]            [:plaid.auth :jwt-ttl-seconds]                                     identity]

   [["api" "expose_openapi"]              [:plaid.api :expose-openapi?]                                      identity]

   [["media" "max_file_size_mb"]          [:plaid.media/config :max-file-size-mb]                            identity]

   [["database" "path"]                   [:plaid.server.sql/config :main-db-path]                           identity]
   [["database" "slow_query_threshold_ms"] [:plaid.server.sql/config :slow-query-threshold-ms]              identity]
   [["database" "min_name_length"]        [:plaid.sql.common/config :min-name-length]                        identity]
   [["database" "max_name_length"]        [:plaid.sql.common/config :max-name-length]                        identity]
   [["database" "max_pool_size"]          [:plaid.sql.common/pool :max-pool-size]                            identity]
   [["database" "connection_timeout_ms"]  [:plaid.sql.common/pool :connection-timeout-ms]                    identity]
   [["database" "busy_timeout_ms"]        [:plaid.sql.common/pool :busy-timeout-ms]                          identity]
   [["database" "journal_mode"]           [:plaid.sql.common/pool :journal-mode]                             identity]
   [["database" "synchronous"]            [:plaid.sql.common/pool :synchronous]                              identity]

   [["cors" "allowed_origins"]            [:plaid.server.middleware/cors-config :access-control-allow-origin]  ->vec]
   [["cors" "allowed_methods"]            [:plaid.server.middleware/cors-config :access-control-allow-methods] ->kw-vec]
   [["cors" "allowed_headers"]            [:plaid.server.middleware/cors-config :access-control-allow-headers] ->vec]

   [["locks" "expiration_ms"]             [:plaid.server.locks/config :expiration-ms]                        identity]

   [["events" "heartbeat_interval_ms"]    [:plaid.server.events/heartbeat :interval-ms]                      identity]
   [["events" "heartbeat_max_misses"]     [:plaid.server.events/heartbeat :max-consecutive-misses]           identity]

   [["backup" "enabled"]                  [:plaid.backup/config :enabled?]                                   identity]
   [["backup" "directory"]                [:plaid.backup/config :directory]                                  identity]
   [["backup" "retention"]                [:plaid.backup/config :retention]                                  identity]
   [["backup" "time"]                     [:plaid.backup/config :time]                                       identity]])

(defn- translate
  "Convert friendly TOML data (string-keyed nested map) into the internal
   namespaced-keyword config map. Keys absent from `toml` are skipped."
  [toml]
  (reduce (fn [acc [toml-path internal-path coerce]]
            (let [v (get-in toml toml-path ::absent)]
              (if (= v ::absent)
                acc
                (assoc-in acc internal-path (coerce v)))))
          {}
          translation))

(defn- leaf-paths
  "All paths from `m` down to a non-map leaf (scalars and vectors are leaves)."
  [m]
  (mapcat (fn [[k v]]
            (if (map? v)
              (map #(into [k] %) (leaf-paths v))
              [[k]]))
          m))

(defn- unknown-keys
  "TOML leaf paths that `translate` does not recognize (operator typos)."
  [toml]
  (let [known (into #{} (map first) translation)]
    (remove known (leaf-paths toml))))

;; -----------------------------------------------------------------------------
;; TOML parsing
;; -----------------------------------------------------------------------------
(defn- toml->clj
  "Recursively convert tomlj parse output into plain Clojure data: string-keyed
   maps, vectors, and scalar values (Long/Double/Boolean/String)."
  [x]
  (cond
    (instance? TomlTable x) (toml->clj (.toMap ^TomlTable x))
    (instance? TomlArray x) (toml->clj (.toList ^TomlArray x))
    (instance? java.util.Map x) (into {} (map (fn [[k v]] [k (toml->clj v)])) x)
    (instance? java.util.List x) (mapv toml->clj x)
    :else x))

(defn- parse-toml
  "Parse a TOML string into Clojure data, throwing ex-info with the parse
   errors (and `source` for context) on malformed input."
  [^String content source]
  (let [result (Toml/parse content)]
    (when (.hasErrors result)
      (throw (ex-info (str "TOML parse error in " source ":\n  "
                           (str/join "\n  " (map #(.toString %) (.errors result))))
                      {:source source})))
    (toml->clj result)))

(defn- read-toml
  "Return [content source-label] for `path`, resolving the classpath first
   (io/resource) then the filesystem (io/file). nil if it resolves to neither."
  [path]
  (when path
    (if-let [r (io/resource path)]
      [(slurp r) (str "classpath:" path)]
      (let [f (io/file path)]
        (when (.exists f)
          [(slurp f) (.getAbsolutePath f)])))))

;; -----------------------------------------------------------------------------
;; Loading
;; -----------------------------------------------------------------------------
(defn load-config!
  "Build the internal config map: the bundled config.toml template supplies the
   default values, the file at `config-path` (classpath first, then filesystem)
   is deep-merged on top, and the internal-only plumbing sits underneath.

   When `explicit?` is true (operator passed --config) and the path resolves to
   nothing, throws ex-info naming the path rather than silently degrading to
   defaults. When false (the default path), a missing overlay is tolerated."
  [{:keys [config-path explicit?]}]
  (let [[tpl-content tpl-src] (or (read-toml "config.toml")
                                  (throw (ex-info "Bundled config.toml is missing from the classpath" {})))
        defaults (translate (parse-toml tpl-content tpl-src))
        [ov-content ov-src] (read-toml config-path)]
    (when (and explicit? (nil? ov-content))
      (throw (ex-info (str "Config file not found: " config-path
                           " (resolved neither on the classpath nor on the filesystem)")
                      {:config-path config-path})))
    (let [overlay (when ov-content
                    (let [toml (parse-toml ov-content ov-src)
                          uk (seq (unknown-keys toml))]
                      (when uk
                        (log/warn "Unrecognized config keys in" ov-src "(ignored):"
                                  (str/join ", " (map #(str/join "." %) uk))))
                      (translate toml)))]
      (deep-merge (deep-merge internal-only-defaults defaults) overlay))))

(defn ensure-config-file!
  "If no file exists at `path`, copy the bundled config.toml template there
   verbatim (preserving comments) so operators get a fully-commented file to
   edit. No-op if the file already exists. Returns `path`."
  [path]
  (let [f (io/file path)]
    (when-not (.exists f)
      (when-let [parent (.getParentFile f)]
        (.mkdirs parent))
      (with-open [in (io/input-stream (io/resource "config.toml"))]
        (io/copy in f))
      (log/info "No config found; wrote default config to" (.getAbsolutePath f)))
    path))

(defn- default-config-path []
  (or (not-empty (System/getenv "PLAID_CONFIG")) "data/config.toml"))

(defn- ->slf4j-level
  "Map a Timbre/keyword level onto an slf4j-simple level string. slf4j-simple
   has no :fatal/:report, so fold them onto the nearest equivalent; anything
   unrecognized falls back to warn."
  [level]
  (case (keyword level)
    :trace "trace"
    :debug "debug"
    (:info :report) "info"
    :warn "warn"
    (:error :fatal) "error"
    "warn"))

(defn- log-output-fn
  "Concise single-line Timbre format that visually matches the slf4j-simple
   library stream: `2026-06-15 12:00:00.123 [INFO] plaid.x.y - message`.
   Drops Timbre's default hostname (noise on a single-host deployment) and the
   source line (the namespace is enough to locate a call), but still appends a
   stacktrace when an error is attached."
  [{:keys [level ?ns-str timestamp_ msg_ ?err]}]
  (str (force timestamp_)
       " [" (str/upper-case (name level)) "] "
       (or ?ns-str "?")
       " - " (force msg_)
       (when ?err
         (str \newline (log/stacktrace ?err)))))

(defn configure-logging!
  "Wire up both log streams from config:

   * Plaid's own code logs through Timbre — `[logging] level` sets its min
     level, with a clean single-line format. When `[logging] file` is set the
     console appender is replaced by a daily-rolling file appender (old days
     kept as `<file>.YYYYMMDD`).
   * Third-party libraries log through slf4j-simple, driven by `[logging]
     library_level` (default warn) and pointed at the same destination. These
     properties are read once at slf4j init, so we set them here — ahead of the
     datasource pool, the first library logger — and a change needs a process
     restart to take effect."
  [config]
  (let [logging-config (:taoensso.timbre/logging-config config)
        {:keys [library-level file]} (:plaid.logging/config config)]
    ;; --- third-party library stream (slf4j-simple) ---
    (doto (System/getProperties)
      (.setProperty "org.slf4j.simpleLogger.defaultLogLevel"
                    (->slf4j-level (or library-level :warn)))
      (.setProperty "org.slf4j.simpleLogger.logFile" (or file "System.out")))
    ;; --- Plaid's own stream (Timbre) ---
    ;; Spell out BOTH appenders' :enabled? either way so the result is the same
    ;; regardless of prior state (merge-config! is additive — a stale :rolling
    ;; from an earlier file-configured call would otherwise keep firing). With a
    ;; file we swap the console appender for the daily-rolling one; without, the
    ;; console appender is on and any rolling appender is inert. Timbre skips
    ;; disabled appenders before touching :fn, so the stubs are harmless.
    (log/merge-config!
     (merge logging-config
            {:min-level (or (:min-level logging-config) :info)
             :timestamp-opts {:pattern "yyyy-MM-dd HH:mm:ss.SSS"
                              :locale :jvm-default
                              :timezone :jvm-default}
             :output-fn log-output-fn
             :appenders (if file
                          {:println {:enabled? false}
                           :rolling (rolling/rolling-appender {:path file :pattern :daily})}
                          {:println {:enabled? true}
                           :rolling {:enabled? false}})}))))

(defstate config
  :start (let [{:keys [config]} (args)
               explicit? (some? config)
               path (or config (default-config-path))
               ;; Auto-write the commented template only for the default
               ;; (non-explicit) path AND only when it's a filesystem path
               ;; (not a classpath resource — the dev overlay is on the
               ;; classpath and must never be written to disk).
               _ (when (and (not explicit?) (nil? (io/resource path)))
                   (ensure-config-file! path))
               configuration (load-config! {:config-path path :explicit? explicit?})]
           (configure-logging! configuration)
           (log/info "Loaded config from" path)
           ;; Full resolved config (incl. internal plumbing) is verbose and
           ;; only useful when diagnosing — keep it at debug.
           (log/debug (pr-str configuration))
           configuration))
