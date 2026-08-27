(ns plaid.sql.invite
  "One-time, link-shaped credential grants. Two kinds share one table,
  distinguished by whether `target_user_id` is set:

    signup         (target_user_id NULL)     — the redeemer picks a username
                                               and password; the invite's
                                               grant columns decide what the
                                               new account gets.
    password reset (target_user_id NOT NULL) — the redeemer sets a new
                                               password on an existing
                                               account and grants nothing.

  Why this exists: the deployment has no email integration on purpose, so
  onboarding used to mean an admin inventing a temporary password and
  sending it over some side channel, then trusting the recipient to change
  it. An invite link means the server never transmits a credential it knows
  — the recipient chooses their own, once, over TLS.

  The plaintext code is generated here, returned exactly ONCE to the minter,
  and never stored (same show-once discipline as `plaid.sql.api-token`).
  What the row holds is a SHA-256 digest, which is what redemption looks up.

  Authority is checked TWICE: at mint time (can this user grant this?) and
  again at redemption (is that still true?). An invite is a deferred exercise
  of the minter's authority, so it must not outlive it — see
  `check-grant-authority!`.

  `db` is a DataSource (reads) or an in-tx Connection (writes via
  `submit-operation!`), matching every other namespace here."
  (:require [clojure.string :as str]
            [plaid.sql.common :as psc]
            [plaid.sql.operation :refer [submit-operation!]]
            [plaid.sql.pagination :as pagination]
            [plaid.sql.project :as prj]
            [plaid.sql.user :as user])
  (:refer-clojure :exclude [get])
  (:import [java.security MessageDigest SecureRandom]
           [java.time Duration Instant]))

;; ============================================================
;; Codes
;; ============================================================

(def ^:private ^SecureRandom secure-random (SecureRandom.))

(def ^:private code-alphabet
  "Crockford base32 minus the letter U. Chosen over base64url because an
  invite code gets read aloud, copied off a slide, and typed on a phone:
  there is no case to get wrong, and I, L, O, and U are absent so they can
  never be confused with 1, 0, or each other. `normalize-code` maps the
  confusable characters back, so a code typed with an O still redeems."
  "0123456789ABCDEFGHJKMNPQRSTVWXYZ")

(def ^:private code-length
  "32 characters over a 32-symbol alphabet = 160 bits. Far past the point
  where guessing matters, which is what lets the digest below be a fast
  SHA-256 rather than a KDF."
  32)

(defn generate-code
  "A fresh 160-bit invite code. Grouped into 8-character blocks with
  hyphens (`ABCD1234-...`) purely so a human can transcribe it without
  losing their place — `normalize-code` strips them again."
  []
  (let [n (count code-alphabet)
        chars (repeatedly code-length #(.charAt code-alphabet (.nextInt secure-random n)))]
    (->> (partition 8 chars)
         (map #(apply str %))
         (str/join "-"))))

(defn normalize-code
  "Canonicalize a user-supplied code before hashing: uppercase, drop
  hyphens and whitespace, and fold the characters the alphabet omits onto
  what the reader meant (O→0, I/L→1, U→V). This is why a code read off a
  whiteboard still works. Returns nil for a blank input."
  [code]
  (when-not (str/blank? code)
    (-> (str/upper-case code)
        (str/replace #"[\s\-]" "")
        (str/replace \O \0)
        (str/replace \I \1)
        (str/replace \L \1)
        (str/replace \U \V))))

(defn- sha256-hex
  [^String s]
  (let [digest (.digest (MessageDigest/getInstance "SHA-256")
                        (.getBytes s "UTF-8"))]
    (apply str (map #(format "%02x" %) digest))))

(defn code-hash
  "The lookup key for a plaintext code, or nil if the code is blank.
  Plain SHA-256, deliberately not bcrypt: the code carries 160 bits of
  CSPRNG entropy so there is no dictionary to slow an attacker down
  against, and a per-row-salted KDF could not be looked up by equality —
  every redemption would have to scan the table."
  [code]
  (some-> (normalize-code code) sha256-hex))

;; ============================================================
;; Row translation
;; ============================================================

(def ^:private default-ttl-days 14)
(def ^:private max-ttl-days 365)

(def ^:private min-password-length
  "Minimum length for a password chosen through a redemption. Enforced here
  rather than only in the UI because this is an unauthenticated endpoint and
  the browser is not the only thing that can post to it."
  8)

(defn- ->bool [v] (boolean (and (some? v) (not (zero? (long v))))))

(defn- expired?
  [row now]
  (and (:expires_at row)
       (neg? (compare (:expires_at row) now))))

(defn- status
  "Which of the four states an invite is in, most decisive first. The REST
  layer surfaces this verbatim so a holder is told WHY a dead link is dead
  (they already have the code, so there is nothing left to withhold) and a
  minter can see at a glance which links still work."
  [row now]
  (cond
    (some? (:revoked_at row))            :revoked
    (>= (long (:uses row)) (long (:max_uses row))) :used
    (expired? row now)                   :expired
    :else                                :active))

(defn- row->invite
  "External shape. NEVER carries `code_hash` — the digest is a verifier for
  a live credential and has no business leaving the SQL layer, let alone
  reaching a REST response."
  ([row] (row->invite row (psc/now-iso)))
  ([row now]
   (when row
     {:invite/id             (:id row)
      :invite/created-by     (:created_by row)
      :invite/created-at     (:created_at row)
      :invite/expires-at     (:expires_at row)
      :invite/max-uses       (:max_uses row)
      :invite/uses           (:uses row)
      :invite/revoked-at     (:revoked_at row)
      :invite/note           (:note row)
      :invite/target-user-id (:target_user_id row)
      :invite/kind           (if (:target_user_id row) "password-reset" "signup")
      :invite/grant-admin    (->bool (:grant_admin row))
      :invite/project-id     (:project_id row)
      :invite/project-role   (:project_role row)
      :invite/status         (name (status row now))})))

;; ============================================================
;; Reads
;; ============================================================

(defn get-internal
  "Raw row by invite id, or nil."
  [db id]
  (psc/fetch-by-id db :invites id))

(defn get
  "Invite by id in external shape, or nil."
  [db id]
  (row->invite (get-internal db id)))

(defn find-by-code
  "Raw row for a plaintext code, or nil if the code is blank or unknown.
  The single indexed point lookup that redemption and the public preview
  both run."
  [db code]
  (when-let [h (code-hash code)]
    (psc/q1 db {:select [:*] :from [:invites] :where [:= :code_hash h]})))

(defn list-for-creator
  "Invites minted by `user-id`, oldest-first, keyset-paginated on
  `(created_at, id)`. Includes dead ones: a minter needs to see that a link
  was used (and how often) as much as that it still works."
  [db user-id {:keys [limit cursor-vals]}]
  (let [now (psc/now-iso)]
    (pagination/paginate db {:from :invites
                             :base-where [:= :created_by user-id]
                             :order-by [:created_at :id]
                             :limit limit
                             :cursor-vals cursor-vals
                             :row->entity #(row->invite % now)})))

(defn list-for-project
  "Invites granting access to `project-id`, oldest-first, keyset-paginated.
  Scoped to a project rather than a minter so a co-maintainer can see (and
  revoke) links someone else on the project handed out."
  [db project-id {:keys [limit cursor-vals]}]
  (let [now (psc/now-iso)]
    (pagination/paginate db {:from :invites
                             :base-where [:= :project_id project-id]
                             :order-by [:created_at :id]
                             :limit limit
                             :cursor-vals cursor-vals
                             :row->entity #(row->invite % now)})))

;; ============================================================
;; Authority
;; ============================================================

(defn check-grant-authority!
  "Throw unless `actor-id` may hand out this exact grant, right now.

  Run at BOTH mint and redemption. Re-running it at redemption is the point:
  an invite is a deferred exercise of the minter's authority, and a link that
  outlived the authority behind it is a privilege-escalation bug. A
  maintainer who is removed from a project, demoted, or deactivated should
  not keep onboarding people into it through links they minted last week.

  The rules:
    - the actor must exist and be active;
    - granting global admin, or resetting anyone's password, is admin-only
      (a project maintainer who could mint a reset link for an admin would
      own the instance);
    - a non-admin may grant a project role only on a project they currently
      maintain, and only up to maintainer, which is exactly what
      `POST /projects/:id/maintainers` already lets them do directly."
  [db {:keys [actor-id grant-admin project-id target-user-id]}]
  (let [actor (user/get-internal db actor-id)]
    (when (nil? actor)
      (throw (ex-info (str "Invite creator " actor-id " no longer exists")
                      {:code 403 :id actor-id})))
    (when (some? (:user/deactivated-at actor))
      (throw (ex-info (str "Invite creator " actor-id " is deactivated")
                      {:code 403 :id actor-id})))
    (let [admin? (user/admin? actor)]
      (when (and grant-admin (not admin?))
        (throw (ex-info "Only an admin can create an invite that grants admin privileges"
                        {:code 403})))
      (when (and target-user-id (not admin?))
        (throw (ex-info "Only an admin can create a password reset link"
                        {:code 403})))
      (when (and project-id (not admin?)
                 (not (some #{actor-id} (prj/maintainer-ids db project-id))))
        (throw (ex-info (str "User " actor-id " does not maintain project " project-id)
                        {:code 403 :project-id project-id})))
      ;; A grantless invite is just `POST /users` wearing a link, and that
      ;; is admin-only. Requiring a project grant from a non-admin keeps a
      ;; maintainer's minting power bounded by the thing they maintain,
      ;; rather than letting any maintainer open the front door.
      (when (and (not admin?) (nil? project-id))
        (throw (ex-info "Only an admin can create an invite that grants no project access"
                        {:code 403}))))
    true))

;; ============================================================
;; Writes
;; ============================================================

(defn- resolve-expiry
  "Turn a caller-supplied TTL in days into an ISO instant. Every invite
  expires: an immortal link is a credential nobody remembers issuing, and
  the whole point of this table is that credentials stop being the admin's
  problem to track."
  [ttl-days]
  (let [days (or ttl-days default-ttl-days)]
    (when-not (and (integer? days) (pos? days) (<= days max-ttl-days))
      (throw (ex-info (str "ttl-days must be between 1 and " max-ttl-days)
                      {:code 400 :ttl-days days})))
    (psc/instant->iso (.plus (Instant/now) (Duration/ofDays days)))))

(defn- audit-invite-row!
  "Record an audit_writes row for an invite, with `code_hash` stripped from
  the image.

  Every other table here goes through `psc/insert!` / `psc/update-by-id!`,
  which capture `RETURNING *` as the post-image. That would put a live
  credential's verifier into the audit log, which is readable by more people
  and retained far longer than the invite itself. Nothing downstream needs
  the digest, so the raw `record-audit-write!` entry point takes a redacted
  image instead."
  [tx id change-type pre post]
  (psc/record-audit-write! tx :invites id change-type
                           (dissoc pre :code_hash)
                           (dissoc post :code_hash)))

(defn create!
  "Mint an invite. Returns `{:success true :extra {:id .. :code ..}}`; the
  plaintext `code` is produced here and never recoverable afterward.

  `opts`:
    :note           human label shown in the minter's list
    :ttl-days       defaults to 14, capped at 365
    :max-uses       defaults to 1. A class link that onboards twenty
                    students is one invite with :max-uses 20, not twenty
                    invites to distribute.
    :grant-admin    admin-only
    :project-id
    :project-role   granted together, applied at redemption
    :target-user-id admin-only; makes this a password reset instead"
  [db {:keys [note ttl-days max-uses grant-admin project-id project-role target-user-id]} actor-id]
  (submit-operation! [tx db {:type :invite/create
                             :project project-id
                             :document nil
                             :description (if target-user-id
                                            (str "Create password reset link for user " target-user-id)
                                            "Create invite")
                             :user actor-id}]
                     (when (some? note) (psc/valid-name? note))
                     (when (not= (nil? project-id) (nil? project-role))
                       (throw (ex-info "project-id and project-role must be given together"
                                       {:code 400})))
                     (when (and project-role (not (#{"reader" "writer" "maintainer"} project-role)))
                       (throw (ex-info (str "Invalid project role: " project-role) {:code 400})))
                     (let [uses-cap (or max-uses 1)]
                       (when-not (and (integer? uses-cap) (pos? uses-cap))
                         (throw (ex-info "max-uses must be a positive integer"
                                         {:code 400 :max-uses uses-cap})))
                       (when (and target-user-id
                                  (or (> uses-cap 1) grant-admin project-id))
                         (throw (ex-info (str "A password reset link is single-use and grants nothing "
                                              "beyond the reset itself")
                                         {:code 400})))
                       (when (and project-id (nil? (psc/fetch-by-id tx :projects project-id)))
                         (throw (ex-info (psc/err-msg-not-found "Project" project-id)
                                         {:code 404 :id project-id})))
                       (when target-user-id
                         (let [target (user/get-internal tx target-user-id)]
                           (when (nil? target)
                             (throw (ex-info (psc/err-msg-not-found "User" target-user-id)
                                             {:code 404 :id target-user-id})))
                           (when (some? (:user/deactivated-at target))
                             (throw (ex-info (str "User " target-user-id " is deactivated. Reactivate "
                                                  "them before issuing a password reset link.")
                                             {:code 400 :id target-user-id})))))
                       (check-grant-authority! tx {:actor-id actor-id
                                                   :grant-admin grant-admin
                                                   :project-id project-id
                                                   :target-user-id target-user-id})
                       (let [id (psc/new-uuid)
                             code (generate-code)
                             row {:id             id
                                  :code_hash      (code-hash code)
                                  :created_by     actor-id
                                  :created_at     (psc/now-iso)
                                  :expires_at     (resolve-expiry ttl-days)
                                  :max_uses       uses-cap
                                  :uses           0
                                  :note           note
                                  :target_user_id target-user-id
                                  :grant_admin    (if grant-admin 1 0)
                                  :project_id     project-id
                                  :project_role   project-role}]
                         (psc/execute! tx {:insert-into :invites :values [row]})
                         (audit-invite-row! tx id :insert nil row)
                         {:id id :code code}))))

(defn revoke!
  "Soft-revoke an invite, killing the link immediately. Idempotent:
  re-revoking keeps the original timestamp. The row survives so the minter's
  list can still show that the link existed and whether it was used before
  being pulled."
  [db id actor-id]
  (submit-operation! [tx db {:type :invite/revoke
                             :project nil
                             :document nil
                             :description (str "Revoke invite " id)
                             :user actor-id}]
                     (let [existing (get-internal tx id)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Invite" id) {:code 404 :id id})))
                       (when (nil? (:revoked_at existing))
                         (let [post (assoc existing :revoked_at (psc/now-iso))]
                           (psc/execute! tx {:update :invites
                                             :set {:revoked_at (:revoked_at post)}
                                             :where [:= :id id]})
                           (audit-invite-row! tx id :update existing post)))
                       id)))

(defn- assert-redeemable!
  "Throw a 4xx unless `row` is a live invite. Runs inside the redemption tx,
  under SQLite's BEGIN IMMEDIATE writer lock, which is what makes the
  use-count check race-free: two people redeeming the last seat of a
  20-use class link serialize here, so exactly one of them gets it."
  [row]
  (when (nil? row)
    (throw (ex-info "That invite code is not valid." {:code 404})))
  (case (status row (psc/now-iso))
    :revoked (throw (ex-info "That invite has been revoked. Ask for a new link."
                             {:code 410 :status "revoked"}))
    :used    (throw (ex-info "That invite has already been used. Ask for a new link."
                             {:code 410 :status "used"}))
    :expired (throw (ex-info "That invite has expired. Ask for a new link."
                             {:code 410 :status "expired"}))
    :active  true))

(defn preview
  "What the unauthenticated signup page may know about a code, or nil if the
  code is unknown. Everything here is already implied by holding the code
  itself, so revealing it costs nothing: the kind of link, the project it
  joins, and (for a reset) whose account it belongs to, so the redeemer can
  tell they were sent the right one.

  Deliberately omits who minted it, the note, and the use count, which are
  the minter's bookkeeping and not the redeemer's business. A dead code
  still previews, carrying its status, so the page can say `expired` rather
  than the flatly unhelpful `invalid`."
  [db code]
  (when-let [row (find-by-code db code)]
    (let [project (when (:project_id row) (psc/fetch-by-id db :projects (:project_id row)))
          ;; The CURRENT username, not `target_user_id`. The two start out
          ;; equal, but a rename changes only `username` — showing the stale
          ;; one would tell the redeemer this link belongs to a name they no
          ;; longer use.
          target (when (:target_user_id row) (user/get-internal db (:target_user_id row)))]
      (cond-> {:kind (if (:target_user_id row) "password-reset" "signup")
               :status (name (status row (psc/now-iso)))
               :expires-at (:expires_at row)
               :grant-admin (->bool (:grant_admin row))}
        (:target_user_id row) (assoc :username (or (:user/username target)
                                                   (:target_user_id row)))
        (:project_id row)     (assoc :project-role (:project_role row)
                                     :project-name (:name project))))))

(defn- redeem-checked!
  "The redemption transaction itself. `row` is the invite that already passed
  the cheap pre-flight in `redeem!`; everything here re-derives from a fresh
  in-tx read, because the pre-flight ran on a pool connection outside any
  transaction and the invite could have been revoked or spent in between.

  ONE operation, so the account, its grant, and the use-count bump commit
  together or not at all — a signup that created an orphan account without
  its project role, or that worked without recording a use, would both be
  worse than a clean failure the redeemer can retry.

  Attribution: the op is recorded against the invite's CREATOR, not the new
  account. `alice created user bob` is the true and useful reading, and the
  alternative (a brand-new account appearing to have authorized itself) puts
  a hole in the audit trail exactly where accounts come from."
  [db invite-row username password]
  (let [inviter (:created_by invite-row)
        reset?  (some? (:target_user_id invite-row))]
    (submit-operation! [tx db {:type :invite/redeem
                               :project (:project_id invite-row)
                               :document nil
                               :description (if reset?
                                              (str "Password reset via invite for user "
                                                   (:target_user_id invite-row))
                                              (str "Create user " username " via invite"))
                               :user inviter}]
                       ;; The authoritative read: under BEGIN IMMEDIATE, so two
                       ;; people racing for the last seat of a class link
                       ;; serialize here and exactly one of them gets it.
                       (let [row (psc/fetch-by-id tx :invites (:id invite-row))]
                         (assert-redeemable! row)
                         (check-grant-authority! tx {:actor-id inviter
                                                     :grant-admin (->bool (:grant_admin row))
                                                     :project-id (:project_id row)
                                                     :target-user-id (:target_user_id row)})
                         (when (str/blank? password)
                           (throw (ex-info "A password is required" {:code 400})))
                         (when (< (count password) min-password-length)
                           (throw (ex-info (str "Password must be at least "
                                                min-password-length " characters")
                                           {:code 400})))
                         ;; Checked here, not just at mint: the target could
                         ;; have been deactivated in between. Without this the
                         ;; reset would "succeed" and hand back a token that
                         ;; wrap-read-jwt rejects on the very next request,
                         ;; which reads as the app being broken rather than as
                         ;; the account being closed.
                         (when reset?
                           (let [target (user/get-internal tx (:target_user_id row))]
                             (when (nil? target)
                               (throw (ex-info "That account no longer exists."
                                               {:code 410})))
                             (when (some? (:user/deactivated-at target))
                               (throw (ex-info (str "That account has been deactivated. "
                                                    "Ask an administrator to reactivate it.")
                                               {:code 403})))))
                         (let [user-id
                               (if reset?
                                 (user/set-password-in-tx! tx (:target_user_id row) password)
                                 (do
                                   (psc/valid-name? username)
                                   (when (re-find #"\s" username)
                                     (throw (ex-info "Username may not contain whitespace"
                                                     {:code 400 :username username})))
                                   (user/insert-user-row! tx username
                                                          (->bool (:grant_admin row))
                                                          password)))]
                           (when (and (not reset?) (:project_id row))
                             (prj/add-role! tx (:project_id row) user-id (:project_role row)))
                           (let [post (update row :uses inc)]
                             (psc/execute! tx {:update :invites
                                               :set {:uses (:uses post)}
                                               :where [:= :id (:id row)]})
                             (audit-invite-row! tx (:id row) :update row post))
                           {:user-id user-id :invite-id (:id row) :reset? reset?})))))

(defn redeem!
  "Spend an invite.

  For a signup, `username` and `password` create the account. For a password
  reset, `username` is ignored and `password` is set on the invite's target.

  Returns `{:success true :extra {:user-id .. :invite-id .. :reset? ..}}`.
  The REST layer signs a JWT from that so the redeemer lands logged in,
  rather than being handed straight back to a login form with credentials
  they typed fifteen seconds ago."
  [db code {:keys [username password]}]
  ;; Pre-flight OUTSIDE the operation, so a bogus or spent code is turned away
  ;; without opening a write transaction — that is the path an attacker
  ;; hammers, and it should stay cheap. The catch is what makes doing it here
  ;; safe: an ExceptionInfo thrown outside `submit-operation!` is NOT projected
  ;; to a structured result by the macro, so without this it would escape
  ;; `redeem!` entirely and reach the client as a 500 instead of the 404/410
  ;; that actually tells the redeemer what went wrong. `redeem-checked!`
  ;; re-runs the same assertion inside the tx, where it IS projected, so this
  ;; one is purely an early out and never the last word.
  (let [pre (try
              (let [row (find-by-code db code)]
                (assert-redeemable! row)
                {:ok row})
              (catch clojure.lang.ExceptionInfo e
                {:failure {:success false
                           :code (or (:code (ex-data e)) 500)
                           :error (ex-message e)}}))]
    (or (:failure pre)
        (redeem-checked! db (:ok pre) username password))))
