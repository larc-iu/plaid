(ns plaid.rest-api.v1.auth
  "Implements JWT-based authentication and provides authorization middleware."
  (:require [buddy.hashers :as hashers]
            [buddy.sign.jwt :as jwt]
            [plaid.xtdb.project :as prj]
            [plaid.xtdb.user :as user]
            [taoensso.timbre :as log]
            [xtdb.api :as xt]))

(def authentication-routes
  ["/login"
   {:post {:summary    (str "Authenticate with a <body>user-id</body> and <body>password</body> and get a JWT token. The token should be included "
                            "in request headers under \"Authorization: Bearer ...\" in order to prove successful "
                            "authentication to the server.")
           :parameters {:body {:user-id string? :password string?}}
           :handler    (fn [{{{:keys [user-id password]} :body} :parameters xtdb :xtdb secret-key :secret-key}]
                         (if-let [{:user/keys [id password-changes password-hash]} (user/get-internal xtdb user-id)]
                           (if (hashers/check password password-hash)
                             (let [token (jwt/sign {:user/id id :version password-changes} secret-key)]
                               {:status 200
                                :body   {:token token}})
                             {:status 401
                              :body   {:error "Invalid password"}})
                           {:status 401
                            :body   {:error "User not found"}}))}}])

(defn ->user-id [request]
  (-> request :jwt-data :user/id))

(defn wrap-read-jwt
  "Reitit middleware that looks for JWT tokens in either:
  1. \"Authorization: Bearer ...\" header (standard approach)
  2. \"token\" query parameter (for EventSource compatibility)
  
  On success, token data is stored in the request map under :jwt-data."
  [handler]
  (fn [{:keys [xtdb] :as request}]
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
                  user (and (map? token-data) (user/get-internal xtdb (:user/id token-data)))]
              (cond
                (instance? Exception token-data)
                (do (log/warn token-data "JWT validation error")
                    {:status 401
                     :body   {:error (str "Token invalid. Obtain a new token.")}})

                (nil? user)
                {:status 401
                 :body   {:error (str "Token invalid because user does not exist.")}}

                (not= (:version token-data)
                      (:user/password-changes user))
                {:status 401
                 :body   {:error (str "Token invalid because password has changed.")}}

                :else
                (do
                  (log/debug (str "Found JWT data: " token-data " (source: "
                                  (if (and auth-header (.startsWith auth-header "Bearer ")) "header" "query") ")"))
                  (handler (assoc request
                             :jwt-data token-data
                             :user/id (:user/id token-data))))))))))

(defn wrap-login-required [handler]
  (fn [request]
    (if-not (->user-id request)
      {:status 403
       :body   {:error "Valid token required for this operation."}}
      (handler request))))

(defn wrap-admin-required [handler]
  (fn [{:keys [xtdb] :as request}]
    (let [user (user/get xtdb (->user-id request))]
      (if-not (user/admin? user)
        {:status 403
         :body   {:error "Admin privileges required for this operation."}}
        (handler request)))))

(def ^:private levels
  {:project/readers     [:project/readers :project/writers :project/maintainers]
   :project/writers     [:project/writers :project/maintainers]
   :project/maintainers [:project/maintainers]})

(def ^:private verb
  {:project/readers     "read"
   :project/writers     "write for"
   :project/maintainers "maintain"})

(defn wrap-project-privileges-required
  [handler key get-project-id]
  (when-not (-> levels keys set key)
    (throw (ex-info "Bad key" {:key key})))
  (fn [{xtdb :xtdb :as request}]
    (let [user-id (->user-id request)
          id (get-project-id {:parameters (:parameters request)
                              :db (or (:db request) (xt/db xtdb))})
          admin? (user/admin? (user/get xtdb user-id))
          project (prj/get xtdb id)]
      (if-not (or admin? (some #(seq ((-> project % set) user-id)) (key levels)))
        {:status 403
         :body   {:error (str "User " user-id " lacks sufficient privileges to " (key verb) " project " id)}}
        (handler request)))))

(defn wrap-reader-required [handler get-project-id]
  (wrap-project-privileges-required handler :project/readers get-project-id))
(defn wrap-writer-required [handler get-project-id]
  (wrap-project-privileges-required handler :project/writers get-project-id))
(defn wrap-maintainer-required [handler get-project-id]
  (wrap-project-privileges-required handler :project/maintainers get-project-id))


