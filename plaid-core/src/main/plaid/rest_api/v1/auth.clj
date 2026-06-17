(ns plaid.rest-api.v1.auth
  "Implements JWT-based authentication and provides authorization middleware."
  (:require [buddy.hashers :as hashers]
            [buddy.sign.jwt :as jwt]
            [plaid.rest-api.v1.rate-limit :as rl]
            [plaid.server.config :refer [config]]
            [plaid.sql.api-token :as api-token]
            [plaid.sql.common :as psc]
            [plaid.sql.operation :as op]
            [plaid.sql.project :as prj]
            [plaid.sql.user :as user]
            [plaid.sql.vocab-layer :as vocab]
            [taoensso.timbre :as log]))

(def ^:private default-jwt-ttl-seconds
  "Default JWT lifetime: 30 days. Used when `config` doesn't override.
  30 days matches the prior implicit horizon (the old
  `password_changes` check could keep any token valid forever until
  the user changed their password). Operators can override via
  `:plaid.auth :jwt-ttl-seconds` in config (#117)."
  (* 60 60 24 30))

(defn jwt-ttl-seconds
  "Lookup the configured JWT TTL (#117). Read at call time rather than
  captured at load so tests/operators can swap config without a
  restart. Falls back to `default-jwt-ttl-seconds` (30 days) if the
  key is absent — preserves prior behavior on an un-tuned config."
  []
  (get-in config [:plaid.auth :jwt-ttl-seconds] default-jwt-ttl-seconds))

(defn- exp-seconds
  "Compute the JWT `exp` claim in unix seconds. Buddy verifies `exp`
  automatically on `unsign` — we just have to include the claim."
  []
  (+ (quot (System/currentTimeMillis) 1000) (jwt-ttl-seconds)))

(defn- sign-user-token
  "Issue a JWT for `id`. Centralized so the /login handler and any
  future re-issue paths (e.g. session refresh) produce identically
  shaped tokens — `:exp` in particular is easy to forget."
  [secret-key id password-changes]
  (jwt/sign {:user/id id
             :version password-changes
             :exp (exp-seconds)}
            secret-key))

(defn- sign-api-token
  "Issue a JWT for a named API token. Unlike `sign-user-token` this carries:
   - NO `:exp` — API tokens live until explicitly revoked (revocation is the
     `api_tokens.revoked_at` check in `wrap-read-jwt`, not an expiry);
   - NO `:version` — they deliberately survive the user's password changes
     and /logout (both bump `password_changes`), so a machine service doesn't
     break when the human re-authenticates.
  The `:token/id` claim is what `wrap-read-jwt` keys on to take the API-token
  validation branch; it equals `api_tokens.id`."
  [secret-key user-id token-id]
  (jwt/sign {:user/id user-id
             :token/id token-id
             :token/api? true}
            secret-key))

(defn issue-api-token!
  "Mint + persist a named API token and return the signed JWT — the ONLY time
  the signed credential is ever produced (show-once). `owner` is the user the
  token belongs to; `acting-user-id` is who performed the mint (the owner, or
  an admin acting on their behalf). Returns
  `{:success true :id <token-id> :name <name> :token <jwt>}` on success, or
  the underlying op's `{:success false :code :error}` on failure."
  [db secret-key owner name acting-user-id]
  (let [{:keys [success extra] :as result} (api-token/create! db owner name acting-user-id)]
    (if success
      {:success true
       :id extra
       :name name
       :token (sign-api-token secret-key owner extra)}
      result)))

(def authentication-routes
  ["/login"
   {:post {:summary (str "Authenticate with a <body>user-id</body> and <body>password</body> and get a JWT token. The token should be included "
                         "in request headers under \"Authorization: Bearer ...\" in order to prove successful "
                         "authentication to the server.")
           :middleware [rl/wrap-login-rate-limit]
           :parameters {:body {:user-id string? :password string?}}
           :handler (fn [{{{:keys [user-id password]} :body} :parameters
                          db :db secret-key :secret-key :as request}]
                      ;; Return the same generic error in all branches to avoid
                      ;; leaking which usernames exist (user-enumeration via
                      ;; login) — including the deactivated case, which must be
                      ;; indistinguishable from a wrong password.
                      (if-let [{:user/keys [id password-changes password-hash deactivated-at]} (user/get-internal db user-id)]
                        (if (and (hashers/check password password-hash)
                                 (nil? deactivated-at))
                          (let [token (sign-user-token secret-key id password-changes)]
                            ;; Successful login clears the rate-limit
                            ;; bucket — an occasional typo shouldn't lock
                            ;; out a legitimate user moments after they
                            ;; finally get in.
                            (rl/clear! request user-id)
                            {:status 200
                             :body {:token token}})
                          (do (rl/record-failure! request user-id)
                              {:status 401
                               :body {:error "Invalid credentials"}}))
                        (do (rl/record-failure! request user-id)
                            {:status 401
                             :body {:error "Invalid credentials"}})))}}])

(defn ->user-id [request]
  (-> request :jwt-data :user/id))

(defn- bump-password-changes!
  "Invalidate all tokens for `user-id` by incrementing the
  password_changes counter. Wraps the SQL in a normal
  submit-operation! so it's audited like a real user/update — the
  audit row will show the counter change but no password change,
  which is exactly the right reading of /logout."
  [db user-id]
  (op/submit-operation!
   [tx db {:type :user/logout
           :project nil
           :document nil
           :description (str "Logout user " user-id)
           :user user-id}]
   (let [intern (user/get-internal tx user-id)]
     (when (some? intern)
       (let [next-counter (inc (or (:user/password-changes intern) 0))]
         (psc/update-by-id! tx :users user-id {:password_changes next-counter}))))))

(def logout-routes
  ["/logout"
   {:post {:summary (str "Invalidate all JWTs for the currently authenticated user by "
                         "bumping the per-user password_changes counter (the same "
                         "mechanism a password change uses). Subsequent requests with "
                         "the old token will be rejected with 401.")
           ;; #120 — important behavioral note for API clients:
           ;;
           ;; Logout invalidates ALL of the user's live tokens across EVERY
           ;; device they're currently signed in on, not just the device that
           ;; made this request. The mechanism is a bump to the per-user
           ;; `password_changes` counter (the same counter a real password
           ;; change uses); every JWT in circulation embeds the counter value
           ;; it was issued with as its `:version` claim, and
           ;; `wrap-read-jwt` rejects any token whose `:version` doesn't
           ;; match the user's current `password_changes`. So one logout
           ;; logs out every browser tab, every mobile app, every CLI
           ;; session. There is no current-device-only variant.
           :handler (fn [{db :db user-id :user/id}]
                      (let [intern (user/get-internal db user-id)]
                        (if (nil? intern)
                          ;; Token validated against a now-deleted user
                          ;; — nothing to bump, treat as already logged out.
                          {:status 204 :body nil}
                          (let [result (bump-password-changes! db user-id)]
                            (if (:success result)
                              {:status 204 :body nil}
                              (do (log/error "Logout failed for" user-id ":" (:error result))
                                  {:status 500 :body {:error "Internal error"}}))))))}}])

(defn wrap-read-jwt
  "Reitit middleware that looks for JWT tokens in either:
  1. \"Authorization: Bearer ...\" header (standard approach)
  2. \"token\" query parameter (for EventSource compatibility)

  On success, token data is stored in the request map under :jwt-data."
  [handler]
  (fn [{:keys [db] :as request}]
    (let [secret-key (:secret-key request)
          auth-header (get-in request [:headers "authorization"])
          query-token (get-in request [:query-params "token"])]
      (cond (nil? secret-key)
            (do (log/error "Secret key not found in request! Are middlewares properly ordered?" nil)
                {:status 500 :body {:error (str "Improperly configured server. Contact admin.")}})

            ;; No auth header and no query token
            (and (or (nil? auth-header) (not (.startsWith auth-header "Bearer ")))
                 (nil? query-token))
            (handler request)

            :else
            (let [token (cond
                          ;; Prefer header if available
                          (and auth-header (.startsWith auth-header "Bearer "))
                          (subs auth-header 7)

                          ;; Fall back to query parameter
                          query-token
                          query-token

                          :else nil)
                  token-data (try (jwt/unsign token secret-key)
                                  (catch Exception e e))
                  ;; An API token carries a `:token/id` claim; a session token
                  ;; does not. The two diverge on revocation: session tokens
                  ;; ride `password_changes`, API tokens ride the
                  ;; `api_tokens.revoked_at` row (and survive password changes).
                  api-token-id (and (map? token-data) (:token/id token-data))
                  user (and (map? token-data) (user/get-internal db (:user/id token-data)))
                  proceed (fn []
                            ;; Don't log the JWT itself (token-data carries the
                            ;; claims). Don't log the raw `token` string either —
                            ;; even a partial prefix is enough to weaken
                            ;; signatures, and the JWT shows up in `request` shapes
                            ;; that wrap-logging already redacts.
                            (log/debug (str "Authenticated user " (:user/id token-data)
                                            (when api-token-id (str " via API token " api-token-id))
                                            " (source: "
                                            (if (and auth-header (.startsWith auth-header "Bearer "))
                                              "header" "query")
                                            ")"))
                            (handler (cond-> (assoc request
                                                    :jwt-data token-data
                                                    :user/id (:user/id token-data)
                                                    :user/record (select-keys user [:user/id :user/username :user/is-admin]))
                                       ;; Server-authoritative attribution: the
                                       ;; validated claim, not client input.
                                       ;; wrap-api-token-id binds this onto the
                                       ;; operations row.
                                       api-token-id (assoc :api-token/id api-token-id))))]
              (cond
                (instance? Exception token-data)
                ;; Log just the message — a rejected token is routine (expired,
                ;; tampered, wrong secret) and not worth a full stack trace.
                (do (log/warn "JWT validation failed:" (.getMessage ^Exception token-data))
                    {:status 401
                     :body {:error (str "Token invalid. Obtain a new token.")}})

                (nil? user)
                {:status 401
                 :body {:error (str "Token invalid because user does not exist.")}}

                ;; Deactivated users are rejected on BOTH token kinds.
                ;; Deactivation also bumps password_changes and revokes the
                ;; user's API tokens, but this check is the authority — it
                ;; holds even if a future write path forgets one of those.
                (some? (:user/deactivated-at user))
                {:status 401
                 :body {:error (str "Token invalid because user is deactivated.")}}

                ;; API-token branch: revocation/existence is the only check.
                ;; Skips the `password_changes` version check entirely so the
                ;; token survives the owner's password rotation and /logout.
                api-token-id
                (if (api-token/active? db api-token-id)
                  (proceed)
                  {:status 401
                   :body {:error (str "Token revoked or unknown.")}})

                ;; Session-token branch: invalidated by any password_changes bump.
                (not= (:version token-data)
                      (:user/password-changes user))
                {:status 401
                 :body {:error (str "Token invalid because password has changed.")}}

                :else
                (proceed)))))))

(defn wrap-login-required [handler]
  (fn [request]
    (if-not (->user-id request)
      ;; 401, not 403: the request carries no valid authenticated identity
      ;; (no token, or a token wrap-read-jwt passed through as absent). That
      ;; is an AUTHENTICATION failure — same class as the 401 wrap-read-jwt
      ;; returns for a malformed/expired token. 403 is reserved for an
      ;; authenticated user who lacks permission (admin/reader/writer/etc).
      {:status 401
       :body {:error "Valid token required for this operation."}}
      (handler request))))

(defn wrap-admin-required [handler]
  (fn [request]
    (if-not (user/admin? (:user/record request))
      {:status 403
       :body {:error "Admin privileges required for this operation."}}
      (handler request))))

(defn wrap-user-directory-access
  "Allows reading the user directory (list/search) to admins OR any user who
  maintains at least one project OR at least one vocab layer — maintainers need
  it to find users to grant project/vocab access. Everyone else gets 403 (the
  roster stays unenumerable for ordinary readers/writers; see the
  account-enumeration note on the list route)."
  [handler]
  (fn [request]
    (if (or (user/admin? (:user/record request))
            (prj/maintainer-of-any? (:db request) (->user-id request))
            (vocab/maintainer-of-any? (:db request) (->user-id request)))
      (handler request)
      {:status 403
       :body {:error "Listing users requires admin or project/vocab-maintainer privileges."}})))

(def ^:private levels
  {:project/readers [:project/readers :project/writers :project/maintainers]
   :project/writers [:project/writers :project/maintainers]
   :project/maintainers [:project/maintainers]})

(def ^:private verb
  {:project/readers "read"
   :project/writers "write for"
   :project/maintainers "maintain"})

(defn wrap-project-privileges-required
  [handler key get-project-id]
  (when-not (-> levels keys set key)
    (throw (ex-info "Bad key" {:key key})))
  (fn [{db :db :as request}]
    (let [user-id (->user-id request)
          ;; Forward :as-of-ts so doc-scoped `get-project-id` resolvers
          ;; can fall through to audit-log reconstruction when the doc has
          ;; been deleted from OLTP but existed at `ts`. ACL membership is
          ;; still resolved from CURRENT OLTP (`prj/get db id` below) —
          ;; historical-ACL is explicitly out of scope; only the
          ;; doc→project lookup is allowed to time-travel.
          id (get-project-id {:parameters (:parameters request)
                              :db db
                              :as-of-ts (:as-of-ts request)})
          admin? (user/admin? (:user/record request))
          project (prj/get db id)]
      (if-not (or admin? (some #(seq ((-> project % set) user-id)) (key levels)))
        {:status 403
         :body {:error (str "User " user-id " lacks sufficient privileges to " (key verb) " project " id)}}
        (handler request)))))

(defn wrap-reader-required [handler get-project-id]
  (wrap-project-privileges-required handler :project/readers get-project-id))
(defn wrap-writer-required [handler get-project-id]
  (wrap-project-privileges-required handler :project/writers get-project-id))
(defn wrap-maintainer-required [handler get-project-id]
  (wrap-project-privileges-required handler :project/maintainers get-project-id))

(defn wrap-vocab-maintainer-required
  "Requires that the user is a maintainer of the vocab layer or an admin."
  [handler get-vocab-id]
  (fn [{db :db :as request}]
    (let [user-id (->user-id request)
          vocab-id (get-vocab-id {:parameters (:parameters request)
                                  :db db})
          admin? (user/admin? (:user/record request))
          maintainer? (and vocab-id
                           (vocab/maintainer? db vocab-id user-id))]
      (if-not (or admin? maintainer?)
        {:status 403
         :body {:error (str "User " user-id " lacks maintainer privileges for vocab layer " vocab-id)}}
        (handler request)))))

(defn wrap-vocab-reader-required
  "Requires that the user has read access to the vocab layer through a project or is a maintainer/admin."
  [handler get-vocab-id]
  (fn [{db :db :as request}]
    (let [user-id (->user-id request)
          vocab-id (get-vocab-id {:parameters (:parameters request)
                                  :db db})
          admin? (user/admin? (:user/record request))
          maintainer? (and vocab-id
                           (vocab/maintainer? db vocab-id user-id))
          accessible? (and vocab-id
                           (vocab/accessible-through-project? db vocab-id user-id))]
      (if-not (or admin? maintainer? accessible?)
        {:status 403
         :body {:error (str "User " user-id " lacks read access to vocab layer " vocab-id)}}
        (handler request)))))

(defn wrap-vocab-writer-required
  "Requires that the user has write access to vocab items through a project or is a maintainer/admin."
  [handler get-vocab-id]
  (fn [{db :db :as request}]
    (let [user-id (->user-id request)
          vocab-id (get-vocab-id {:parameters (:parameters request)
                                  :db db})
          admin? (user/admin? (:user/record request))
          maintainer? (and vocab-id
                           (vocab/maintainer? db vocab-id user-id))
          write-accessible? (and vocab-id
                                 (vocab/write-accessible-through-project? db vocab-id user-id))]
      (if-not (or admin? maintainer? write-accessible?)
        {:status 403
         :body {:error (str "User " user-id " lacks write access to vocab layer " vocab-id)}}
        (handler request)))))


