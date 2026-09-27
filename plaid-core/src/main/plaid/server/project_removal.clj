(ns plaid.server.project-removal
  "Removing a deleted project, a document at a time, after `plaid.sql.project/delete`
  has hidden it.

  The delete itself is one short step (it stamps `projects.deleted_at` and the
  project is gone to everyone from then on). What is under the project is
  removed here, ONE DOCUMENT PER TRANSACTION with a pause between them, so the
  write lock is never held for longer than one document takes: removing a
  400-document project in one transaction held it for 18 s, and every save on
  the server waited. Then the project row and its layers, the documents'
  media files, and the project's history (`purge-history?`).

  A project whose removal did not finish (a crash, a restart) keeps its
  `deleted_at`, and `resume!` takes it up again at startup.

  Inline by default, so the test suite sees a deleted project fully removed
  when the DELETE returns. The HTTP server switches `background?` on at
  startup, a path tests never run."
  (:require [plaid.media.storage :as media]
            [plaid.sql.project :as prj]
            [taoensso.timbre :as log])
  (:import (com.zaxxer.hikari HikariDataSource)
           (java.util.concurrent ExecutorService Executors ThreadFactory)))

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

(defn remove-project!
  "Remove everything under project `pid`, which `prj/delete` has hidden, then
  the project itself. Returns the number of documents removed."
  [datasource pid]
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
    (if (with-retries "the project row" datasource #(prj/remove-hidden-project! datasource pid))
      (do
        (log/info (format "Removed deleted project %s: %d documents in %dms"
                          pid n (quot (- (System/nanoTime) t0) 1000000)))
        (when @purge-history?
          (log/info "Purged history for deleted project" pid
                    (prj/purge-deleted-project-history! datasource pid))))
      ;; Already removed (a second run of the same removal), or a document
      ;; still under it, which the next startup takes up again.
      (when (prj/hidden? datasource pid)
        (log/warn "Deleted project" pid "still holds documents; the next startup resumes its removal")))
    n))

(defonce ^:private ^ExecutorService executor
  (Executors/newSingleThreadExecutor
   (reify ThreadFactory
     (newThread [_ r]
       (doto (Thread. ^Runnable r "plaid-project-removal")
         (.setDaemon true))))))

(defn schedule!
  "Remove hidden project `pid`: on the one background thread when
  `background?`, one project after another, else here and now."
  [datasource pid]
  (let [run #(try
               (remove-project! datasource pid)
               (catch Throwable t
                 (log/error t "Removing deleted project" pid "failed; the next startup resumes it")))]
    (if @background?
      (.submit executor ^Runnable run)
      (run))))

(defn resume!
  "Take up the removal of every project still marked deleted: one whose removal
  a crash or a restart cut short."
  [datasource]
  (doseq [pid (prj/hidden-ids datasource)]
    (log/info "Resuming the removal of deleted project" pid)
    (schedule! datasource pid)))
