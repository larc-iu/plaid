(ns plaid.sql.user
  "SQL port of plaid.xtdb2.user. Users live in the `users` table.

  External API matches the xtdb2 version: same function names, same
  arglists, same return shapes. The first argument is now `db`, which
  may be a HikariCP DataSource (for reads) or a JDBC Connection inside
  a transaction (for writes). Writes open their own transaction via
  `plaid.sql.operation/submit-operation!`."
  (:require [buddy.hashers :as hashers]
            [clojure.string]
            [plaid.sql.common :as psc]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.sql.pagination :as pagination])
  (:refer-clojure :exclude [get merge])
  (:import [java.sql SQLException]))

(def attr-keys
  [:user/id
   :user/username
   :user/password-hash
   :user/password-changes
   :user/is-admin
   :user/deactivated-at
   :user/avatar-hash])

(def public-keys
  "The externally visible projection of a user record (no password
  fields). `:user/deactivated-at` is included deliberately: deactivated
  users stay listable/inspectable so admins can see and reactivate
  them."
  [:user/id :user/username :user/is-admin :user/deactivated-at :user/avatar-hash])

(defn- row->user
  "Translate a `users` row (snake_case column keys) to the namespaced
  shape the rest of the system expects. Returns nil on nil input."
  [row]
  (when row
    {:user/id               (:id row)
     :user/username         (:username row)
     :user/password-hash    (:password_hash row)
     :user/password-changes (or (:password_changes row) 0)
     ;; SQLite stores booleans as 0/1 INTEGERs.
     :user/is-admin         (boolean (and (some? (:is_admin row))
                                          (not (zero? (long (:is_admin row))))))
     ;; nil = active; an ISO ts = deactivated at that moment. Users are
     ;; never hard-deleted (audit attribution must survive).
     :user/deactivated-at   (:deactivated_at row)
     ;; SHA-256 of the stored profile picture, or nil for "no picture". The
     ;; pixels live in `user_avatars`, and only this digest is on the user row, so
     ;; clients can tell whether to render an image (and build a cache-busting
     ;; URL) without a second request. See `plaid.media.avatar`.
     :user/avatar-hash      (:avatar_hash row)}))

;; reads ---------------------------------------------------------------------------

(defn get-internal
  "Get a user by ID with all fields (including sensitive ones)."
  [db id]
  (row->user (psc/fetch-by-id db :users id)))

(defn get
  "Get a user by ID formatted for external consumption."
  [db id]
  (when-let [user (get-internal db id)]
    (select-keys user public-keys)))

(defn admin? [user-record]
  (boolean (:user/is-admin user-record)))

(defn get-all
  "Get all users formatted for external consumption, ordered by
  `:username`.

  Bare arity `([db])` returns a plain seq of `{:user/id :user/username
  :user/is-admin}` maps (used by admin seeding in `server/sql.clj`).

  Paginated arity `([db opts])` keyset-paginates on `:username` (a
  unique column, so a sufficient total order on its own) and returns the
  uniform `{:entries [...] :next-cursor <raw-vals-or-nil>}` envelope. An
  optional `:q` filters to usernames containing that text (case-insensitive
  substring) — used by the project-permissions UI to find users to grant
  access without paging the whole roster."
  ([db]
   (->> (psc/q db {:select [:*] :from [:users] :order-by [:username]})
        (map row->user)
        (map #(select-keys % public-keys))))
  ([db {:keys [limit cursor-vals q]}]
   (pagination/paginate db (cond-> {:from :users
                                    :order-by [:username]
                                    :limit limit
                                    :cursor-vals cursor-vals
                                    :row->entity (fn [row] (-> (row->user row)
                                                               (select-keys public-keys)))}
                             (not (clojure.string/blank? q))
                             (assoc :base-where [:like [:lower :username]
                                                 (str "%" (clojure.string/lower-case q) "%")])))))

(defn find-by-username
  "Find a user by username. Returns full internal record."
  [db username]
  (row->user (psc/q1 db {:select [:*]
                         :from [:users]
                         :where [:= :username username]})))

(defn get-avatar
  "Fetch `id`'s stored profile picture as
  `{:content-type <mime> :bytes <byte-array> :hash <hex>}`, or nil when the
  user has none. The hash is read from `users` rather than recomputed, so it is
  always the same value the user record advertises."
  [db id]
  (when-let [row (psc/q1 db {:select [:ua.content_type :ua.bytes :u.avatar_hash]
                             :from [[:user_avatars :ua]]
                             :join [[:users :u] [:= :u.id :ua.user_id]]
                             :where [:= :ua.user_id id]})]
    {:content-type (:content_type row)
     :bytes (:bytes row)
     :hash (:avatar_hash row)}))

;; writes --------------------------------------------------------------------------

(defn- username-unique-violation?
  "True iff `e` (or any cause in its chain) is the specific
  `UNIQUE constraint failed: users.username` SQLite violation. NARROW
  on purpose: a PK collision on `users.id` or a CHECK violation on
  `is_admin IN (0,1)` would also raise SQLState 23000 with
  `SQLITE_CONSTRAINT` in the message, but those are NOT 'username
  taken' — they're real server bugs that must surface as 500s with
  their original message, not be silently re-projected to 409
  'user already exists'. We match on the SQLite message tail
  (`UNIQUE constraint failed: users.username`) because it's the
  cleanest portable distinguisher across sqlite-jdbc versions; the
  extended result code SQLITE_CONSTRAINT_UNIQUE (2067) is
  driver-specific and not exposed uniformly.

  Walks the cause chain because next.jdbc may wrap the driver
  exception."
  [^Throwable e]
  (loop [^Throwable t e]
    (cond
      (nil? t) false
      (instance? SQLException t)
      (let [^SQLException sqle t
            msg (or (.getMessage sqle) "")]
        (or (.contains msg "UNIQUE constraint failed: users.username")
            (recur (.getCause t))))
      :else (recur (.getCause t)))))

(defn insert-user-row!
  "Insert a fresh user row inside a tx. PUBLIC because invite redemption
  (plaid.sql.invite/redeem!) creates the account inside its own
  `:invite/redeem` op, alongside the project grant and the use-count bump,
  so all three commit or none do. Callers MUST already be inside
  `submit-operation!` (psc/insert! asserts it). Relies on the users table's
  PRIMARY KEY (id) + UNIQUE (username) constraints — racing
  SELECT-then-INSERT was wrong inside SAVEPOINTs (no BEGIN IMMEDIATE
  lock), so we let the DB enforce uniqueness and translate ONLY the
  username-unique constraint exception to a 409. Any other constraint
  violation (PK collision on id, CHECK on is_admin, etc.) is
  re-thrown so the outer submit-operation* catch projects it to 500
  with the original SQLException message — important for diagnostics."
  [tx id is-admin password]
  (let [password-hash (hashers/derive password)
        row {:id               id
             :username         id
             :password_hash    password-hash
             :password_changes 0
             :is_admin         (if is-admin 1 0)}]
    (try
      (psc/insert! tx :users row)
      (catch SQLException e
        (if (username-unique-violation? e)
          (throw (ex-info (psc/err-msg-already-exists "User" id) {:id id :code 409}))
          (throw e))))
    id))

(defn create
  "Create a new user. `id` doubles as the username (matches v2 behavior).
  `acting-user-id` attributes the op in the audit log — nil ONLY for the
  bootstrap admin created at first startup, where no actor exists yet.
  Returns {:success true :extra id} or {:success false ...}."
  [db id is-admin password acting-user-id]
  (submit-operation! [tx db {:type :user/create
                             :project nil
                             :document nil
                             :description (str "Create user " id)
                             :user acting-user-id}]
                     (insert-user-row! tx id is-admin password)))

(defn- count-other-admins
  "Count global admins OTHER than `eid`. Used to enforce the
  'at least one global admin must remain' invariant on the user
  delete + demote paths."
  [tx eid]
  (or (:c (psc/q1 tx {:select [[[:count :*] :c]]
                      :from [:users]
                      :where [:and [:= :is_admin 1] [:<> :id eid]]}))
      0))

(defn merge
  "Update mutable fields on a user. `m` may include :user/username,
  :user/is-admin, and/or :password (raw, which gets hashed).
  `acting-user-id` attributes the op (the admin or the user themselves)."
  [db eid m acting-user-id]
  (submit-operation! [tx db {:type :user/update
                             :project nil
                             :document nil
                             :description (str "Update user " eid)
                             :user acting-user-id}]
                     (when-let [n (:user/username m)]
                       (psc/valid-name? n))
                     (let [intern (get-internal tx eid)]
                       (when (nil? intern)
                         (throw (ex-info (psc/err-msg-not-found "User" eid) {:code 404 :id eid})))
                       ;; Task #100 V4: refuse to demote the LAST global
                       ;; admin. We only block the (admin -> non-admin)
                       ;; transition when no other admin exists; promoting
                       ;; or no-op demotion is fine. Sits inside the body
                       ;; so submit-operation* projects it to 400.
                       (when (and (contains? m :user/is-admin)
                                  (false? (:user/is-admin m))
                                  (:user/is-admin intern)
                                  (zero? (count-other-admins tx eid)))
                         (throw (ex-info (str "Cannot remove admin status from the last admin (" eid ")")
                                         {:code 400 :id eid})))
                       (let [attrs {}
                             attrs (if-let [new-password (:password m)]
                                     (-> attrs
                                         (assoc :password_hash (hashers/derive new-password))
                                         (assoc :password_changes (inc (or (:user/password-changes intern) 0))))
                                     attrs)
                             attrs (cond-> attrs
                                     (some? (:user/username m))
                                     (assoc :username (:user/username m))

                                     (some? (:user/is-admin m))
                                     (assoc :is_admin (if (:user/is-admin m) 1 0)))]
                         (when (seq attrs)
                           (psc/update-by-id! tx :users eid attrs))
                         eid))))

(defn set-password-in-tx!
  "Set `eid`'s password to `password` and bump `password_changes`, inside the
  caller's already-open operation tx. Bumping the counter is what makes every
  JWT the user currently holds stop validating, so a password reset genuinely
  ends whatever sessions the old password was protecting.

  This is the in-tx twin of `(merge db eid {:password ...} actor)`. Invite
  redemption needs it because the reset has to be atomic with consuming the
  invite: opening a second operation would allow a password change that the
  invite's use-count bump never recorded, leaving a single-use reset link
  live after it had already worked.

  404s if the user is missing. Returns `eid`."
  [tx eid password]
  (let [intern (get-internal tx eid)]
    (when (nil? intern)
      (throw (ex-info (psc/err-msg-not-found "User" eid) {:code 404 :id eid})))
    (psc/update-by-id! tx :users eid
                       {:password_hash    (hashers/derive password)
                        :password_changes (inc (or (:user/password-changes intern) 0))})
    eid))

;; Profile pictures.
;;
;; Both writes below touch two tables in one operation, and only one of the two
;; goes through the audited helpers. `users.avatar_hash` does, so the audit log
;; records that the picture changed and who changed it. `user_avatars.bytes`
;; does NOT: `record-audit-write!` persists the full post-image of every row it
;; touches, so routing the BLOB through it would write a copy of the picture
;; into `audit_writes` on every change. The digest is the durable record. The
;; pixels are current-state only.

(defn set-avatar!
  "Store `avatar` (as produced by `plaid.media.avatar/normalize`) as `eid`'s
  profile picture, replacing any existing one. `acting-user-id` attributes the
  op (the user themselves, or an admin). Returns `{:success true :extra <hash>}`."
  [db eid {:keys [content-type bytes hash]} acting-user-id]
  (submit-operation! [tx db {:type :user/update
                             :project nil
                             :document nil
                             :description (str "Set profile picture for user " eid)
                             :user acting-user-id}]
                     (when (nil? (get-internal tx eid))
                       (throw (ex-info (psc/err-msg-not-found "User" eid) {:code 404 :id eid})))
                     (psc/execute! tx {:insert-into :user_avatars
                                       :values [{:user_id      eid
                                                 :content_type content-type
                                                 :bytes        bytes
                                                 :updated_at   (psc/now-iso)}]
                                       :on-conflict :user_id
                                       :do-update-set [:content_type :bytes :updated_at]})
                     (psc/update-by-id! tx :users eid {:avatar_hash hash})
                     hash))

(defn delete-avatar!
  "Remove `eid`'s profile picture. 404s when the user has none, so a repeated
  delete is distinguishable from a successful one. Returns `{:success true}`."
  [db eid acting-user-id]
  (submit-operation! [tx db {:type :user/update
                             :project nil
                             :document nil
                             :description (str "Remove profile picture for user " eid)
                             :user acting-user-id}]
                     (let [intern (get-internal tx eid)]
                       (when (nil? intern)
                         (throw (ex-info (psc/err-msg-not-found "User" eid) {:code 404 :id eid})))
                       (when (nil? (:user/avatar-hash intern))
                         (throw (ex-info (str "User " eid " has no profile picture")
                                         {:code 404 :id eid})))
                       (psc/execute! tx {:delete-from :user_avatars :where [:= :user_id eid]})
                       (psc/update-by-id! tx :users eid {:avatar_hash nil})
                       eid)))

(defn- audit-and-cascade-project-memberships!
  "For every project this user was a member of, snapshot the ACL,
  explicitly delete the user's project_users row(s), and emit a
  synthetic :projects audit so the membership transition is visible
  in `audit_writes` (vs. silently swept by FK ON DELETE CASCADE).

  `requiring-resolve` dodges the project ↔ user namespace cycle (project
  already requires user; the reverse static require would be circular)."
  [tx user-id]
  (let [snapshot (requiring-resolve 'plaid.sql.project/fetch-project-acl-snapshot)
        emit-audit (requiring-resolve 'plaid.sql.project/audit-project-acl-change!)
        proj-ids (->> (psc/q tx {:select-distinct [:project_id]
                                 :from [:project_users]
                                 :where [:= :user_id user-id]})
                      (mapv :project_id))]
    (doseq [pid proj-ids]
      (let [pre-acl (snapshot tx pid)]
        ;; Explicit DELETE before the user row goes — keeps the FK
        ;; CASCADE that fires on the user delete a no-op (the rows are
        ;; already gone), and lets `audit-project-acl-change!` see the
        ;; new post-state cleanly.
        (psc/execute! tx {:delete-from :project_users
                          :where [:and
                                  [:= :project_id pid]
                                  [:= :user_id user-id]]})
        (emit-audit tx pid pre-acl)))))

(defn- audit-and-cascade-vocab-maintainerships!
  "For every vocab layer this user maintained, snapshot the maintainer
  list, explicitly delete the vocab_maintainers row, and emit a
  synthetic :vocab_layers audit. Same FK-cascade-blinds-ETL rationale
  as `audit-and-cascade-project-memberships!`."
  [tx user-id]
  (let [fetch-maintainers (requiring-resolve 'plaid.sql.vocab-layer/fetch-vocab-maintainer-ids)
        emit-audit (requiring-resolve 'plaid.sql.vocab-layer/audit-vocab-maintainers-change!)
        vocab-ids (->> (psc/q tx {:select [:vocab_layer_id]
                                  :from [:vocab_maintainers]
                                  :where [:= :user_id user-id]})
                       (mapv :vocab_layer_id))]
    (doseq [vid vocab-ids]
      (let [pre-maintainers (fetch-maintainers tx vid)]
        (psc/execute! tx {:delete-from :vocab_maintainers
                          :where [:and
                                  [:= :vocab_layer_id vid]
                                  [:= :user_id user-id]]})
        (emit-audit tx vid pre-maintainers)))))

(defn- projects-where-user-is-sole-maintainer
  "Return project ids for which `eid` is the ONLY user holding the
  'maintainer' role. Used by `delete` to reject the FK-cascade-driven
  loss of the last maintainer — without this guard, the cascade would
  silently leave a project unrecoverable."
  [tx eid]
  (->> (psc/q tx
              ["SELECT project_id
                FROM project_users
                WHERE role = 'maintainer'
                GROUP BY project_id
                HAVING COUNT(*) = 1
                   AND MAX(user_id) = ?" eid])
       (mapv :project_id)))

(defn- revoke-all-api-tokens!
  "Soft-revoke every active API token owned by `user-id`, inside the
  caller's op tx (audited :update rows under the caller's op — vs
  api-token/revoke! which opens its own op). Part of deactivation: a
  deactivated user's machine credentials must die with their login."
  [tx user-id ts]
  (let [token-ids (->> (psc/q tx {:select [:id]
                                  :from [:api_tokens]
                                  :where [:and
                                          [:= :user_id user-id]
                                          [:= :revoked_at nil]]})
                       (mapv :id))]
    (doseq [tid token-ids]
      (psc/update-by-id! tx :api_tokens tid {:revoked_at ts}))))

(defn deactivate
  "Deactivate a user by ID (the DELETE /users/:id semantics). Users are
  NEVER hard-deleted: `operations.user_id`/`operations.token_id` FKs
  deliberately block it because audit attribution must survive forever.
  Deactivation instead:
    - sets `deactivated_at` (audited :update; login + JWT validation
      reject deactivated users),
    - bumps `password_changes` so live session tokens die immediately
      (belt and braces alongside the JWT-validation check),
    - strips project memberships + vocab maintainerships (audited
      synthetic rows, same as the old delete),
    - revokes all the user's API tokens (audited).
  The username stays reserved. Reversible via `reactivate` (which does
  NOT restore memberships or tokens)."
  [db eid acting-user-id]
  (submit-operation! [tx db {:type :user/deactivate
                             :project nil
                             :document nil
                             :description (str "Deactivate user " eid)
                             :user acting-user-id}]
                     (let [existing (psc/fetch-by-id tx :users eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "User" eid) {:code 404 :id eid})))
                       (when (some? (:deactivated_at existing))
                         (throw (ex-info (str "User " eid " is already deactivated")
                                         {:code 400 :id eid})))
                       ;; Task #100 V4: refuse deactivation if it would leave
                       ;; the system or any project without a required
                       ;; principal. Two distinct invariants, both
                       ;; reported as 400:
                       ;;   - last global admin must remain;
                       ;;   - every project must keep >=1 maintainer.
                       ;; `existing` is the raw users row (SQLite INTEGER
                       ;; for is_admin), so coerce to boolean here.
                       (when (and (boolean (and (some? (:is_admin existing))
                                                (not (zero? (long (:is_admin existing))))))
                                  (zero? (count-other-admins tx eid)))
                         (throw (ex-info (str "Cannot deactivate the last admin (" eid ")")
                                         {:code 400 :id eid})))
                       (let [orphan-projects (projects-where-user-is-sole-maintainer tx eid)]
                         (when (seq orphan-projects)
                           (throw (ex-info
                                   (str "Cannot deactivate user " eid
                                        ": they are the sole maintainer of project(s) "
                                        (clojure.string/join ", " orphan-projects))
                                   {:code 400 :id eid :projects orphan-projects}))))
                       (audit-and-cascade-project-memberships! tx eid)
                       (audit-and-cascade-vocab-maintainerships! tx eid)
                       (let [ts (:ts psc/*op*)]
                         (revoke-all-api-tokens! tx eid ts)
                         (psc/update-by-id! tx :users eid
                                            {:deactivated_at ts
                                             :password_changes (inc (or (:password_changes existing) 0))}))
                       eid)))

(defn reactivate
  "Clear a user's `deactivated_at`, restoring their ability to log in.
  Does NOT restore project memberships, vocab maintainerships, or API
  tokens — those were genuinely removed (audited) at deactivation and
  must be re-granted deliberately. `password_changes` keeps its bumped
  value (it's a monotonic counter; old tokens stay dead)."
  [db eid acting-user-id]
  (submit-operation! [tx db {:type :user/reactivate
                             :project nil
                             :document nil
                             :description (str "Reactivate user " eid)
                             :user acting-user-id}]
                     (let [existing (psc/fetch-by-id tx :users eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "User" eid) {:code 404 :id eid})))
                       (when (nil? (:deactivated_at existing))
                         (throw (ex-info (str "User " eid " is not deactivated")
                                         {:code 400 :id eid})))
                       (psc/update-by-id! tx :users eid {:deactivated_at nil})
                       eid)))
