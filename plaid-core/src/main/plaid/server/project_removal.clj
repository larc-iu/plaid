(ns plaid.server.project-removal
  "Removing a deleted project, a document at a time, after `plaid.sql.project/delete`
  has hidden it.

  The delete itself is one short step (it stamps `projects.deleted_at` and the
  project is gone to everyone from then on). What is under the project is
  removed here, ONE DOCUMENT PER TRANSACTION with a pause between them, so the
  write lock is never held for longer than one document takes: removing a
  400-document project in one transaction held it for 18 s, and every save on
  the server waited. With each document its media files, then the project's
  history (`purge-history?`), then last the project row and its layers.

  A project whose removal or purge did not finish (a crash, a restart) keeps
  its `deleted_at`, and `resume!` takes it up again at startup. History left
  behind by a project already gone is purged at startup and hourly
  (`sweep-stranded-history!`).

  Inline by default, so the test suite sees a deleted project fully removed
  when the DELETE returns. The HTTP server switches `background?` on at
  startup, a path tests never run."
  (:require [plaid.media.storage :as media]
            [plaid.server.sql :as server-sql]
            [plaid.sql.project :as prj]
            [taoensso.timbre :as log])
  (:import (com.zaxxer.hikari HikariDataSource)
           (java.util.concurrent Executors ScheduledExecutorService ThreadFactory TimeUnit)))

(defonce ^{:doc "When true, removal runs on the background thread, else inline in
  the request that deleted the project. The HTTP server flips it at startup."}
  background?
  (atom false))

(defonce ^{:doc "When true, the removed project's operations and audit rows are
  purged too (`prj/purge-deleted-project-history!`). Off by default so the test
  suite, which deletes projects and then asserts on their audit rows, never
  races a purge. The HTTP server flips it at startup."}
  purge-history?
  (atom false))

(def ^:private pause-ms
  "How long to stand off the database between two documents, in the
  background. A writer that arrived while one document's transaction held the
  write lock is parked in its busy_timeout retry loop, and this is the window
  in which it is certain to find the lock free."
  50)

(def ^:private purge-pause-ms
  "The least the history purge stands off the database after each of its
  chunks, in the background (`prj/purge-deleted-project-history!` stands off
  for as long as the chunk took when that is more). Above the 100 ms a
  writer parked in busy_timeout sleeps between polls, so it wins the lock."
  150)

(def ^:private attempts
  "How many times one step is tried before the removal gives up until the
  next startup. A step can lose the write lock to a long write elsewhere
  (SQLITE_BUSY past busy_timeout)."
  10)

(defn- closed?
  "Has the pool been closed under the removal (the server is stopping)? The
  removal then stops where it is, and the next startup resumes it."
  [datasource]
  (and (instance? HikariDataSource datasource) (.isClosed ^HikariDataSource datasource)))

(defn- with-retries
  "`(f)`, tried up to `attempts` times a second apart."
  [what datasource f]
  (loop [i 1]
    (let [r (try {:ok (f)}
                 (catch Exception e
                   (if (and (< i attempts) (not (closed? datasource)))
                     (do (log/warn e (str "Project removal: " what " failed, trying again"))
                         ::retry)
                     (throw e))))]
      (if (= ::retry r)
        (do (Thread/sleep 1000) (recur (inc i)))
        (:ok r)))))

(defn- purge-history!
  "Purge `pid`'s history (`prj/purge-deleted-project-history!`), standing off
  between chunks in the background, and log what went."
  [datasource pid]
  (log/info "Purged history for deleted project" pid
            (prj/purge-deleted-project-history!
             datasource pid {:pause-ms (if @background? purge-pause-ms 0)})))

(defn remove-project!
  "Remove everything under project `pid`, which `prj/delete` has hidden, then
  its history (when `purge-history?`), then the project row. The row goes
  last, so a removal or a purge cut short leaves the project marked deleted
  and `resume!` takes it up again. Returns the number of documents removed."
  [datasource pid]
  ;; Every step below leans on FK cascades, and SQLite plans each cascade
  ;; from its statistics. A table analysed while nearly empty and since grown
  ;; past a tenfold (a young install, before the next refresh) is planned as
  ;; a scan per deleted row: 34 to 138 s for one 5000-row chunk of the history
  ;; purge, against 0.1 s once analysed.
  (when @background?
    (try (server-sql/refresh-stale-statistics! datasource "before a project removal")
         (catch Exception e
           (log/warn e "ANALYZE before a project removal failed; removing with the statistics there are"))))
  (let [t0 (System/nanoTime)
        n (loop [n 0]
            (if-let [doc-id (with-retries "a document" datasource #(prj/remove-hidden-document! datasource pid))]
              (do
                (let [{:keys [failed]} (media/delete-media-files! [doc-id])]
                  (when (pos? failed)
                    (log/warn "A deleted project's media file could not be deleted"
                              {:project-id pid :document-id doc-id})))
                (when @background? (Thread/sleep pause-ms))
                (recur (inc n)))
              n))]
    (when (and @purge-history? (prj/hidden? datasource pid))
      (purge-history! datasource pid))
    (if (with-retries "the project row" datasource #(prj/remove-hidden-project! datasource pid))
      (log/info (format "Removed deleted project %s: %d documents in %dms"
                        pid n (quot (- (System/nanoTime) t0) 1000000)))
      ;; Already removed (a second run of the same removal), or a document
      ;; still under it, which the next startup takes up again.
      (when (prj/hidden? datasource pid)
        (log/warn "Deleted project" pid "still holds documents; the next startup resumes its removal")))
    n))

(defn sweep-stranded-history!
  "Purge the history of every project that is gone but still has some
  (`prj/stranded-history-project-ids`): one removed with the purge off, or
  history a purge left before the project row came to be removed last. Does
  nothing unless `purge-history?`. Returns the ids purged."
  [datasource]
  (if @purge-history?
    (let [ids (prj/stranded-history-project-ids datasource)]
      (doseq [pid ids]
        (when-not (closed? datasource)
          (purge-history! datasource pid)))
      ids)
    []))

(defonce ^:private ^ScheduledExecutorService executor
  (Executors/newSingleThreadScheduledExecutor
   (reify ThreadFactory
     (newThread [_ r]
       (doto (Thread. ^Runnable r "plaid-project-removal")
         (.setDaemon true))))))

(defn- run-now!
  "Run `f` on the one background thread when `background?`, after whatever
  removal or sweep is already queued, else here and now."
  [f]
  (if @background?
    (.submit executor ^Runnable f)
    (f)))

(defn schedule!
  "Remove hidden project `pid`: on the one background thread when
  `background?`, one project after another, else here and now."
  [datasource pid]
  (run-now! #(try
               (remove-project! datasource pid)
               (catch Throwable t
                 (log/error t "Removing deleted project" pid "failed; it stays marked deleted"
                            "and the next startup resumes it")))))

(defn- schedule-sweep!
  [datasource]
  (run-now! #(try
               (when-not (closed? datasource)
                 (sweep-stranded-history! datasource))
               (catch Throwable t
                 (log/error t "Purging the history of removed projects failed; the next sweep"
                            "takes it up again")))))

(defn resume!
  "Take up the removal of every project still marked deleted: one whose removal
  a crash or a restart cut short. Then purge the history of projects already
  gone (`sweep-stranded-history!`)."
  [datasource]
  (doseq [pid (prj/hidden-ids datasource)]
    (log/info "Resuming the removal of deleted project" pid)
    (schedule! datasource pid))
  (schedule-sweep! datasource))

(def ^:private sweep-interval-ms
  "How often the running server repeats the sweep of stranded history."
  (* 60 60 1000))

(defonce ^:private sweep-schedule (atom nil))

(defn start-sweeps!
  "Repeat `sweep-stranded-history!` hourly on the background thread, as long
  as the server runs. A schedule already running is cancelled first."
  [datasource]
  (some-> ^java.util.concurrent.ScheduledFuture @sweep-schedule (.cancel false))
  (reset! sweep-schedule
          (.scheduleWithFixedDelay executor
                                   ^Runnable #(try
                                                (when-not (closed? datasource)
                                                  (sweep-stranded-history! datasource))
                                                (catch Throwable t
                                                  (log/error t "Purging the history of removed projects failed;"
                                                             "the next sweep takes it up again")))
                                   (long sweep-interval-ms) (long sweep-interval-ms)
                                   TimeUnit/MILLISECONDS)))
