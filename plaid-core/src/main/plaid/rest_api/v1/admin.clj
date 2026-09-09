(ns plaid.rest-api.v1.admin
  "Instance-wide operations, for the person running the server rather than
  the person annotating in it. Everything here is admin-only.

  The line these endpoints hold: they REPORT freely and WRITE almost never.
  The three writes are `backup`, `rate-limits` and `locks`, and each of them
  can only unblock something — take an extra snapshot, forget recorded
  failures, drop an advisory lock that expires by itself within a minute
  anyway. Nothing here edits configuration or deletes data. An operator who
  needs that has the config file and the shell, which is the right place for
  changes that outlive a request.

  Cost note: `server` runs a handful of counts and a directory walk, so it is
  a page a person opens, not something to poll on a timer."
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [plaid.media.storage :as media]
            [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.rate-limit :as rl]
            [plaid.server.backup :as backup]
            [plaid.server.config :refer [config]]
            [plaid.server.locks :as locks]
            [plaid.server.version :as version]
            [plaid.sql.common :as psc])
  (:import [java.io File RandomAccessFile]
           [java.lang.management ManagementFactory]))

;; ============================================================
;; Server report
;; ============================================================

(def ^:private counted-tables
  "Tables worth a row count on the server page. `audit_writes` and
  `operations` are the two that grow without bound, and the rest are the
  ones an operator is asked about (\"how many documents are on here?\")."
  [:users :projects :documents :vocab_layers :vocab_items :vocab_links
   :tokens :spans :relations :comments :invites :api_tokens
   :operations :audit_writes])

(defn- table-counts
  "`{table row-count}`. One COUNT(*) per table. A table that cannot be
  counted reports nil rather than failing the whole page."
  [db]
  (into (sorted-map)
        (map (fn [t]
               [t (try
                    (:n (psc/q1 db {:select [[[:count :*] :n]] :from [t]}))
                    (catch Exception _ nil))]))
        counted-tables))

(defn- pragmas
  "The settings SQLite reports for itself. Read off a connection rather than
  out of the config: a PRAGMA that did not take is a silent no-op, so the
  configured value and the effective one are not the same fact, and only the
  effective one is worth showing an operator."
  [db]
  (try
    (into {}
          (map (fn [[k p]]
                 [k (-> (psc/q1 db [(str "PRAGMA " p)]) first val)]))
          {:journal-mode "journal_mode"
           :synchronous "synchronous"
           :busy-timeout-ms "busy_timeout"
           :foreign-keys "foreign_keys"})
    (catch Exception _ {})))

(defn- pool-report
  "Live connection-pool occupancy, when the datasource is a Hikari one. Its
  own try: a pool that cannot be introspected is not a reason to fail the
  page, and a non-Hikari datasource (tests) has no MXBean at all."
  [db]
  (try
    (let [pool (.getHikariPoolMXBean ^com.zaxxer.hikari.HikariDataSource db)]
      {:max        (.getMaximumPoolSize ^com.zaxxer.hikari.HikariDataSource db)
       :active     (.getActiveConnections pool)
       :idle       (.getIdleConnections pool)
       :total      (.getTotalConnections pool)
       :awaiting   (.getThreadsAwaitingConnection pool)})
    (catch Throwable _ nil)))

(defn- database-report [db]
  (let [path (-> config :plaid.server.sql/config :main-db-path)
        file (when path (io/file path))
        wal-file (when path (io/file (str path "-wal")))
        page (try
               (psc/q1 db ["SELECT page_count*page_size AS bytes FROM pragma_page_count(), pragma_page_size()"])
               (catch Exception _ nil))]
    (merge {:path      (some-> file .getAbsolutePath)
            :bytes     (:bytes page)
            :wal-bytes (when (and wal-file (.exists wal-file)) (.length wal-file))
            :pool      (pool-report db)
            :tables    (table-counts db)}
           (pragmas db))))

(defn- jvm-report []
  (let [runtime (Runtime/getRuntime)
        mx (ManagementFactory/getRuntimeMXBean)]
    {:uptime-ms  (.getUptime mx)
     :started-at (str (java.time.Instant/ofEpochMilli (.getStartTime mx)))
     :java       (System/getProperty "java.version")
     :heap-used  (- (.totalMemory runtime) (.freeMemory runtime))
     :heap-max   (.maxMemory runtime)}))

(defn- settings-report
  "The configuration an operator is likely to be asked to confirm, read from
  the live config rather than re-parsed from the file, so it reflects what
  the process is actually running under.

  Deliberately partial. Nothing here is a secret, because nothing here is
  reported unless it is already inferable from the server's behaviour: the
  port it answered on, the token lifetime it stamps, the body size it
  refuses. The JWT secret and the database credentials are not in this map
  and must not be added to it."
  []
  {:port                 (-> config :org.httpkit.server/config :port)
   :jwt-ttl-seconds      (-> config :plaid.auth :jwt-ttl-seconds)
   :delegated-token-ttl-seconds (-> config :plaid.auth :delegated-token-ttl-seconds)
   :openapi-exposed      (-> config :plaid.api :expose-openapi?)
   :max-json-body-mb     (-> config :plaid.server.http-server :max-json-body-mb)
   :media-max-file-mb    (-> config :plaid.media/config :max-file-size-mb)
   :lock-expiration-ms   (-> config :plaid.server.locks/config :expiration-ms)
   :log-level            (-> config :taoensso.timbre/logging-config :min-level)
   :log-file             (-> config :plaid.logging/config :file)
   :cors-allowed-origins (-> config :plaid.server.middleware/cors-config :access-control-allow-origin)
   :static-resources-path (-> config :plaid.server.middleware/static-resources-path)})

;; ============================================================
;; Log tail
;; ============================================================

(def ^:private max-log-lines 2000)

(defn- tail-lines
  "The last `n` lines of `file`, read backwards from the end so the cost is
  bounded by what is returned rather than by the size of the log. Reads at
  most 1 MB, which is far more than `max-log-lines` of any real log line and
  keeps a pathological single-line file from being slurped whole."
  [^File file n]
  (let [cap (* 1024 1024)
        len (.length file)
        from (max 0 (- len cap))]
    (with-open [raf (RandomAccessFile. file "r")]
      (.seek raf from)
      (let [buf (byte-array (- len from))]
        (.readFully raf buf)
        (->> (str/split-lines (String. buf "UTF-8"))
             (take-last n)
             vec)))))

(defn- log-report [n]
  (let [path (-> config :plaid.logging/config :file)
        file (when path (io/file path))]
    (cond
      (nil? path)
      {:file nil :lines [] :error "No log file configured ([logging] file)."}

      (not (.isFile file))
      {:file (.getAbsolutePath file) :lines []
       :error "Configured log file does not exist yet."}

      :else
      (try
        {:file (.getAbsolutePath file) :lines (tail-lines file n)}
        (catch Exception e
          {:file (.getAbsolutePath file) :lines []
           :error (or (.getMessage e) (.. e getClass getSimpleName))})))))

;; ============================================================
;; Routes
;; ============================================================

(def admin-routes
  ["/admin"
   {:middleware [[pra/wrap-admin-required]]}

   ["/server"
    {:get {:summary (str "Everything about this server in one read: version and JVM uptime, "
                         "database size and per-table row counts, media directory usage, "
                         "backup configuration and the backups actually on disk, and the "
                         "settings an operator gets asked to confirm. No secrets: the JWT "
                         "signing key and database credentials are not in this response. "
                         "Runs a count per table and walks the media directory, so open it, "
                         "do not poll it.")
           :handler (fn [{db :db}]
                      {:status 200
                       :body {:version  version/version
                              :jvm      (jvm-report)
                              :database (database-report db)
                              :media    (media/stats db)
                              :backup   (backup/status)
                              :settings (settings-report)}})}}]

   ["/backup"
    {:post {:summary (str "Take a database backup right now, outside the nightly schedule. "
                          "Returns the same body as the backup block of "
                          "<code>/admin/server</code>, with <code>ok</code> reporting whether "
                          "the snapshot succeeded. Uses VACUUM INTO, which only reads, so it "
                          "is safe while people are working.")
            :handler (fn [{db :db}]
                       (let [result (backup/run-now! db)]
                         {:status (if (:ok result) 200 500)
                          :body result}))}}]

   ["/locks"
    {:get {:summary (str "Documents currently held by an editing lock, with who holds each "
                         "and when it expires on its own. A lock is advisory and short-lived; "
                         "this is how a document that refuses writes becomes visible to "
                         "anyone but the writer being refused.")
           :handler (fn [_]
                      {:status 200
                       :body {:entries (locks/list-locks)}})}}]

   ["/locks/:document-id"
    {:parameters {:path [:map [:document-id :uuid]]}
     :delete {:summary (str "Drop the lock on a document whoever holds it. Idempotent. For a "
                            "client that went away without releasing one, which otherwise "
                            "leaves the document unwritable until the lock expires.")
              :handler (fn [{{{:keys [document-id]} :path} :parameters}]
                         {:status 200
                          :body {:result (name (locks/force-release! document-id))}})}}]

   ["/rate-limits"
    {:get {:summary (str "Live login and invite rate-limit buckets: the address, the account "
                         "where there is one, how many failures are inside the window, the "
                         "limit, and whether it is currently blocking. Answers \"why can this "
                         "person not log in\".")
           :handler (fn [_]
                      {:status 200
                       :body (rl/snapshot)})}
     :delete {:summary (str "Forget recorded failures. With <code>ip</code>, clears that "
                            "address, narrowed to one account with <code>user-id</code>. With "
                            "neither, clears every bucket. Only ever unblocks.")
              :parameters {:query [:map
                                   [:ip {:optional true} string?]
                                   [:user-id {:optional true} string?]]}
              :handler (fn [{{{:keys [ip user-id]} :query} :parameters}]
                         (rl/clear-buckets! {:ip ip :user-id user-id})
                         {:status 200
                          :body {:result "cleared"}})}}]

   ["/logs"
    {:get {:summary (str "The tail of the configured log file. Returns an <code>error</code> "
                         "string instead of lines when no log file is configured or it does "
                         "not exist yet — the server also logs to stdout, where a file is not "
                         "required.")
           :parameters {:query [:map [:lines {:optional true} int?]]}
           :handler (fn [{{{:keys [lines]} :query} :parameters}]
                      {:status 200
                       :body (log-report (min (or lines 200) max-log-lines))})}}]])
