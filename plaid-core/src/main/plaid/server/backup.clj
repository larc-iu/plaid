(ns plaid.server.backup
  "Nightly SQLite backups.

   A single daemon thread that, once a day at a configured wall-clock time,
   writes a consistent, compacted snapshot of the database via `VACUUM INTO`
   (WAL-safe with the server running — it only reads the source DB), zips it
   into the backup directory as `plaid-backup-<timestamp>.zip`, and prunes all
   but the most recent N zips.

   Everything is driven from the `[backup]` config section (see config.toml).
   The scheduler reschedules itself after each run so it tracks the configured
   wall-clock time across DST shifts and clock changes rather than drifting on
   a fixed 24h period."
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [mount.core :refer [defstate]]
            [next.jdbc :as jdbc]
            [plaid.server.config :refer [config]]
            [plaid.server.sql :refer [datasource]]
            [taoensso.timbre :as log])
  (:import [java.io File]
           [java.time LocalDateTime LocalTime]
           [java.time.format DateTimeFormatter]
           [java.time.temporal ChronoUnit]
           [java.util.concurrent Executors ScheduledExecutorService ThreadFactory TimeUnit]
           [java.util.zip ZipEntry ZipOutputStream]))

(def ^:private defaults
  {:enabled?  true
   :directory "data/backups"
   :retention 5
   :time      "03:00"})

(defn- backup-config []
  ;; translate only assoc-in's keys the operator actually set, so merge over
  ;; the defaults to fill any holes.
  (merge defaults (:plaid.backup/config config)))

(def ^:private file-prefix "plaid-backup-")
(def ^:private ^DateTimeFormatter ts-formatter (DateTimeFormatter/ofPattern "yyyyMMdd-HHmmss"))

(defn- backup-zip? [^File f]
  (let [n (.getName f)]
    (and (.startsWith n file-prefix) (.endsWith n ".zip"))))

(defn- sqlite-quote
  "Single-quote a string literal for embedding in SQL (escape embedded quotes).
   VACUUM INTO's target can't be reliably passed as a bound parameter, so the
   path is inlined. Paths are server-generated, but escape defensively anyway."
  [s]
  (str \' (str/replace s "'" "''") \'))

(defn- zip-file!
  "Write `src` into `zip` as a single entry named after `src`."
  [^File src ^File zip]
  (with-open [out (ZipOutputStream. (io/output-stream zip))]
    (.putNextEntry out (ZipEntry. (.getName src)))
    (io/copy src out)
    (.closeEntry out)))

(defn- prune!
  "Delete all but the `retention` newest backup zips in `dir`. Filenames embed
   a sortable timestamp, so lexicographic order is chronological."
  [^File dir retention]
  (let [zips (->> (.listFiles dir) (filter backup-zip?) (sort-by #(.getName ^File %)))]
    (doseq [^File f (drop-last (max 1 retention) zips)]
      (if (.delete f)
        (log/info "Pruned old database backup:" (.getName f))
        (log/warn "Could not delete old database backup:" (.getName f))))))

(defn backup-once!
  "Take one backup now: snapshot `ds` into a timestamped zip under `dir`, then
   prune to the `retention` newest. Returns the zip File on success, nil on
   failure (failures are logged, never thrown — a bad backup must not crash the
   scheduler or the server)."
  [ds dir retention]
  (let [dir-file (io/file dir)
        stamp    (.format (LocalDateTime/now) ts-formatter)
        snapshot (io/file dir-file (str file-prefix stamp ".db"))
        zip      (io/file dir-file (str file-prefix stamp ".zip"))]
    (try
      (.mkdirs dir-file)
      ;; VACUUM INTO produces a fresh, defragmented, transactionally-consistent
      ;; copy. It only reads the source, so it's safe with writers active and
      ;; captures committed WAL frames without an explicit checkpoint.
      (jdbc/execute-one! ds [(str "VACUUM INTO " (sqlite-quote (.getAbsolutePath snapshot)))])
      (zip-file! snapshot zip)
      (.delete snapshot)
      (prune! dir-file retention)
      (log/info (format "Database backup written: %s (%d KB)"
                        (.getName zip) (quot (.length zip) 1024)))
      zip
      (catch Exception e
        (log/error e "Database backup failed")
        (when (.exists snapshot) (.delete snapshot))
        nil))))

(defn- parse-time ^LocalTime [s]
  (try
    (LocalTime/parse s)                  ; accepts "HH:mm" and "HH:mm:ss"
    (catch Exception _
      (log/warn "Invalid [backup] time" (pr-str s) "- falling back to" (:time defaults))
      (LocalTime/parse ^String (:time defaults)))))

(defn- ms-until-next
  "Milliseconds from `now` to the next occurrence of time-of-day `t`."
  [^LocalTime t ^LocalDateTime now]
  (let [today-run (.atDate t (.toLocalDate now))
        next-run  (if (.isAfter now today-run) (.plusDays today-run 1) today-run)]
    (.between ChronoUnit/MILLIS now next-run)))

(defn- schedule-next!
  "Schedule the next backup at the configured time, then re-arm itself."
  [^ScheduledExecutorService exec ds]
  (let [{:keys [directory retention time]} (backup-config)
        delay-ms (ms-until-next (parse-time time) (LocalDateTime/now))
        task (reify Runnable
               (run [_]
                 (try (backup-once! ds directory retention)
                      (catch Throwable t (log/error t "Database backup task error")))
                 (when-not (.isShutdown exec)
                   (schedule-next! exec ds))))]
    (log/info (format "Next database backup in %.1f h (at %s)" (/ delay-ms 3600000.0) time))
    (.schedule exec task delay-ms TimeUnit/MILLISECONDS)))

(defstate backup-scheduler
  :start (let [{:keys [enabled? directory retention time]} (backup-config)]
           (if-not enabled?
             (do (log/info "Nightly database backup disabled ([backup] enabled = false).") nil)
             (let [exec (Executors/newSingleThreadScheduledExecutor
                         (reify ThreadFactory
                           (newThread [_ r]
                             (doto (Thread. ^Runnable r "plaid-db-backup") (.setDaemon true)))))]
               (log/info (format "Nightly database backup enabled: %s, keep %d, at %s"
                                 directory retention time))
               (schedule-next! exec datasource)
               exec)))
  :stop (when backup-scheduler
          (.shutdownNow ^ScheduledExecutorService backup-scheduler)
          nil))
