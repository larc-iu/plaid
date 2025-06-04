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
   {:post {:summary    "Authenticate a user and get a JWT token"
           :parameters {:body {:username string? :password string?}}
           :handler    (fn [{{{:keys [username password]} :body} :parameters xtdb :xtdb secret-key :secret-key}]
                         (if-let [{:user/keys [id password-changes password-hash]} (user/get xtdb username)]
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
  "Reitit middleware that looks for \"Authorization: Bearer ...\" in the header and attempts to
  decode the bearer token if present. On success, it is stored in the request map under :jwt-data."
  [handler]
  (fn [{:keys [xtdb] :as request}]
    (let [secret-key (:secret-key request)
          auth-header (get-in request [:headers "authorization"])]
      (cond (nil? secret-key)
            (do (log/error "Secret key not found in request! Are middlewares properly ordered?" nil)
                {:status 500 :body {:error (str "Improperly configured server. Contact admin.")}})

            (or (nil? auth-header) (not (.startsWith auth-header "Bearer ")))
            (handler request)

            :else
            (let [token (subs auth-header 7)
                  token-data (try (jwt/unsign token secret-key)
                                  (catch Exception e e))
                  user (and (map? token-data) (user/get xtdb (:user/id token-data)))]
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
                  (log/debug (str "Found JWT data: " token-data))
                  (handler (assoc request :jwt-data token-data)))))))))

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
          id (get-project-id request)
          admin? (user/admin? (user/get xtdb user-id))
          project (prj/get xtdb id)]
      (mapv #(seq ((-> project % set) user-id)) (key levels))
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
