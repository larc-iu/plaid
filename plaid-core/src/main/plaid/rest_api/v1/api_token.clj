(ns plaid.rest-api.v1.api-token
  "REST surface for named per-user API tokens. Tokens are user-scoped:
  `/users/:user-id/tokens`. A user manages their own tokens; a global admin
  may manage anyone's. Minting returns the signed JWT exactly ONCE."
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.sql.api-token :as api-token]
            [plaid.sql.user :as user]
            [reitit.coercion.malli]))

(defn wrap-self-or-admin
  "Authorize only the path `:user-id` owner or a global admin. 403 otherwise.
  Authentication (a valid token) is already guaranteed by the inherited
  `wrap-login-required`, so this is purely the ownership check."
  [handler]
  (fn [{{{:keys [user-id]} :path} :parameters :as request}]
    (let [current-user-id (pra/->user-id request)
          admin? (user/admin? (:user/record request))]
      (if (or admin? (= user-id current-user-id))
        (handler request)
        {:status 403
         :body {:error "You can only manage your own API tokens."}}))))

(def api-token-routes
  ["/users/:user-id/tokens"
   {:openapi {:security [{:auth []}]}
    :parameters {:path [:map [:user-id string?]]}
    :middleware [pra/wrap-login-required wrap-self-or-admin]}

   [""
    {:get {:summary "List a user's named API tokens (never includes the signed token itself)."
           :openapi {:x-client-bundle "apiTokens"
                     :x-client-method "list"}
           :handler (fn [{{{:keys [user-id]} :path} :parameters db :db}]
                      {:status 200
                       :body (api-token/list-for-user db user-id)})}
     :post {:summary (str "Mint a named API token for the user. The signed token string is "
                          "returned ONCE in the response and never again — store it securely. "
                          "API tokens do not expire and survive password changes / logout; "
                          "use DELETE to revoke.")
            :openapi {:x-client-bundle "apiTokens"
                      :x-client-method "create"}
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
     {:delete {:summary "Revoke a named API token. Idempotent; the row is kept (soft-revoke) so the audit log can still resolve it."
               :openapi {:x-client-bundle "apiTokens"
                         :x-client-method "revoke"}
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
