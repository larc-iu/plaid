(ns plaid.rest-api.v1.rate-limit
  "Sliding-window rate limiter for the login endpoint, with two buckets:

  1. Per-(IP, username): 10 failures / 15 min — catches password-guessing
     against a single account from a given client.

  2. Per-IP (task #111): 100 failures / 15 min — catches credential
     spray, where an attacker rotates the username on every attempt so
     no single per-(IP, username) bucket ever fills. Without this
     bucket, a single hostile IP can keep hammering /login indefinitely
     as long as it never repeats a username.

  Either bucket exceeded → 429. We bucket FAILED login attempts only —
  successful logins clear the per-(IP, username) bucket (but NOT the
  per-IP one; we still want a noisy IP to be throttled regardless of
  any individual success).

  Storage: two in-process atoms. Good enough for a single-node
  deployment; if/when we scale horizontally this needs to move to
  SQLite or Redis.

  Eviction: every recorded attempt sweeps any bucket whose newest
  timestamp is older than the window. Additionally each atom is hard-
  capped at `max-bucket-entries` (50K) — on overflow we evict the
  bucket with the OLDEST newest-timestamp, which is the closest cheap
  approximation of LRU we can run inside a swap! function."
  (:require [mount.core :as mount :refer [defstate]]))

(def ^:private window-ms (* 15 60 1000))
(def ^:private max-failures 10)
(def ^:private max-ip-failures
  "Per-IP failure cap (#111). Set deliberately well above the per-(IP,
  username) limit so a single legitimate user mistyping their password
  on a shared corporate NAT can't lock out their whole office."
  100)
(def ^:private max-bucket-entries
  "Hard cap on the size of each bucket map. Prevents an attacker who
  rotates BOTH IP and username from growing the maps without bound."
  50000)

(defstate ^{:doc "Map of [ip user] -> vector of failure timestamps (ms)."}
  attempt-buckets
  :start (atom {})
  :stop (reset! attempt-buckets {}))

(defstate ^{:doc "Map of ip -> vector of failure timestamps (ms). #111."}
  ip-buckets
  :start (atom {})
  :stop (reset! ip-buckets {}))

(defonce ^{:private true
           :doc "Fallback atom used when mount hasn't started the defstate
                 yet — keeps tests that don't run (mount/start) (current
                 plaid.fixtures behavior, pending #98) from blowing up
                 inside the limiter. Production paths go through
                 `attempt-buckets` directly."}
  fallback-atom (atom {}))

(defonce ^{:private true
           :doc "Fallback atom for `ip-buckets` (#111)."}
  fallback-ip-atom (atom {}))

(defn- buckets-atom
  "Return whichever atom is live for this caller — the mount-started
  one if available, otherwise the test-only fallback. After
  `(mount/start)` the var holds the bare atom directly; before start
  it holds a `DerefableState` that throws on swap!."
  []
  (if (instance? clojure.lang.IAtom attempt-buckets)
    attempt-buckets
    fallback-atom))

(defn- ip-buckets-atom
  []
  (if (instance? clojure.lang.IAtom ip-buckets)
    ip-buckets
    fallback-ip-atom))

(defn- prune-bucket
  "Drop timestamps older than `now - window-ms` from a single bucket
  vector. Returns nil if the bucket is empty after pruning so the
  caller can dissoc the key."
  [now bucket]
  (let [cutoff (- now window-ms)
        kept (filterv #(> % cutoff) bucket)]
    (when (seq kept) kept)))

(defn- prune-all!
  "Walk every bucket once and drop empties. Cheap when the map is
  small; if it grows we can switch to a periodic timer."
  [m now]
  (reduce-kv (fn [acc k v]
               (if-let [pruned (prune-bucket now v)]
                 (assoc acc k pruned)
                 acc))
             {}
             m))

(defn- enforce-size-cap
  "If `m` is over the entry cap, evict the bucket whose newest timestamp
  is oldest — best cheap LRU approximation we can do inside a swap!.
  The fresh-write key `k` is preserved (we never evict the bucket we're
  in the process of incrementing)."
  [m k]
  (if (<= (count m) max-bucket-entries)
    m
    (let [victim (->> (dissoc m k)
                      (sort-by (fn [[_ ts]] (apply max ts)))
                      ffirst)]
      (if victim
        (dissoc m victim)
        m))))

(defn- client-ip
  "Best-effort client IP. We don't trust X-Forwarded-For here — if a
  proxy fronts the server, the operator should configure the proxy to
  set :remote-addr on the request."
  [request]
  (or (:remote-addr request) "unknown"))

(defn- bucket-key [request username]
  [(client-ip request) (or username "<no-user>")])

(defn- bucket-count-live
  "Count of live (within-window) entries in bucket `b` at time `now`.
  Returns 0 if the bucket is empty or fully expired."
  [now b]
  (count (or (prune-bucket now b) [])))

(defn over-limit?
  "True iff EITHER the per-(ip, username) bucket OR the per-ip bucket
  already exceeds its threshold inside the rolling window.

  Per-(ip, username) catches focused password-guessing; per-ip catches
  credential spray (rotating usernames) — see #111. We use OR rather
  than AND because either signal is enough to be suspicious."
  ([request username]
   (over-limit? request username (System/currentTimeMillis)))
  ([request username now]
   (let [user-bucket (clojure.core/get @(buckets-atom)
                                       (bucket-key request username)
                                       [])
         ip-bucket (clojure.core/get @(ip-buckets-atom)
                                     (client-ip request)
                                     [])]
     (or (>= (bucket-count-live now user-bucket) max-failures)
         (>= (bucket-count-live now ip-bucket) max-ip-failures)))))

(defn record-failure!
  "Record one failed login attempt against BOTH the per-(ip, username)
  bucket and the per-ip bucket. Also opportunistically prunes both
  global maps so they don't grow without bound, and applies the hard
  size cap on overflow."
  ([request username]
   (record-failure! request username (System/currentTimeMillis)))
  ([request username now]
   (let [k (bucket-key request username)
         ip (client-ip request)]
     (swap! (buckets-atom)
            (fn [m]
              (let [pruned (prune-all! m now)
                    bucket (clojure.core/get pruned k [])
                    next-m (assoc pruned k (conj bucket now))]
                (enforce-size-cap next-m k))))
     (swap! (ip-buckets-atom)
            (fn [m]
              (let [pruned (prune-all! m now)
                    bucket (clojure.core/get pruned ip [])
                    next-m (assoc pruned ip (conj bucket now))]
                (enforce-size-cap next-m ip)))))))

(defn clear!
  "Clear the (ip, username) bucket on successful login so a momentarily
  forgetful user isn't locked out moments after getting in.

  Deliberately does NOT clear the per-ip bucket: a noisy IP stays under
  scrutiny even after one of the accounts it's targeting finally logs
  in (otherwise an attacker who guesses one account's password could
  use that single success to wipe their spray history)."
  [request username]
  (let [k (bucket-key request username)]
    (swap! (buckets-atom) dissoc k)))

(defn reset-all!
  "Test hook — clear every bucket (both per-(ip,user) and per-ip) so
  one test's failed-login spam can't leak into the next via the shared
  fallback atoms."
  []
  (reset! (buckets-atom) {})
  (reset! (ip-buckets-atom) {}))

(defn wrap-login-rate-limit
  "Reitit middleware: short-circuit with 429 once EITHER the per-(IP,
  username) bucket OR the per-IP bucket (#111) is full. Body parsing
  has already happened by the time this runs (it sits inside the route
  stack), so we can read the username off `:parameters`. The handler is
  still responsible for calling `record-failure!` on a 4xx auth failure
  and `clear!` on success."
  [handler]
  (fn [request]
    (let [user-id (get-in request [:parameters :body :user-id])]
      (if (over-limit? request user-id)
        {:status 429
         :body {:error "Too many login attempts, retry later"}}
        (handler request)))))
