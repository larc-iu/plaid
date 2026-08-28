(ns plaid.rest-api.v1.invite
  "REST surface for invite links (signup) and admin-issued password resets.
  See `plaid.sql.invite` for the model.

  The surface splits in two:

    UNAUTHENTICATED — `/invite-codes/lookup` and `/invite-codes/redeem`.
    These mount beside `/login`, outside `wrap-login-required`, because the
    whole point is that the redeemer has no account yet. Both are POSTs even
    though lookup is a read: an invite code is a bearer credential that can
    create an admin account or reset a password, and a GET would write it
    into the access log, the browser's history, and any proxy in between.
    Bodies stay out of all three. Both are IP rate-limited.

    They live under a different path than the authenticated routes rather
    than at `/invites/lookup`, which would collide with `/invites/:id`. The
    split turns out to read correctly anyway: `/invite-codes` acts on the
    bearer credential someone was handed, `/invites` on the records behind
    them, and the URL says which side of the auth boundary you are on.

    AUTHENTICATED — mint, list, revoke. Any logged-in user may call mint;
    `plaid.sql.invite/check-grant-authority!` decides whether they may grant
    what they asked for, and 403s if not. That keeps one place authoritative
    about who can grant what, rather than splitting the rule between a
    middleware and the write path."
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.pagination :as pagination]
            [plaid.rest-api.v1.rate-limit :as rl]
            [plaid.sql.invite :as invite]
            [plaid.sql.project :as prj]
            [plaid.sql.user :as user]
            [reitit.coercion.malli]))

(defn- ->wire
  "Namespaced invite map → the JSON key shape the API speaks. Never includes
  the code: it exists in exactly one response, the one that mints it."
  [inv]
  {:id             (:invite/id inv)
   :kind           (:invite/kind inv)
   :status         (:invite/status inv)
   :created-by     (:invite/created-by inv)
   :created-at     (:invite/created-at inv)
   :expires-at     (:invite/expires-at inv)
   :max-uses       (:invite/max-uses inv)
   :uses           (:invite/uses inv)
   :revoked-at     (:invite/revoked-at inv)
   :note           (:invite/note inv)
   :target-user-id (:invite/target-user-id inv)
   :grant-admin    (:invite/grant-admin inv)
   :project-id     (:invite/project-id inv)
   :project-role   (:invite/project-role inv)})

;; ============================================================
;; Public (no login) — lookup + redeem
;; ============================================================

(def public-invite-routes
  ["/invite-codes"
   {:middleware [rl/wrap-invite-rate-limit]}

   ["/lookup"
    {:post {:summary (str "Describe an invite code so a signup page can render itself. "
                          "POST rather than GET so the code never lands in an access log, "
                          "browser history, or proxy log. Returns the kind of link "
                          "(<body>signup</body> or <body>password-reset</body>), its status, "
                          "and the project it grants access to, if any. 404 if the code is "
                          "unknown; a known-but-dead code returns 200 with a non-active "
                          "<body>status</body> so the page can explain itself.")
            :parameters {:body {:code string?}}
            :handler (fn [{{{:keys [code]} :body} :parameters db :db :as request}]
                       (if-let [preview (invite/preview db code)]
                         {:status 200 :body preview}
                         (do (rl/record-invite-failure! request)
                             {:status 404 :body {:error "That invite code is not valid."}})))}}]

   ["/redeem"
    {:post {:summary (str "Redeem an invite code. For a signup invite, supply "
                          "<body>username</body> and <body>password</body> to create the "
                          "account; the invite's grants (project role, admin) are applied in "
                          "the same transaction. For a password reset link, supply "
                          "<body>password</body> only and <body>username</body> is ignored. "
                          "Returns a session token so the caller is immediately logged in. "
                          "409 if the username is taken, 410 if the invite is spent, expired, "
                          "or revoked.")
            :parameters {:body [:map
                                [:code string?]
                                [:username {:optional true} string?]
                                [:password string?]]}
            :handler (fn [{{{:keys [code username password]} :body} :parameters
                           db :db secret-key :secret-key :as request}]
                       ;; `status-code`, not `code` — the request body's :code is
                       ;; the invite code and the result's is an HTTP status.
                       (let [{:keys [success extra error] status-code :code}
                             (invite/redeem! db code {:username username :password password})]
                         (if success
                           (let [user-id (:user-id extra)]
                             {:status 200
                              :body {:token (pra/issue-session-token! db secret-key user-id)
                                     :user-id user-id
                                     :kind (if (:reset? extra) "password-reset" "signup")}})
                           (do
                             ;; Only a bad CODE counts against the limiter. A
                             ;; taken username or a short password is the
                             ;; invited user fumbling a form, and locking their
                             ;; whole classroom's IP over it would be perverse.
                             (when (#{404 410} status-code)
                               (rl/record-invite-failure! request))
                             {:status (or status-code 500)
                              :body {:error error}}))))}}]])

;; ============================================================
;; Authenticated — mint, list, revoke
;; ============================================================

(defn- may-see-project-invites?
  [db user-id project-id]
  (or (user/admin? (user/get-internal db user-id))
      (boolean (some #{user-id} (prj/maintainer-ids db project-id)))))

(def invite-routes
  ["/invites"
   {:openapi {:security [{:auth []}]}
    :middleware [pra/wrap-login-required]}

   [""
    {:get {:summary (str "List invites you minted, oldest first, keyset-paginated. "
                         "With <body>project-id</body>, lists that project's invites instead "
                         "(including ones minted by co-maintainers) — requires maintainer or "
                         "admin on that project. Never includes invite codes.")
           :parameters {:query (into [:map [:project-id {:optional true} string?]]
                                     pagination/query-params)}
           :handler (fn [{db :db {query :query} :parameters :as request}]
                      (let [user-id (pra/->user-id request)
                            project-id (:project-id query)]
                        (if project-id
                          (if (may-see-project-invites? db user-id project-id)
                            (pagination/list-response
                             query
                             (fn [opts] (let [{:keys [entries next-cursor]}
                                              (invite/list-for-project db project-id opts)]
                                          {:entries (map ->wire entries)
                                           :next-cursor next-cursor})))
                            {:status 403
                             :body {:error (str "User " user-id " lacks maintainer privileges "
                                                "for project " project-id)}})
                          (pagination/list-response
                           query
                           (fn [opts] (let [{:keys [entries next-cursor]}
                                            (invite/list-for-creator db user-id opts)]
                                        {:entries (map ->wire entries)
                                         :next-cursor next-cursor}))))))}

     :post {:summary (str "Mint an invite and return its code ONCE — the code is never stored "
                          "and can never be shown again. Build the link client-side as "
                          "<body>&lt;app-url&gt;#/invite/&lt;code&gt;</body>.\n\n"
                          "EVERY field is optional. An empty body mints a single-use signup "
                          "link that grants nothing but an account:\n\n"
                          "<body>note</body>: a human label, shown in your invite list.\n\n"
                          "<body>ttl-days</body>: days until expiry. Defaults to 14, capped at "
                          "365. Every invite expires; there is no way to mint one that does "
                          "not.\n\n"
                          "<body>max-uses</body>: how many accounts the link may create. "
                          "Defaults to 1. A class link that onboards twenty students is ONE "
                          "invite with <body>max-uses</body> 20, not twenty invites.\n\n"
                          "<body>project-id</body> and <body>project-role</body>: the project "
                          "the redeemer joins, and how. Individually optional but must be given "
                          "TOGETHER — one without the other is a 400. Role is "
                          "<body>reader</body>, <body>writer</body>, or "
                          "<body>maintainer</body>.\n\n"
                          "<body>grant-admin</body>: make the new account a global admin.\n\n"
                          "<body>target-user-id</body>: turn this into a password reset link "
                          "for that existing user instead of a signup. Mutually exclusive with "
                          "the grant fields — a reset is always single-use and grants nothing, "
                          "so combining it with <body>project-id</body>, "
                          "<body>grant-admin</body>, or a <body>max-uses</body> above 1 is a "
                          "400.\n\n"
                          "Who may ask for what: admins may mint anything. A project maintainer "
                          "may mint role grants on a project they maintain, and nothing else — "
                          "no admin grant, no password reset, and no grantless invite, so in "
                          "practice <body>project-id</body>/<body>project-role</body> are "
                          "required of a non-admin (403 without them). Authority is rechecked "
                          "at redemption, so a link stops working if the minter later loses the "
                          "authority behind it.")
            :parameters {:body [:map
                                [:note {:optional true} string?]
                                [:ttl-days {:optional true} int?]
                                [:max-uses {:optional true} int?]
                                [:grant-admin {:optional true} boolean?]
                                [:project-id {:optional true} string?]
                                [:project-role {:optional true} string?]
                                [:target-user-id {:optional true} string?]]}
            :handler (fn [{{body :body} :parameters db :db :as request}]
                       (let [{:keys [success extra error] status-code :code}
                             (invite/create! db
                                             {:note (:note body)
                                              :ttl-days (:ttl-days body)
                                              :max-uses (:max-uses body)
                                              :grant-admin (:grant-admin body)
                                              :project-id (:project-id body)
                                              :project-role (:project-role body)
                                              :target-user-id (:target-user-id body)}
                                             (pra/->user-id request))]
                         (if success
                           {:status 201
                            :body (merge {:id (:id extra) :code (:code extra)}
                                         (->wire (invite/get db (:id extra))))}
                           {:status (or status-code 500) :body {:error error}})))}}]

   ["/:id"
    {:parameters {:path [:map [:id string?]]}}
    [""
     {:delete {:summary (str "Revoke an invite, killing the link immediately. Idempotent. "
                             "Allowed for the invite's creator, an admin, or a maintainer of "
                             "the project the invite grants access to. The row is kept "
                             "(soft-revoke) so the listing still shows the link existed and "
                             "whether it was used before being pulled.")
               :handler (fn [{{{:keys [id]} :path} :parameters db :db :as request}]
                          (let [user-id (pra/->user-id request)
                                inv (invite/get db id)]
                            (cond
                              (nil? inv)
                              {:status 404 :body {:error "Invite not found"}}

                              (not (or (= user-id (:invite/created-by inv))
                                       (user/admin? (user/get-internal db user-id))
                                       (and (:invite/project-id inv)
                                            (some #{user-id}
                                                  (prj/maintainer-ids db (:invite/project-id inv))))))
                              {:status 403
                               :body {:error "You can only revoke invites you created."}}

                              :else
                              (let [{:keys [success code error]} (invite/revoke! db id user-id)]
                                (if success
                                  {:status 204}
                                  {:status (or code 500)
                                   :body {:error (or error "Internal server error")}})))))}}]]])
