(ns plaid.rest-api.v1.api-token
  "REST surface for named per-user API tokens. Tokens are user-scoped:
  `/users/:user-id/tokens`. A user manages their own tokens; a global admin
  may manage anyone's. Minting returns the signed JWT exactly ONCE."
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.pagination :as pagination]
            [plaid.sql.api-token :as api-token]
            [plaid.sql.user :as user]
            [reitit.coercion.malli]))

(defn self-or-admin
  "Middleware that authorizes only the path `:user-id` owner or a global
  admin, and answers anyone else 403 with `refusal`. Authentication (a valid
  token) is already guaranteed by the inherited `wrap-login-required`, so
  this is purely the ownership check."
  [refusal]
  (fn [handler]
    (fn [{{{:keys [user-id]} :path} :parameters :as request}]
      (let [current-user-id (pra/->user-id request)
            admin? (user/admin? (:user/record request))]
        (if (or admin? (= user-id current-user-id))
          (handler request)
          {:status 403
           :body {:error refusal}})))))

(def wrap-self-or-admin
  (self-or-admin "You can only manage your own API tokens."))

(def session-only-refusal
  {:status 403
   :body {:error "This needs a signed-in session, not an API token."}})

(defn named-token?
  "True when the request is signed with a named API token (the `:api-token/id`
  that `wrap-read-jwt` sets). Session and delegated tokens carry none."
  [request]
  (some? (:api-token/id request)))

(defn wrap-session-required
  "Refuse a request signed with a named API token. A named token is handed to
  services and scripts and never expires, so credentials stay out of its
  reach: it may not change a password, mint or revoke API tokens, make a
  password reset link, create an account (which comes with a password), mint
  an invite, change who is an admin, or deactivate or reactivate an account.
  Otherwise one that leaked would be the whole account, and
  what it made (a token, a login) would outlive revoking it."
  [handler]
  (fn [request]
    (if (named-token? request)
      session-only-refusal
      (handler request))))

(def api-token-routes
  ["/users/:user-id/tokens"
   {:openapi {:security [{:auth []}]}
    :parameters {:path [:map [:user-id string?]]}
    :middleware [pra/wrap-login-required wrap-self-or-admin pra/wrap-path-user-required]}

   [""
    {:get {:summary "List a user's named API tokens (never includes the signed token itself); keyset-paginated."
           :parameters {:query (into [:map] pagination/query-params)}
           :handler (fn [{{{:keys [user-id]} :path query :query} :parameters db :db}]
                      (pagination/list-response query (fn [opts] (api-token/list-for-user db user-id opts))))}
     :post {:plaid/idempotency false
            :summary (str "Mint a named API token for the user. The signed token string is "
                          "returned ONCE in the response and never again — store it securely. "
                          "API tokens do not expire and survive password changes / logout; "
                          "use DELETE to revoke. Needs a signed-in session: a request signed "
                          "with a named API token is refused (403).")
            :middleware [wrap-session-required]
            :parameters {:body {:name string?}}
            :handler (fn [{{{:keys [user-id]} :path {:keys [name]} :body} :parameters
                           db :db secret-key :secret-key :as request}]
                       (let [{:keys [success code error] :as result}
                             (pra/issue-api-token! db secret-key user-id name (pra/->user-id request))]
                         (if success
                           {:status 201
                            :body (select-keys result [:id :name :token])}
                           {:status (or code 500)
                            :body {:error error}})))}}]

   ["/:token-id"
    {:parameters {:path [:map [:token-id string?]]}}
    [""
     {:delete {:summary (str "Revoke a named API token. Idempotent; the row is kept (soft-revoke) so "
                             "the audit log can still resolve it. Needs a signed-in session: a "
                             "request signed with a named API token is refused (403).")
               :middleware [wrap-session-required]
               :handler (fn [{{{:keys [user-id token-id]} :path} :parameters db :db :as request}]
                          ;; Confirm the token belongs to the path user before
                          ;; revoking — gives a clean 404 for unknown ids and
                          ;; stops an admin/owner from revoking via a mismatched
                          ;; :user-id in the path.
                          (let [tok (api-token/get db token-id)]
                            (if (or (nil? tok) (not= user-id (:api-token/user-id tok)))
                              {:status 404
                               :body {:error "API token not found"}}
                              (let [{:keys [success code error]}
                                    (api-token/revoke! db token-id (pra/->user-id request))]
                                (if success
                                  {:status 204}
                                  {:status (or code 500)
                                   :body {:error (or error "Internal server error")}})))))}}]]])
