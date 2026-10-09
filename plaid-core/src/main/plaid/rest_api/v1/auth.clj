(ns plaid.rest-api.v1.auth
  "Implements JWT-based authentication and provides authorization middleware."
  (:require [buddy.hashers :as hashers]
            [plaid.rest-api.v1.schema :as schema]
            [buddy.sign.jwt :as jwt]
            [clojure.string :as str]
            [plaid.query.ast :as ast]
            [plaid.rest-api.v1.rate-limit :as rl]
            [plaid.server.config :refer [config]]
            [plaid.server.log-buffer :as log-buffer]
            [plaid.sql.api-token :as api-token]
            [plaid.sql.common :as psc]
            [plaid.sql.crud :as crud]
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

(def ^:private dummy-password-hash
  "A valid bcrypt+sha512 hash used when a login names no existing user.
  Checking it keeps the missing-user path computationally comparable to the
  real-user path, so response timing does not disclose account existence."
  "bcrypt+sha512$9c3cd2a5ac65c3f01d2b83d66efdd574$12$8908f8fa4e503e77625eb8101a2d2b9d95b2fe7f9124eb37")

(defn jwt-ttl-seconds
  "Lookup the configured JWT TTL (#117). Read at call time rather than
  captured at load so tests/operators can swap config without a
  restart. Falls back to `default-jwt-ttl-seconds` (30 days) if the
  key is absent — preserves prior behavior on an un-tuned config."
  []
  (get-in config [:plaid.auth :jwt-ttl-seconds] default-jwt-ttl-seconds))

(def ^:private default-delegated-token-ttl-seconds
  "Default lifetime of a delegated token (see `issue-delegated-token!`):
  one hour. Long enough for a service to finish the work a user handed it,
  short enough that a leaked one is a bounded problem."
  (* 60 60))

(defn delegated-token-ttl-seconds
  "Lookup the configured delegated-token TTL (`:plaid.auth
  :delegated-token-ttl-seconds`), read at call time like `jwt-ttl-seconds`."
  []
  (get-in config [:plaid.auth :delegated-token-ttl-seconds] default-delegated-token-ttl-seconds))

(defn- exp-seconds
  "Compute the JWT `exp` claim in unix seconds. Buddy verifies `exp`
  automatically on `unsign` — we just have to include the claim."
  ([] (exp-seconds (jwt-ttl-seconds)))
  ([ttl-seconds] (+ (quot (System/currentTimeMillis) 1000) ttl-seconds)))

(defn- sign-user-token
  "Issue a JWT for `id`. Centralized so the /login handler and any
  future re-issue paths (e.g. session refresh) produce identically
  shaped tokens — `:exp` in particular is easy to forget."
  ([secret-key id password-changes]
   (sign-user-token secret-key id password-changes (jwt-ttl-seconds)))
  ([secret-key id password-changes ttl-seconds]
   (sign-user-token secret-key id password-changes ttl-seconds nil))
  ([secret-key id password-changes ttl-seconds project-ids]
   (sign-user-token secret-key id password-changes ttl-seconds project-ids nil))
  ([secret-key id password-changes ttl-seconds project-ids runner]
   (jwt/sign (cond-> {:user/id id
                      :version password-changes
                      :exp (exp-seconds ttl-seconds)}
               ;; A scoped token: see the Scoped tokens section below. Its
               ;; `:jti` tells it apart from every other token of its user,
               ;; so it alone may relabel the operation groups it created.
               (some? project-ids) (assoc :scope/projects (vec project-ids)
                                          :jti (str (random-uuid)))
               ;; Who runs the service holding it, when that is someone else
               ;; (see `runner-reach`).
               (some? runner) (assoc :scope/runner runner))
             secret-key)))

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

(defn issue-session-token!
  "Sign a session JWT for `user-id`, reading the user's current
  `password_changes` so the `:version` claim matches (a mismatch is exactly
  what `wrap-read-jwt` rejects on). Returns nil if the user is missing.

  Public so invite redemption can hand back a live session: the redeemer
  just chose an email and password on the signup page, and bouncing them
  to a login form to retype both is a needless place to lose someone. This
  is the same token /login issues, by the same function that issues it."
  [db secret-key user-id]
  (when-let [account (user/get-internal db user-id)]
    (sign-user-token secret-key
                     (:user/id account)
                     (:user/password-changes account))))

(defn issue-delegated-token!
  "Sign a SHORT-LIVED session JWT for `user-id`, for a service to act on that
  user's behalf: the server mints one when a user submits work to a
  *delegating* service (see `plaid.rest-api.v1.message`) and hands it to the
  service inside the request, so everything the service does for that request
  runs under the requester's own permissions and is attributed to them in the
  audit log. It is a session token (rides `password_changes`, so a logout
  revokes it) with a `delegated-token-ttl-seconds` lifetime instead of the
  session default, and it is SCOPED to `project-ids`: core refuses it on every
  route outside those projects, admin and user routes included (see
  the Scoped tokens section below). A service is run by whoever connected it, so the token must
  not reach further than the request it was minted for. Returns nil if the
  user is missing.

  `not-after` is the `exp` of the credential the request came with, when it
  has one. The new token expires no later, so a token never mints one that
  outlives it: a delegated token that submits to a delegating service (its
  holder's own, say) cannot renew itself that way."
  ([db secret-key user-id project-ids]
   (issue-delegated-token! db secret-key user-id project-ids nil))
  ([db secret-key user-id project-ids not-after]
   (issue-delegated-token! db secret-key user-id project-ids not-after nil))
  ([db secret-key user-id project-ids not-after runner]
   (when-let [account (user/get-internal db user-id)]
     (sign-user-token secret-key
                      (:user/id account)
                      (:user/password-changes account)
                      (cond-> (delegated-token-ttl-seconds)
                        (number? not-after)
                        (min (- (long not-after) (quot (System/currentTimeMillis) 1000))))
                      (vec (distinct (map (comp str/lower-case str) project-ids)))
                      (when (and runner (not= runner (:user/id account))) runner)))))

;; ---------------------------------------------------------------------------
;; Link tokens
;; ---------------------------------------------------------------------------
;;
;; An `<img>`, `<video>` or `<audio>` element cannot send an Authorization
;; header, so a page that shows a profile picture or plays a recording puts
;; a credential in the URL. A session token there would land in access logs,
;; browser history and "Copy image address", so the URL carries a link token
;; instead: short-lived, good for one kind of resource and refused everywhere
;; else. Each kind is an audience (`:aud`):
;;
;; - "media" opens ONE document's recording, as `?media-token=` on GET
;;   `/documents/:id/media`.
;; - "avatar" opens any user's profile picture, as `?avatar-token=` on GET
;;   `/users/:id/avatar`. Every signed-in user may see every picture, so the
;;   token names no user.
;;
;; A route marks the audience it takes with `:plaid/link-token`, and
;; `wrap-read-jwt` reads that audience's parameter there and on no other
;; route. A link token is refused as a bearer or `?token=` credential on
;; every route, and on a route marked for another audience.

(def media-audience
  "The `:aud` claim of a media token."
  "media")

(def avatar-audience
  "The `:aud` claim of an avatar token."
  "avatar")

(def link-token-params
  "The query parameter that carries each audience's token on its route."
  {media-audience "media-token"
   avatar-audience "avatar-token"})

(def ^:private default-media-link-ttl-seconds
  "Default lifetime of a media link: six hours, long enough to listen through
  a long session with the page open."
  (* 6 60 60))

(def ^:private default-avatar-link-ttl-seconds
  "Default lifetime of an avatar token: a day. A picture's URL is its cache
  key, so a longer-lived token means fewer fetches of pictures already seen."
  (* 24 60 60))

(defn media-link-ttl-seconds
  "Lookup the configured media-link TTL (`:plaid.media/config
  :link-ttl-seconds`), read at call time like `jwt-ttl-seconds`."
  []
  (get-in config [:plaid.media/config :link-ttl-seconds] default-media-link-ttl-seconds))

(defn avatar-link-ttl-seconds
  "Lookup the configured avatar-token TTL (`:plaid.media/config
  :avatar-link-ttl-seconds`), read at call time like `jwt-ttl-seconds`."
  []
  (get-in config [:plaid.media/config :avatar-link-ttl-seconds] default-avatar-link-ttl-seconds))

(defn- issue-link-token!
  "Sign a link token for `user-id` with `audience`, `ttl-seconds` to live, and
  the extra `claims` its audience checks. It rides `password_changes` as a
  session token does, so a logout or a password change revokes it.
  `jwt-data` is the claims of the credential the request came with: the
  token expires no later than that credential (`not-after` as in
  `issue-delegated-token!`), a scoped caller's scope and runner travel with
  it so `wrap-read-jwt` narrows it the same way, and an API token's id
  travels with it, so revoking that token closes the link too. Returns
  `{:token :exp}` (`exp` in unix seconds), or nil if the user is missing."
  [db secret-key user-id audience ttl-seconds claims jwt-data]
  (when-let [account (user/get-internal db user-id)]
    (let [now (quot (System/currentTimeMillis) 1000)
          not-after (:exp jwt-data)
          exp (cond-> (+ now ttl-seconds)
                (number? not-after) (min (long not-after)))]
      {:exp exp
       :token (jwt/sign (cond-> (merge claims
                                       {:user/id (:user/id account)
                                        :version (:user/password-changes account)
                                        :exp exp
                                        :aud audience})
                          (:scope/projects jwt-data) (assoc :scope/projects (:scope/projects jwt-data))
                          (:scope/runner jwt-data) (assoc :scope/runner (:scope/runner jwt-data))
                          (:token/id jwt-data) (assoc :link/api-token (:token/id jwt-data)))
                        secret-key)})))

(defn issue-media-token!
  "Sign a media token for `user-id` that opens the recording of `document-id`
  and nothing else. See `issue-link-token!`."
  [db secret-key user-id document-id jwt-data]
  (issue-link-token! db secret-key user-id media-audience (media-link-ttl-seconds)
                     {:media/document (str/lower-case (str document-id))} jwt-data))

(defn issue-avatar-token!
  "Sign an avatar token for `user-id` that opens any user's profile picture
  and nothing else. See `issue-link-token!`."
  [db secret-key user-id jwt-data]
  (issue-link-token! db secret-key user-id avatar-audience (avatar-link-ttl-seconds) {} jwt-data))

(defn- link-claims?
  "Does `token-data` carry a link token's claims?"
  [token-data]
  (boolean (and (map? token-data)
                (or (contains? token-data :aud)
                    (contains? token-data :media/document)
                    (contains? token-data :link/api-token)))))

(defn- link-misuse-refusal
  "The refusal of a link token sent as a bearer or `?token=` credential."
  [token-data]
  (if (= avatar-audience (:aud token-data))
    "This token opens profile pictures only."
    "This token opens one recording only."))

(defn- link-route-audience
  "The audience whose link token the matched route takes for this method, or
  nil. A batch's operation never takes one: it is authenticated by the
  batch's own credential."
  [request]
  (when (nil? (get request log-buffer/sub-request-key))
    (let [audience (get-in request [:reitit.core/match :result (:request-method request)
                                    :data :plaid/link-token])]
      (when (contains? link-token-params audience) audience))))

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
   {:plaid/idempotency false
    :post {:summary (str "Authenticate with a <body>user-id</body> (the account's email address) and "
                         "<body>password</body> and get a JWT token. The token should be included "
                         "in request headers under \"Authorization: Bearer ...\" in order to prove successful "
                         "authentication to the server.")
           :middleware [rl/wrap-login-rate-limit]
           :parameters {:body {:user-id schema/user-id :password string?}}
           :handler (fn [{{{:keys [user-id password]} :body} :parameters
                          db :db secret-key :secret-key :as request}]
                      ;; Return the same generic error in all branches to avoid
                      ;; leaking which accounts exist (user-enumeration via
                      ;; login) — including the deactivated case, which must be
                      ;; indistinguishable from a wrong password.
                      (let [{:user/keys [id password-changes password-hash deactivated-at]
                             :as account} (user/get-internal db user-id)
                            ;; Always do one bcrypt check. Missing users use a
                            ;; fixed valid hash so they take the same expensive
                            ;; path as existing users with a wrong password.
                            password-valid? (hashers/check password
                                                           (if account
                                                             password-hash
                                                             dummy-password-hash))]
                        (if (and account password-valid? (nil? deactivated-at))
                          (let [token (sign-user-token secret-key id password-changes)]
                            ;; Successful login clears the rate-limit
                            ;; bucket — an occasional typo shouldn't lock
                            ;; out a legitimate user moments after they
                            ;; finally get in.
                            (rl/clear! request user-id)
                            ;; Name the account on the access line. Only here,
                            ;; on the success branch: a failed login must not
                            ;; put the id somebody typed next to `user=`, which
                            ;; reads as an account that authenticated.
                            (some-> ^clojure.lang.Volatile (get request log-buffer/identity-key)
                                    (vreset! {:user id}))
                            {:status 200
                             :body {:token token}})
                          (do (rl/record-failure! request user-id)
                              {:status 401
                               :body {:error "Invalid credentials"}}))))}}])

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
         (crud/update-by-id! tx :users user-id {:password_changes next-counter}))))))

(def logout-routes
  ["/logout"
   {:plaid/idempotency false
    :post {:summary (str "Invalidate all JWTs for the currently authenticated user by "
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

(def ^:private jwt-rejection-window-ms
  "How long one refused token stays quiet after the warning it earns. A client
  whose token has expired retries on a timer, and a warning per retry empties
  the 1000-entry event buffer of everything an operator came to it for. Every
  refusal still leaves its 401 in the request buffer."
  (* 5 60 1000))

(def ^:private jwt-rejection-cap
  "How many refused tokens are remembered at once. Past this the table is
  dropped whole rather than pruned: it is a noise filter, not a record, and
  the next refusal of each token simply warns again."
  256)

(defonce ^:private jwt-rejections
  (atom {}))

(defn reset-jwt-rejection-log!
  "Forget which tokens have already been warned about. For tests, which
  otherwise inherit each other's quiet windows."
  []
  (reset! jwt-rejections {}))

(defn- log-jwt-rejection!
  "Warn the first time a token is refused and once per window after that,
  debug in between. The token is never logged, only a hash of it: even a
  partial prefix of a JWT weakens the signature."
  [token ^Exception e]
  (let [k (hash token)
        now (System/currentTimeMillis)
        last-at (clojure.core/get @jwt-rejections k)
        message (str "JWT validation failed: " (.getMessage e))]
    (if (and last-at (<= (- now last-at) jwt-rejection-window-ms))
      (log/debug message)
      (do (swap! jwt-rejections
                 (fn [m] (assoc (if (>= (count m) jwt-rejection-cap) {} m) k now)))
          (log/warn message)))))

;; ---------------------------------------------------------------------------
;; Scoped tokens
;; ---------------------------------------------------------------------------
;;
;; A delegated token (`issue-delegated-token!`) carries `:scope/projects`, the
;; projects it was issued for. Whoever connected the service holds it, so it
;; must do no more than its user could do IN THOSE PROJECTS. The rule, and
;; where each part of it is enforced:
;;
;; - A token handed to a service someone else runs names that runner
;;   (`:scope/runner`), and reaches only the projects of its claim where the
;;   runner is still a maintainer, or every one if the runner is an admin
;;   (`runner-reach`, asked on every request). The submit handler refuses to
;;   mint one at all past that line (`runner-delegates?`, Luke 2026-10-08).
;; - `wrap-read-jwt` recognizes the claim, puts the scope on the request under
;;   `:auth/token-scope`, binds it to `*token-scope*` for the rest of the
;;   request, and hands the handlers a user record WITHOUT admin, so no
;;   handler's own `user/admin?` check lets the token past a project.
;; - The project gate (`holds-privilege?`, behind every `wrap-*-required` and
;;   `privileged?`) passes only on a project in scope. An admin counts as a
;;   maintainer there, and nowhere else.
;; - The vocab gates (`vocab-reader?`, `vocab-writer?`,
;;   `wrap-vocab-maintainer-required`) pass only on a vocabulary linked to a
;;   project in scope, the way a project's own readers reach it. The right
;;   itself is the usual one (admin, vocab maintainer, or the role on a
;;   project that links it), except that a role counts only on a project in
;;   scope.
;; - `token-scope-gate`, the innermost middleware of every login-required
;;   route, refuses the request unless one of those gates passed it, or the
;;   route names its own check under `:plaid/token-scope` (the query, the
;;   user's private data, the batch, relabelling an operation group the
;;   token's own writes created, reading the token's own user record). So a
;;   route with no project behind it
;;   (admin screens, users, tokens, invites, project creation, listings) is
;;   refused without having to be listed.
;; - A route that acts on a vocabulary as a whole carries
;;   `:plaid/vocabulary-admin` in its data: renaming or deleting the
;;   vocabulary, adding or removing its maintainers, linking it to or
;;   unlinking it from a project, restoring its entries, its config.
;;   `token-scope-gate` refuses a scoped token there whatever its user's
;;   rights, since such a change reaches every project the vocabulary is
;;   shared with and a maintainer grant outlasts the token (ruled 2026-09-27).
;;   Renaming, merging and deleting single entries stay open to it.
;; - A route behind the project maintainer gate (`wrap-maintainer-required`)
;;   refuses a scoped token the same way, whatever its user's rights: adding
;;   or removing members, renaming or deleting the project, its config and
;;   telemetry switch, creating, renaming, deleting or moving its layers,
;;   their config and constraints, and the maintainers' reads (the activity
;;   tally, the telemetry events). Whoever runs a delegating service holds
;;   the token, and a member grant or a deletion outlasts it (H9-ACL-1,
;;   2026-10-08). A maintainer action on one document carries
;;   `:plaid/document-maintainer` and stays open: restoring a document, which
;;   the assistants plan. A handler that asks `privileged?` for maintainer
;;   rights on a whole project refuses with `project-admin-refusal` itself.

(declare wrap-login-required wrap-maintainer-required)

(def ^:dynamic *token-scope*
  "The scope of the request being served when it came with a scoped token:
  `{:user-id :projects #{id} :token-key jti :admin? bool :passed (volatile! false)}`, nil
  otherwise. Bound by `wrap-read-jwt`. The vocab gates read it here because
  their callers pass a db and a user id rather than the request."
  nil)

(defn- token-projects
  "The project ids a token's claims scope it to, lower-cased, or nil for an
  unscoped token."
  [token-data]
  (when-let [ids (:scope/projects token-data)]
    (set (map (comp str/lower-case str) ids))))

(defn runner-delegates-among
  "The ids among `project-ids`, lower-cased, where the service run by
  `runner-id` may act for members other than its runner: all of them when
  the runner's account is active and an admin, those it maintains when it is
  active and not, none when it is gone or deactivated (Luke, 2026-10-08: a
  maintainer's service serves every writer). A writer's or a reader's
  service serves only its runner."
  [db runner-id project-ids]
  (let [ids (into #{} (map (comp str/lower-case str)) project-ids)
        account (some->> runner-id (user/get-internal db))]
    (cond
      (or (nil? account) (some? (:user/deactivated-at account))) #{}
      (user/admin? account) ids
      :else (prj/maintained-among db runner-id ids))))

(defn runner-delegates?
  "May the service run by `runner-id` receive delegated tokens for project
  `project-id`, that is, act there for members other than its runner? See
  `runner-delegates-among`."
  [db runner-id project-id]
  (contains? (runner-delegates-among db runner-id [project-id])
             (str/lower-case (str project-id))))

(defn- runner-reach
  "The projects of a scoped token's claims it reaches NOW. A token handed to
  a service its own user runs reaches all of them. One handed to a service
  someone else runs reaches only those where that runner still delegates
  (`runner-delegates-among`), asked on every request, so a runner demoted,
  removed or deactivated after the token was minted loses it at once. Two
  indexed reads whatever the number of projects, none past the first for an
  admin runner."
  [db token-data projects]
  (if-let [runner (:scope/runner token-data)]
    (runner-delegates-among db runner projects)
    projects))

(defn- in-scope?
  [scope project-id]
  (boolean (and project-id (contains? (:projects scope) (str/lower-case (str project-id))))))

(defn- scope-for
  "The scope that applies to a check about `user-id`: the request's, when the
  check is about the user the scoped token speaks for. A check about someone
  else (the member a route adds, the opener of a service channel) is not the
  token's to narrow."
  [user-id]
  (let [scope *token-scope*]
    (when (and scope (= user-id (:user-id scope)))
      scope)))

(defn- pass-scope!
  "Record that a gate let the scoped request through, and answer true."
  [scope]
  (vreset! (:passed scope) true)
  true)

(def ^:private scope-refusal
  {:status 403
   :body {:error "This token reaches only the projects it was issued for."}})

(def ^:private vocabulary-admin-refusal
  {:status 403
   :body {:error (str "A delegated token cannot rename or delete a vocabulary, change its maintainers "
                      "or settings, link or unlink it, or restore its entries.")}})

(def project-admin-refusal
  "The answer to a scoped token on a route that needs maintainer rights on a
  whole project. See \"Scoped tokens\" above."
  {:status 403
   :body {:error (str "A delegated token cannot change a project's members, name, settings or layers, "
                      "delete it, or read its activity tally or telemetry.")}})

(defn- project-maintainer-gated?
  "Does route `data` sit behind the project maintainer gate, without marking
  itself a maintainer action on one document?"
  [data]
  (and (not (:plaid/document-maintainer data))
       (boolean (some #(and (vector? %) (identical? wrap-maintainer-required (first %)))
                      (:middleware data)))))

(defn query-token-scope
  "`:plaid/token-scope` for the query route: a scoped token must name its
  projects (`:scope {:project-ids [...]}`) and every one of them must be in
  scope. The query then reads only those, since the executor intersects the
  named projects with what the user can read. A body that does not parse is
  let through, for the route to answer as it answers anyone."
  [request scope]
  (let [parsed (try (ast/parse (-> request :parameters :body))
                    (catch Exception _ ::unparsed))]
    (when-not (or (= parsed ::unparsed)
                  (let [ids (-> parsed :scope :project-ids)]
                    (and (seq ids) (every? #(in-scope? scope %) ids))))
      scope-refusal)))

(defn user-data-token-scope
  "`:plaid/token-scope` for the private data routes: one entry at a time,
  whose key names a project in scope as one of its colon-separated segments
  (an assistant's conversation lives under `<app>:assistant:<project>:...`).
  A listing is refused: it would read the entries of every project at once.
  That the user is the token's own is `self-or-admin`'s, with admin
  already taken away."
  [request scope]
  (let [k (-> request :parameters :path :key)]
    (when-not (and k (some #(in-scope? scope %) (str/split k #":")))
      scope-refusal)))

(defn operation-group-token-scope
  "`:plaid/token-scope` for `/operation-groups/:id`: a scoped token may
  relabel (PATCH) a group that its own writes created, whatever its
  projects, since a group names none. Nothing else there is open to it.
  `plaid.rest-api.v1.operation-group` has put the group's creating token on
  the request as `:operation-group/token-key`."
  [request scope]
  (let [created-by (:operation-group/token-key request)]
    (when-not (and (= :patch (:request-method request))
                   (some? created-by)
                   (= created-by (:token-key scope)))
      scope-refusal)))

(defn own-user-token-scope
  "`:plaid/token-scope` for `/users/:id`: a scoped token may read its own
  user's record, and nothing else there. A service acting for a user is told
  who they are with every request, and their record is how it learns what
  core lets them do in the projects in scope (an administrator counts as a
  maintainer there), so it refuses honestly rather than plan what core would
  refuse, or the other way round. Another user's record, and every change
  to one's own, stay refused."
  [request scope]
  (let [id (-> request :parameters :path :id)]
    (when-not (and (= :get (:request-method request))
                   (= id (:user-id scope)))
      scope-refusal)))

(defn each-operation-token-scope
  "`:plaid/token-scope` for the batch route: every operation in it goes back
  through the router, and each is checked there."
  [_ _]
  nil)

(def token-scope-gate
  "The innermost middleware of every login-required route (installed by the
  router's middleware transform in `plaid.rest-api.v1.core`). For a request
  with a scoped token, it refuses unless a project or vocab gate passed the
  request on a project in scope, or the route's own `:plaid/token-scope`
  check passes it. On a route marked `:plaid/vocabulary-admin`, and on one
  behind the project maintainer gate (`project-maintainer-gated?`), it
  refuses every scoped request. Every other request goes straight through."
  {:name ::token-scope-gate
   :compile (fn [data _]
              (when (some #(identical? wrap-login-required %) (:middleware data))
                (let [own (:plaid/token-scope data)
                      vocabulary-admin? (:plaid/vocabulary-admin data)
                      project-admin? (project-maintainer-gated? data)]
                  {:name ::token-scope-gate
                   :wrap (fn [handler]
                           (fn [request]
                             (let [scope (:auth/token-scope request)]
                               (cond
                                 (nil? scope) (handler request)
                                 vocabulary-admin? vocabulary-admin-refusal
                                 project-admin? project-admin-refusal
                                 own (or (own request scope) (handler request))
                                 @(:passed scope) (handler request)
                                 :else scope-refusal))))})))})

(defn- link-token-refusal
  "Why the link token `token-data` (already verified as signed and unexpired)
  does not open this request on a route that takes `audience`, or nil when it
  does: it must carry that audience, a media token must name the document in
  the path, and the API token it was minted under, if any, must still be
  active. The account checks are the session token's, made by
  `wrap-read-jwt` itself."
  [db request token-data audience]
  (let [path-params (:path-params request)
        path-document (some-> (or (get path-params :document-id) (get path-params "document-id"))
                              str str/lower-case)
        api-token-id (:link/api-token token-data)]
    (cond
      (not= audience (:aud token-data))
      "Token invalid. Obtain a new token."

      (and (= audience media-audience)
           (or (nil? path-document)
               (not= path-document (some-> (:media/document token-data) str str/lower-case))))
      "This link opens another recording."

      (and api-token-id (not (api-token/active? db api-token-id)))
      "Token revoked or unknown.")))

(defn wrap-read-jwt
  "Reitit middleware that looks for JWT tokens in either:
  1. \"Authorization: Bearer ...\" header (standard approach)
  2. \"token\" query parameter (for EventSource compatibility)
  3. a link token's parameter (\"media-token\", \"avatar-token\"), on a route
     marked `:plaid/link-token` with its audience only, when neither of the
     others is there (see Link tokens above)

  A link token is refused as 1 or 2, on every route.

  On success, token data is stored in the request map under :jwt-data."
  [handler]
  (fn [{:keys [db] :as request}]
    (let [secret-key (:secret-key request)
          auth-header (get-in request [:headers "authorization"])
          bearer? (and auth-header (.startsWith ^String auth-header "Bearer "))
          ;; A parameter given twice arrives as a vector. It names no one
          ;; credential, so it counts as absent, and the route's own gate
          ;; refuses the request as unsigned.
          one (fn [k] (let [v (get-in request [:query-params k])] (when (string? v) v)))
          query-token (one "token")
          link-audience (when (and (not bearer?) (nil? query-token))
                          (link-route-audience request))
          link-token (when link-audience (one (link-token-params link-audience)))]
      (cond (nil? secret-key)
            (do (log/error "Secret key not found in request! Are middlewares properly ordered?" nil)
                {:status 500 :body {:error (str "Improperly configured server. Contact admin.")}})

            ;; No auth header, no query token, no link token
            (and (not bearer?) (nil? query-token) (str/blank? link-token))
            (handler request)

            :else
            (let [source (cond bearer? "header"
                               query-token "query"
                               :else (link-token-params link-audience))
                  link? (not (or bearer? query-token))
                  token (cond bearer? (subs auth-header 7)
                              query-token query-token
                              :else link-token)
                  token-data (try (jwt/unsign token secret-key)
                                  (catch Exception e e))
                  ;; An API token carries a `:token/id` claim; a session token
                  ;; does not. The two diverge on revocation: session tokens
                  ;; ride `password_changes`, API tokens ride the
                  ;; `api_tokens.revoked_at` row (and survive password changes).
                  ;; A link token never takes the API-token branch: it rides
                  ;; `password_changes` whatever minted it.
                  api-token-id (and (map? token-data) (not link?) (:token/id token-data))
                  user (and (map? token-data) (user/get-internal db (:user/id token-data)))
                  link-refusal (when (and link? (map? token-data))
                                 (link-token-refusal db request token-data link-audience))
                  ;; A scoped token (see `*token-scope*`): the handlers get a
                  ;; user record without admin, and the gates get the scope.
                  scope (when-let [projects (and (map? token-data) (token-projects token-data))]
                          {:user-id (:user/id token-data)
                           :projects (runner-reach db token-data projects)
                           :token-key (:jti token-data)
                           :admin? (user/admin? user)
                           :passed (volatile! false)})
                  proceed (fn []
                            ;; Don't log the JWT itself (token-data carries the
                            ;; claims). Don't log the raw `token` string either —
                            ;; even a partial prefix is enough to weaken
                            ;; signatures, and the JWT shows up in `request` shapes
                            ;; that wrap-logging already redacts.
                            (log/debug (str "Authenticated user " (:user/id token-data)
                                            (when api-token-id (str " via API token " api-token-id))
                                            " (source: " source ")"))
                            ;; Hand the validated identity back out to the
                            ;; access log, which runs outside this middleware
                            ;; so that the requests refused below still get a
                            ;; line. See `log-buffer/identity-key`.
                            (some-> ^clojure.lang.Volatile (get request log-buffer/identity-key)
                                    (vreset! {:user (:user/id token-data)
                                              :token (or api-token-id
                                                         (when link? (:link/api-token token-data)))}))
                            (binding [*token-scope* scope]
                              (handler (cond-> (assoc request
                                                      :jwt-data token-data
                                                      :user/id (:user/id token-data)
                                                      :user/record (cond-> (select-keys user [:user/id :user/display-name :user/is-admin])
                                                                     scope (assoc :user/is-admin false)))
                                         ;; Server-authoritative attribution: the
                                         ;; validated claim, not client input.
                                         ;; wrap-api-token-id binds this onto the
                                         ;; operations row.
                                         api-token-id (assoc :api-token/id api-token-id)
                                         scope (assoc :auth/token-scope scope)))))]
              (cond
                (instance? Exception token-data)
                ;; Just the message, and only once per token per window — a
                ;; rejected token is routine (expired, tampered, wrong secret),
                ;; not worth a stack trace, and not worth a line per retry.
                (do (log-jwt-rejection! token ^Exception token-data)
                    {:status 401
                     :body {:error (str "Token invalid. Obtain a new token.")}})

                ;; A link token opens its own route through its own
                ;; parameter and nothing else: never as a bearer or `?token=`
                ;; credential.
                (and (not link?) (link-claims? token-data))
                {:status 401
                 :body {:error (link-misuse-refusal token-data)}}

                link-refusal
                {:status 401
                 :body {:error link-refusal}}

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

(defn wrap-path-user-required
  "Answer 404 unless the path's `:user-id` names an account. Goes AFTER the
  route's self-or-admin or admin gate: the user themselves always exists and
  anyone else is refused before this, so only an admin learns that an id
  names nobody (the core ruling on unknown ids). Users are deactivated, never
  deleted, so there is no history to consult."
  [handler]
  (fn [{db :db :as request}]
    (let [id (-> request :parameters :path :user-id)]
      (if (and (some? id)
               (not (psc/q1 db {:select [:id] :from [:users] :where [:= :id id]})))
        {:status 404 :body {:error "User not found"}}
        (handler request)))))

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

(defn bulk-resolver
  "Build the auth or document-version resolver for a bulk route. `lookup`
  takes a db and ONE ENTRY of the body (an id for a bulk delete, a map for
  a bulk create or update) and comes back with the project, document or
  vocab layer that entry belongs to, or nil where the entry names nothing.

  THE FIRST ENTRY THAT RESOLVES, not simply the first: an id already gone
  at the head of the list would otherwise leave the gate's subject
  unresolved and answer 403 (or, for the document-version gate, 400),
  where the route's own answer is the caller's real one. Whether a member
  sees 404, 403 or a plain success must not depend on where in their list
  the stale id sits. The gate is no weaker for it: an entry that DOES
  resolve is never skipped, so a member is still judged against the first
  real thing their list names. Every bulk route resolves through this,
  create, update and delete alike."
  [lookup]
  (fn [{db :db params :parameters}]
    (some #(lookup db %) (:body params))))

(defn bulk-update-resolver
  "`bulk-resolver` for a bulk UPDATE, whose entries are maps carrying the
  entity's id under `:id`. `lookup` takes a db and that id."
  [lookup]
  (bulk-resolver (fn [db entry] (lookup db (:id entry)))))

(defn wrap-bulk-delete-of-nothing
  "Answer a bulk DELETE 204 and write nothing when no id in its body
  resolves (`resolver` is the route's gate resolver, a `bulk-resolver`).
  Goes FIRST in the route's middleware, before its privilege gate.

  Bulk delete is idempotent: a gone id in a list is skipped and the live
  ones are deleted. A list whose ids are ALL gone gave the gate no project
  to judge, so it refused a writer 403 `unresolved` (an admin passed and got
  204), and inside a batch that refused the whole batch. A script deleting
  words and then their morphemes, which the words' delete had already
  taken, stopped halfway (D8-PRODLOG-1). The no-op tells nobody anything:
  the ids belong to no project, so a member and a stranger learn the same.
  A list naming any id that does resolve still meets the gate on that id's
  project, so this lets nobody past it. Single deletes keep the unknown-id
  ruling (writer 403, admin 404)."
  [handler resolver]
  (fn [request]
    (if (nil? (resolver request))
      {:status 204}
      (handler request))))

(defn- resolve-project-id
  "Run a route's project resolver against `request`.

  `:as-of-ts` is forwarded so doc-scoped resolvers can fall through to
  audit-log reconstruction when the document has been deleted from OLTP but
  existed at `ts`. ACL membership is still resolved from CURRENT OLTP —
  historical-ACL is explicitly out of scope; only the doc→project lookup is
  allowed to time-travel."
  [{db :db :as request} get-project-id]
  (get-project-id {:parameters (:parameters request)
                   :db db
                   :as-of-ts (:as-of-ts request)}))

(defn- member-at?
  "Does `user-id` hold at least `key` on `project-id` by a role on it?"
  [db key project-id user-id]
  (let [project (prj/get db project-id)]
    (boolean (some #(seq ((-> project % set) user-id)) (key levels)))))

(defn- holds-privilege?
  "Does `request`'s user hold at least `key` on `project-id`, or admin?

  With a scoped token (`*token-scope*`), only on a project in scope, where
  an admin counts as holding every level.

  Nobody holds anything on a project being deleted (`prj/hidden?`), admins
  included: it is gone from the moment the delete returns, although its rows
  are still being removed in the background."
  [{db :db :as request} key project-id]
  (let [user-id (->user-id request)]
    (cond
      (prj/hidden? db project-id)
      false

      :else
      (if-let [scope (:auth/token-scope request)]
        (boolean (and (in-scope? scope project-id)
                      (or (:admin? scope) (member-at? db key project-id user-id))
                      (pass-scope! scope)))
        (boolean (or (user/admin? (:user/record request))
                     (member-at? db key project-id user-id)))))))

(defn privileged?
  "Does the request's user hold at least `key` (`:project/readers`,
  `:project/writers`, or `:project/maintainers`) on the project that
  `get-project-id` resolves, or admin? This is the membership test behind the
  `wrap-*-required` middlewares, exposed for a handler whose requirement
  depends on runtime state (submitting to a service is reader-or-writer
  depending on whether that service delegates)."
  [request key get-project-id]
  (when-not (-> levels keys set key)
    (throw (ex-info "Bad key" {:key key})))
  (holds-privilege? request key (resolve-project-id request get-project-id)))

(defn- named-in-path?
  "Is `id` the value of one of the request's path parameters? An id the path
  names is the resource the request is about, and one that names nothing is
  a 404 to an admin. An id a resolver found in the body (a create's parent)
  is not: a missing parent is the handler's 400."
  [request id]
  (let [id (str id)]
    (boolean (some #(= id (str %)) (vals (-> request :parameters :path))))))

(defn- unknown-project-for-admin
  "The 404 when an admin's request names, in its path, a project id no
  project has, or nil. Everyone else is left to the gate, which answers a
  non-member 403 whether or not the id is real (the core ruling on unknown
  ids), and so is an id resolved from the body."
  [{db :db :as request} id]
  (when (and (some? id)
             (user/admin? (:user/record request))
             (named-in-path? request id)
             (not (psc/q1 db {:select [:id] :from [:projects] :where [:= :id id]})))
    {:status 404 :body {:error "Project not found"}}))

(defn- unresolved-if
  "A 403 `body` with `:unresolved true` added when `unresolved?`: the id the
  request named resolved to nothing (deleted since the caller read it, or
  never there). The status stays 403 (the core ruling on unknown ids), and
  the field tells a client no more than the wording already does, so a
  client can read the refusal as changed or removed without matching the
  message's text."
  [unresolved? body]
  (cond-> body unresolved? (assoc :unresolved true)))

(defn wrap-project-privileges-required
  "Refuse the request unless its user holds `key` on the project
  `get-project-id` resolves.

  A resolver that comes back with nothing still refuses with 403, never a
  404: the entity named in the path or the body may not exist, and a
  non-member must not be able to learn which (`comment-test/comment-on-
  missing-anchor-does-not-create` and `history.read-test/deleted-doc-
  readable-by-non-admin-reader-via-fallthrough` both pin that trade). The
  message says so rather than trailing an empty project id."
  [handler key get-project-id]
  (when-not (-> levels keys set key)
    (throw (ex-info "Bad key" {:key key})))
  (fn [request]
    (let [id (resolve-project-id request get-project-id)
          scope (:auth/token-scope request)
          unknown (unknown-project-for-admin request id)]
      (cond
        unknown
        unknown

        (holds-privilege? request key id)
        (handler request)

        (and scope id (not (in-scope? scope id)))
        scope-refusal

        ;; A project being deleted answers an admin as a removed one does. A
        ;; non-admin gets the 403 below, as for any project that is not theirs.
        (and (user/admin? (:user/record request)) (prj/hidden? (:db request) id))
        {:status 404 :body {:error "Project not found"}}

        :else
        {:status 403
         :body (unresolved-if (nil? id)
                              {:error (str "User " (->user-id request)
                                           " lacks sufficient privileges to " (key verb) " "
                                           (if id
                                             (str "project " id)
                                             "the project this entity belongs to"))})}))))

(defn- known?
  "Is there a row `id` in `table` now, or, with `history?`, one the audit log
  has ever written (a document or vocabulary deleted since, whose history
  stays readable)?"
  [db table id history?]
  (boolean
   (or (psc/q1 db {:select [:id] :from [table] :where [:= :id id]})
       (and history?
            (psc/q1 db {:select [:op_id]
                        :from [:audit_writes]
                        :where [:and
                                [:= :target_table (name table)]
                                [:= :target_id (str id)]]
                        :limit 1})))))

(defn wrap-entity-required
  "Answer 404 unless `(get-id request)` names a row of `table` (or, with
  `:history? true`, one the audit log has written). Goes AFTER a route's
  privilege gate, for a route whose gate resolves an unknown id to nil and
  whose handler would otherwise answer with an empty result. Only an admin
  gets here with such an id: the gate answers anyone else 403, so a
  non-member still learns nothing (the core ruling on unknown ids)."
  [handler {:keys [table get-id label history?]}]
  (fn [{db :db :as request}]
    (let [id (get-id request)]
      (if (and (some? id) (not (known? db table id history?)))
        {:status 404 :body {:error (str label " not found")}}
        (handler request)))))

(defn- unknown-vocab-layer
  "The 404 for a vocab gate whose path names no vocabulary, now or in its
  history, or nil. Only an admin passes a vocab gate with such an id. An id
  from the body (an entry's vocabulary on a create) is the handler's 400."
  [{db :db :as request} vocab-id]
  (when (and (some? vocab-id)
             (named-in-path? request vocab-id)
             (not (known? db :vocab_layers vocab-id true)))
    {:status 404 :body {:error "Vocab layer not found"}}))

(defn wrap-reader-required [handler get-project-id]
  (wrap-project-privileges-required handler :project/readers get-project-id))
(defn wrap-writer-required [handler get-project-id]
  (wrap-project-privileges-required handler :project/writers get-project-id))
(defn wrap-maintainer-required [handler get-project-id]
  (wrap-project-privileges-required handler :project/maintainers get-project-id))

(defn- scoped-projects-linking
  "The projects in `scope` that link vocab layer `vocab-id`."
  [db scope vocab-id]
  (when vocab-id
    (->> (psc/q db {:select [:project_id]
                    :from [:project_vocabs]
                    :where [:= :vocab_layer_id vocab-id]})
         (map :project_id)
         (filter #(in-scope? scope %)))))

(defn- scoped-vocab-right?
  "A vocab right under a scoped token. The vocabulary must be linked to a
  project in scope, which is how a project's own readers reach it. Then an
  admin or the vocabulary's maintainer holds every right on it, and anyone
  else holds what their role gives them on one of those projects (`key`,
  as for `holds-privilege?`), never through a project outside the scope.
  `key` nil asks for maintainer rights, which no project role gives."
  [db scope vocab-id user-id key]
  (let [linking (scoped-projects-linking db scope vocab-id)]
    (boolean (and (seq linking)
                  (or (:admin? scope)
                      (vocab/maintainer? db vocab-id user-id)
                      (and key (some #(member-at? db key % user-id) linking)))
                  (pass-scope! scope)))))

(defn vocab-reader?
  "Does `user-id` hold read access to vocab layer `vocab-id` — admin, a
  maintainer of the vocabulary, or a member of a project the vocabulary is
  granted to? The predicate behind `wrap-vocab-reader-required`, exposed
  because a bulk handler can touch N vocabularies, which the single-id
  middleware cannot express, and the check must be the same one.

  `user-record` is the caller's already-loaded user row where there is one."
  ([db vocab-id user-id]
   (vocab-reader? db vocab-id user-id (user/get db user-id)))
  ([db vocab-id user-id user-record]
   (if-let [scope (scope-for user-id)]
     (scoped-vocab-right? db scope vocab-id user-id :project/readers)
     (boolean (or (user/admin? user-record)
                  (and vocab-id
                       (or (vocab/maintainer? db vocab-id user-id)
                           (vocab/accessible-through-project? db vocab-id user-id))))))))

(defn vocab-writer?
  "Does `user-id` hold write access to vocab layer `vocab-id` — admin, a
  maintainer of the vocabulary, or a writer on a project the vocabulary is
  granted to? The predicate behind `wrap-vocab-writer-required`, exposed for
  the bulk handlers the way `vocab-reader?` is.

  `user-record` is the caller's already-loaded user row where there is one."
  ([db vocab-id user-id]
   (vocab-writer? db vocab-id user-id (user/get db user-id)))
  ([db vocab-id user-id user-record]
   (if-let [scope (scope-for user-id)]
     (scoped-vocab-right? db scope vocab-id user-id :project/writers)
     (boolean (or (user/admin? user-record)
                  (and vocab-id
                       (or (vocab/maintainer? db vocab-id user-id)
                           (vocab/write-accessible-through-project? db vocab-id user-id))))))))

(defn vocab-layers-refusal
  "The 403 for a bulk vocab write when `user-id` lacks write access to any of
  `layer-ids` (checked with `vocab-writer?`), or nil when every layer is
  writable. The single-id gate is `wrap-vocab-writer-required`, this is the
  check a bulk handler runs on every distinct layer its entries touch."
  [db layer-ids user-id]
  (let [unwritable (vec (remove #(vocab-writer? db % user-id) (distinct layer-ids)))]
    (when (seq unwritable)
      {:status 403
       :body {:error (str "User " user-id " lacks write access to vocab layer(s) " unwritable)}})))

(defn wrap-vocab-maintainer-required
  "Requires that the user is a maintainer of the vocab layer or an admin.
  `refusal`, when given, is the 403's message in place of the generic one,
  for a route whose refusal a client shows as it stands.

  An id that resolves to no vocabulary (an entry deleted since the caller
  read it) is refused with the generic unknown-id wording, never `refusal`:
  it names no vocabulary, as the reader and writer gates' refusal does for
  such an id, so a client can tell it from a real refusal and read it as
  changed or removed. The status stays 403 (the core ruling on unknown ids)."
  ([handler get-vocab-id]
   (wrap-vocab-maintainer-required handler get-vocab-id nil))
  ([handler get-vocab-id refusal]
   (fn [{db :db :as request}]
     (let [user-id (->user-id request)
           vocab-id (get-vocab-id {:parameters (:parameters request)
                                   :db db})
           scope (scope-for user-id)
           allowed? (if scope
                      (scoped-vocab-right? db scope vocab-id user-id nil)
                      (or (user/admin? (:user/record request))
                          (and vocab-id
                               (vocab/maintainer? db vocab-id user-id))))]
       (if-not allowed?
         {:status 403
          :body (unresolved-if (nil? vocab-id)
                               {:error (cond
                                         (nil? vocab-id) (str "User " user-id " lacks maintainer access to vocab layer")
                                         refusal refusal
                                         :else (str "User " user-id " lacks maintainer privileges for vocab layer " vocab-id))})}
         (or (unknown-vocab-layer request vocab-id) (handler request)))))))

(defn wrap-vocab-reader-required
  "Requires that the user has read access to the vocab layer through a project or is a maintainer/admin."
  [handler get-vocab-id]
  (fn [{db :db :as request}]
    (let [user-id (->user-id request)
          vocab-id (get-vocab-id {:parameters (:parameters request)
                                  :db db})]
      (if-not (vocab-reader? db vocab-id user-id (:user/record request))
        {:status 403
         :body (unresolved-if (nil? vocab-id)
                              {:error (str "User " user-id " lacks read access to vocab layer " vocab-id)})}
        (or (unknown-vocab-layer request vocab-id) (handler request))))))

(defn wrap-vocab-writer-required
  "Requires that the user has write access to vocab items through a project or is a maintainer/admin."
  [handler get-vocab-id]
  (fn [{db :db :as request}]
    (let [user-id (->user-id request)
          vocab-id (get-vocab-id {:parameters (:parameters request)
                                  :db db})]
      (if-not (vocab-writer? db vocab-id user-id (:user/record request))
        {:status 403
         :body (unresolved-if (nil? vocab-id)
                              {:error (str "User " user-id " lacks write access to vocab layer " vocab-id)})}
        (or (unknown-vocab-layer request vocab-id) (handler request))))))

