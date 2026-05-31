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
            [plaid.sql.operation :as op :refer [submit-operation!]])
  (:refer-clojure :exclude [get merge])
  (:import [java.sql SQLException]))

(def attr-keys
  [:user/id
   :user/username
   :user/password-hash
   :user/password-changes
   :user/is-admin])

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
                                          (not (zero? (long (:is_admin row))))))}))

;; reads ---------------------------------------------------------------------------

(defn get-internal
  "Get a user by ID with all fields (including sensitive ones)."
  [db id]
  (row->user (psc/fetch-by-id db :users id)))

(defn get
  "Get a user by ID formatted for external consumption."
  [db id]
  (when-let [user (get-internal db id)]
    (select-keys user [:user/id :user/username :user/is-admin])))

(defn admin? [user-record]
  (boolean (:user/is-admin user-record)))

(def ^:const default-limit
  "Default page size for `get-all` when no `:limit` is supplied."
  100)

(def ^:const max-limit
  "Hard ceiling on `:limit`. The REST layer rejects larger values up
  front; clamping here is the defense-in-depth backstop."
  1000)

(defn- clamp-limit
  [limit]
  (let [n (cond
            (nil? limit) default-limit
            (integer? limit) limit
            :else (try (Long/parseLong (str limit))
                       (catch Exception _ default-limit)))]
    (cond
      (<= n 0) default-limit
      (> n max-limit) max-limit
      :else n)))

(defn get-all
  "Get all users formatted for external consumption. Ordered by
  `:username` so cursor pagination is deterministic.

  Two-arity form takes `{:limit n :cursor username-or-nil}` and returns
  `{:entries [...] :next-cursor username-or-nil}`. Single-arity form
  preserves the legacy behavior (unpaginated seq) for internal callers
  that don't need pagination; the REST surface always uses the
  paginated form (task #99)."
  ([db]
   (->> (psc/q db {:select [:*] :from [:users] :order-by [:username]})
        (map row->user)
        (map #(select-keys % [:user/id :user/username :user/is-admin]))))
  ([db {:keys [limit cursor]}]
   (let [eff (clamp-limit limit)
         where (when cursor [:> :username cursor])
         rows (psc/q db (cond-> {:select [:*]
                                 :from [:users]
                                 :order-by [:username]
                                 :limit eff}
                          where (assoc :where where)))
         entries (->> rows
                      (map row->user)
                      (mapv #(select-keys % [:user/id :user/username :user/is-admin])))]
     {:entries entries
      :next-cursor (when (= (count rows) eff)
                     (:username (last rows)))})))

(defn find-by-username
  "Find a user by username. Returns full internal record."
  [db username]
  (row->user (psc/q1 db {:select [:*]
                         :from [:users]
                         :where [:= :username username]})))

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

(defn- insert-user-row!
  "Insert a fresh user row inside a tx. Relies on the users table's
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
  Returns {:success true :extra id} or {:success false ...}."
  [db id is-admin password]
  (submit-operation! [tx db {:type :user/create
                             :project nil
                             :document nil
                             :description (str "Create user " id)
                             :user nil}]
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
  :user/is-admin, and/or :password (raw, which gets hashed)."
  [db eid m]
  (submit-operation! [tx db {:type :user/update
                             :project nil
                             :document nil
                             :description (str "Update user " eid)
                             :user nil}]
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

(defn delete
  "Delete a user by ID. Before the users row is removed we walk and
  audit the two FK ON DELETE CASCADE relationships that would otherwise
  silently sweep junction rows (project_users + vocab_maintainers).
  Without this, an ETL replica fed from audit_writes would never see
  the user lose their roles / maintainerships."
  [db eid]
  (submit-operation! [tx db {:type :user/delete
                             :project nil
                             :document nil
                             :description (str "Delete user " eid)
                             :user nil}]
                     (let [existing (psc/fetch-by-id tx :users eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "User" eid) {:code 404 :id eid})))
                       ;; Task #100 V4: refuse deletion if it would leave
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
                         (throw (ex-info (str "Cannot delete the last admin (" eid ")")
                                         {:code 400 :id eid})))
                       (let [orphan-projects (projects-where-user-is-sole-maintainer tx eid)]
                         (when (seq orphan-projects)
                           (throw (ex-info
                                   (str "Cannot delete user " eid
                                        ": they are the sole maintainer of project(s) "
                                        (clojure.string/join ", " orphan-projects))
                                   {:code 400 :id eid :projects orphan-projects}))))
                       (audit-and-cascade-project-memberships! tx eid)
                       (audit-and-cascade-vocab-maintainerships! tx eid)
                       (psc/delete-by-id! tx :users eid)
                       eid)))
