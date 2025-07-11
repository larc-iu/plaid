(ns plaid.server.locks
  "Document locking system for ensuring atomicity of batch operations"
  (:require [clojure.tools.logging :as log]
            [mount.core :refer [defstate]])
  (:import [java.time Instant]
           [java.util.concurrent Executors ScheduledExecutorService TimeUnit]))

(def ^:private lock-expiration-ms (* 60 1000)) ; 60 seconds

(def ^:private locks
  "Map of document-id -> {:user-id user-id :expires-at instant}"
  (atom {}))

(defn- current-time-ms []
  (.toEpochMilli (Instant/now)))

(defn- expired? [lock-entry]
  (< (:expires-at lock-entry) (current-time-ms)))

(defn sweep-expired-locks!
  "Remove expired locks from the system"
  []
  (let [now (current-time-ms)]
    (swap! locks
           (fn [lock-map]
             (into {}
                   (remove (fn [[_ lock-entry]]
                             (expired? lock-entry))
                           lock-map))))))

(defn acquire-lock!
  "Attempt to acquire a lock for the given document-id and user-id.
   Returns:
   - :acquired if lock was successfully acquired
   - :refreshed if user already held the lock (refreshed)
   - :conflict if lock is held by another user"
  [document-id user-id]
  (let [now (current-time-ms)
        expires-at (+ now lock-expiration-ms)]
    (swap! locks
           (fn [lock-map]
             (if-let [existing-lock (get lock-map document-id)]
               (if (expired? existing-lock)
                 ; Expired lock, can acquire
                 (do
                   (log/debug "Acquiring expired lock for document" document-id "user" user-id)
                   (assoc lock-map document-id {:user-id user-id :expires-at expires-at}))
                 ; Active lock
                 (if (= (:user-id existing-lock) user-id)
                   ; Same user, refresh
                   (do
                     (log/debug "Refreshing lock for document" document-id "user" user-id)
                     (assoc lock-map document-id {:user-id user-id :expires-at expires-at}))
                   ; Different user, conflict
                   (do
                     (log/debug "Lock conflict for document" document-id "held by" (:user-id existing-lock) "requested by" user-id)
                     lock-map)))
               ; No existing lock, acquire
               (do
                 (log/debug "Acquiring new lock for document" document-id "user" user-id)
                 (assoc lock-map document-id {:user-id user-id :expires-at expires-at})))))

    ; Determine the result
    (let [current-lock (get @locks document-id)]
      (cond
        (nil? current-lock) :conflict ; Someone else acquired it
        (not= (:user-id current-lock) user-id) :conflict
        (= expires-at (:expires-at current-lock)) :acquired ; New lock
        :else :refreshed)))) ; Refreshed existing lock

(defn release-lock!
  "Release a lock if held by the given user.
   Returns:
   - :released if lock was successfully released
   - :not-held if user didn't hold the lock"
  [document-id user-id]
  (let [released? (atom false)]
    (swap! locks
           (fn [lock-map]
             (if-let [existing-lock (get lock-map document-id)]
               (if (and (not (expired? existing-lock))
                        (= (:user-id existing-lock) user-id))
                 (do
                   (reset! released? true)
                   (log/debug "Releasing lock for document" document-id "user" user-id)
                   (dissoc lock-map document-id))
                 lock-map)
               lock-map)))
    (if @released? :released :not-held)))

(defn get-lock-info
  "Get information about a lock.
   Returns:
   - nil if no lock exists or lock is expired
   - {:user-id user-id :expires-at expires-at} if lock exists"
  [document-id]
  (when-let [lock-entry (get @locks document-id)]
    (when-not (expired? lock-entry)
      lock-entry)))

(defn check-document-locks
  "Check if the given user can proceed with operations on the given document IDs.
   Returns:
   - :ok if all documents are unlocked or locked by the user
   - {:conflict document-id user-id} if any document is locked by another user"
  [document-ids user-id]
  (sweep-expired-locks!)
  (let [conflicts (for [doc-id document-ids
                        :let [lock-info (get-lock-info doc-id)]
                        :when (and lock-info
                                   (not= (:user-id lock-info) user-id))]
                    {:document-id doc-id :user-id (:user-id lock-info)})]
    (if (empty? conflicts)
      :ok
      (first conflicts))))

(defn refresh-locks!
  "Refresh locks for the given document IDs if held by the user"
  [document-ids user-id]
  (doseq [doc-id document-ids]
    (when (get-lock-info doc-id)
      (acquire-lock! doc-id user-id))))

(defstate lock-cleanup-thread
  :start
  (let [executor (Executors/newScheduledThreadPool 1)
        cleanup-interval-seconds 30] ; Run cleanup every 30 seconds
    (log/info "Starting document lock cleanup thread")
    (.scheduleWithFixedDelay
     executor
     (fn []
       (try
         (let [cleaned-count (count (filter (comp expired? second) @locks))]
           (sweep-expired-locks!)
           (when (pos? cleaned-count)
             (log/debug "Cleaned up" cleaned-count "expired document locks")))
         (catch Exception e
           (log/error e "Error in lock cleanup thread"))))
     cleanup-interval-seconds
     cleanup-interval-seconds
     TimeUnit/SECONDS)
    executor)
  :stop
  (when lock-cleanup-thread
    (log/info "Stopping document lock cleanup thread")
    (.shutdown ^ScheduledExecutorService lock-cleanup-thread)))