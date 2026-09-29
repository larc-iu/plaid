(ns plaid.server.locks
  "Document locking system for ensuring atomicity of batch operations"
  (:require [mount.core :refer [defstate]]
            [plaid.server.config :refer [config]]
            [taoensso.timbre :as log])
  (:import [java.time Instant]))

;; Task #119: read at call time, not load time. The previous
;; `def ^:private lock-expiration-ms` was captured at namespace load,
;; which meant operators who tuned `:plaid.server.locks/config
;; :expiration-ms` AFTER namespace load (e.g. test fixtures binding
;; a fresh config, or a hot-reload that re-binds plaid.server.config)
;; would silently see the stale boot-time value. Reading from the
;; live config defstate at every `check-document-locks` /
;; `acquire-lock!` invocation makes the knob actually adjustable
;; without a full JVM restart.
(def ^:const default-lock-expiration-ms 60000)

(defn lock-expiration-ms
  "Resolve the current lock expiration window from the live config
  defstate. Falls back to `default-lock-expiration-ms` if the config
  is unbound (e.g. during a test that doesn't start the config
  defstate).

  Public because `GET /info` publishes the same number: a client that holds
  a lock has to know when it lapses, and the one it would otherwise assume
  was hard-coded in both clients."
  []
  (or (get-in config [:plaid.server.locks/config :expiration-ms])
      default-lock-expiration-ms))

;; Map of document-id -> {:lock-id lock-id :user-id user-id :expires-at instant}
;;
;; A lock belongs to one HOLDER, named by `:lock-id`, not to a user. Two
;; holders can share a user id: two assistant turns approving at once, or a
;; plan and a service run under one person's delegated token. When the lock
;; was keyed on the user alone, the second acquire was a refresh, both went
;; ahead, and the first to finish released the lock under the other. So an
;; acquire names a new holder and is refused while anyone holds the document,
;; and only the holder's id renews or releases it. Writes carry no lock id: a
;; write passes for the user who holds the lock and renews it, as before.
;;
;; The atom itself is held in a `defonce` (mount's `DerefableState`
;; doesn't implement IAtom, so it can't back a `swap!` directly). A
;; companion `defstate` (`lock-lifecycle`, below) participates in the
;; mount lifecycle and clears the atom on :start and :stop so test
;; fixtures that (mount/start)/(mount/stop) get a fresh empty lock
;; table per run — without it, locks acquired in one test would leak
;; into the next.
(defonce ^:private locks (atom {}))

;; Holder ids whose holder has released them, as {[user-id lock-id] spent-at-ms}.
;; A client that minted its id sends the acquire again when no answer came, so
;; an acquire held up in the network can reach the core after its retry took
;; the lock and the block released it, or after a block that never heard an
;; answer released what it might hold. Taking the free document then would
;; leave a lock nobody releases. An id released once never takes a lock again.
(defonce ^:private spent (atom {}))

;; An acquire and a release of one holder id can arrive together (a retry and
;; the release of a block that gave up). Taken under one monitor, the release
;; either finds the lock the acquire took and releases it, or spends the id
;; before the acquire looks.
(defonce ^:private acquire-release-monitor (Object.))

(defn- spent-window-ms
  "How long a released id is remembered: ten lock windows, far longer than
  any acquire stays in flight."
  []
  (* 10 (lock-expiration-ms)))

(defstate ^:private lock-lifecycle
  :start (do (reset! locks {}) (reset! spent {}) :ready)
  :stop (do (reset! locks {}) (reset! spent {}) :stopped))

(defn- current-time-ms []
  (.toEpochMilli (Instant/now)))

(defn- expired-at? [lock-entry now]
  (< (:expires-at lock-entry) now))

(defn- expired? [lock-entry]
  (expired-at? lock-entry (current-time-ms)))

(defn cleanup-expired-locks!
  "Remove expired locks from the system"
  []
  (swap! locks
         (fn [lock-map]
           (into {}
                 (remove (fn [[_ lock-entry]]
                           (expired? lock-entry))
                         lock-map)))))

(defn new-lock-id
  "A fresh holder id. It is the only thing that renews or releases the lock it
  names, so it goes back to the holder alone and is never shown to others."
  []
  (str (random-uuid)))

(defn- holds? [lock-entry user-id lock-id]
  (and (= (:lock-id lock-entry) lock-id)
       (= (:user-id lock-entry) user-id)))

(defn acquire-lock!
  "Take the lock on `document-id` for the holder `lock-id`, acting as `user-id`.
  Without a `lock-id` the acquire is a new holder with a fresh id.

  Returns:
   - :acquired if the document was free (or its lock had expired), and is now
     held by `lock-id`
   - :refreshed if `lock-id` already held it, which extends it
   - :conflict if another holder has it, whatever its user. The same user
     acquiring again is a second holder and is refused.
   - :lapsed if this holder already released `lock-id`: a late acquire under
     a spent id takes nothing."
  ([document-id user-id]
   (acquire-lock! document-id user-id (new-lock-id)))
  ([document-id user-id lock-id]
   (let [now (current-time-ms)
         expires-at (+ now (lock-expiration-ms))
         [spent? before]
         (locking acquire-release-monitor
           (let [spent? (contains? @spent [user-id lock-id])
                 [before _]
                 (swap-vals! locks
                             (fn [lock-map]
                               (let [existing-lock (get lock-map document-id)]
                                 (if (and (not spent?)
                                          (or (nil? existing-lock)
                                              (expired-at? existing-lock now)
                                              (holds? existing-lock user-id lock-id)))
                                   (assoc lock-map document-id {:lock-id lock-id
                                                                :user-id user-id
                                                                :expires-at expires-at})
                                   lock-map))))]
             [spent? before]))
         previous-lock (get before document-id)
         free? (or (nil? previous-lock) (expired-at? previous-lock now))
         result (cond
                  (and (not free?) (not (holds? previous-lock user-id lock-id))) :conflict
                  spent? :lapsed
                  free? :acquired
                  :else :refreshed)]
     (case result
       :lapsed (log/debug "Refused an acquire under a released holder id for document" document-id
                          "user" user-id)
       :acquired (log/debug "Acquired lock for document" document-id "user" user-id)
       :refreshed (log/debug "Refreshed lock for document" document-id "user" user-id)
       :conflict (log/debug "Lock conflict for document" document-id
                            "held by" (:user-id previous-lock) "requested by" user-id))
     result)))

(defn renew-lock!
  "Extend the lock on `document-id` that the holder `lock-id`, acting as
  `user-id`, still holds.

  Unlike an acquire, a renewal never takes a free document. Once a holder's
  lock has expired or been dropped (by an admin, say), somebody else may have
  written in between, even have taken and released the lock, and the work
  that planned its writes from an earlier read has to hear that rather than
  carry on under a lock taken again in silence.

  Returns:
   - :refreshed if `lock-id` holds the live lock, which is now extended
   - :conflict if another holder has it, whatever its user
   - :lapsed if nobody holds it live: this holder's lock expired or was
     dropped"
  [document-id user-id lock-id]
  (let [now (current-time-ms)
        expires-at (+ now (lock-expiration-ms))
        [before _]
        (swap-vals! locks
                    (fn [lock-map]
                      (let [existing-lock (get lock-map document-id)]
                        (if (and existing-lock
                                 (not (expired-at? existing-lock now))
                                 (holds? existing-lock user-id lock-id))
                          (assoc-in lock-map [document-id :expires-at] expires-at)
                          lock-map))))
        previous-lock (get before document-id)
        result (cond
                 (or (nil? previous-lock) (expired-at? previous-lock now)) :lapsed
                 (holds? previous-lock user-id lock-id) :refreshed
                 :else :conflict)]
    (log/debug "Renewing lock for document" document-id "user" user-id ":" result)
    result))

(defn- release-held! [document-id user-id lock-id]
  (let [released? (atom false)]
    (swap! locks
           (fn [lock-map]
             (if-let [existing-lock (get lock-map document-id)]
               (if (and (not (expired? existing-lock))
                        (holds? existing-lock user-id lock-id))
                 (do
                   (reset! released? true)
                   (log/debug "Releasing lock for document" document-id "user" user-id)
                   (dissoc lock-map document-id))
                 lock-map)
               lock-map)))
    (if @released? :released :not-held)))

(defn release-lock!
  "Release a lock if it is held by the holder `lock-id` acting as `user-id`.
   Returns:
   - :released if lock was successfully released
   - :not-held if that holder didn't hold the lock
  Either way the id is spent: an acquire under it later takes nothing."
  [document-id user-id lock-id]
  ;; Spent whether or not it holds the lock now: a release can overtake the
  ;; acquire it follows, which must then take nothing.
  (locking acquire-release-monitor
    (let [now (current-time-ms)
          window (spent-window-ms)]
      (swap! spent (fn [m]
                     (assoc (into {} (remove (fn [[_ at]] (< (+ at window) now))) m)
                            [user-id lock-id] now))))
    (release-held! document-id user-id lock-id)))

(defn get-lock-info
  "Get information about a lock.
   Returns:
   - nil if no lock exists or lock is expired
   - {:lock-id lock-id :user-id user-id :expires-at expires-at} if lock exists.
     Only the holder is ever shown `:lock-id`."
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
  (cleanup-expired-locks!)
  (let [conflicts (for [doc-id document-ids
                        :let [lock-info (get-lock-info doc-id)]
                        :when (and lock-info
                                   (not= (:user-id lock-info) user-id))]
                    {:document-id doc-id :user-id (:user-id lock-info)})]
    (if (empty? conflicts)
      :ok
      (first conflicts))))

(defn refresh-locks!
  "Extend the live locks on the given document IDs that `user-id` holds. A
  write carries no lock id, so this is the user's write renewing their own
  holder's lock, which keeps its id."
  [document-ids user-id]
  (let [now (current-time-ms)
        expires-at (+ now (lock-expiration-ms))]
    (swap! locks
           (fn [lock-map]
             (reduce (fn [m doc-id]
                       (let [existing-lock (get m doc-id)]
                         (if (and existing-lock
                                  (not (expired-at? existing-lock now))
                                  (= (:user-id existing-lock) user-id))
                           (assoc-in m [doc-id :expires-at] expires-at)
                           m)))
                     lock-map
                     document-ids)))
    nil))

(defn list-locks
  "Every live lock, as `{:document-id :user-id :expires-at}` maps. Expired
  entries are swept first, so what comes back is what is actually holding a
  document right now.

  Read-only view for the admin panel. A document that will not accept a write
  because someone else has it open is otherwise invisible: the writer sees a
  409 naming a user id and nothing else can see it at all."
  []
  (cleanup-expired-locks!)
  (mapv (fn [[document-id {:keys [user-id expires-at]}]]
          {:document-id document-id
           :user-id     user-id
           :expires-at  expires-at})
        @locks))

(defn force-release!
  "Drop the lock on `document-id` whoever holds it. Returns :released or
  :not-held.

  `release-lock!` refuses unless the caller is the holder, which is right for
  the lock protocol and useless for the case this exists for: a client that
  went away without releasing, leaving a document unwritable for the rest of
  the expiration window. The lock is advisory and expires on its own within
  a minute by default, so this only ever shortens a wait."
  [document-id]
  (let [[before _] (swap-vals! locks #(dissoc % document-id))]
    (if (contains? before document-id)
      (do (log/info "Force-released lock for document" document-id)
          :released)
      :not-held)))

(defn reset-state!
  "Test-helper: wipe the entire in-memory lock table. Task #113.

  The locks atom is `defonce`-d so a deftest that acquired a lock
  earlier in the run (typical for batch / OCC integration tests) would
  otherwise carry it into the next deftest's setup, breaking test-order
  independence. Called from `plaid.fixtures/with-clean-db` (and any
  per-test reset hook that wants a fresh lock-table)."
  []
  (reset! locks {})
  (reset! spent {}))
