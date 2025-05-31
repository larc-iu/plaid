(ns plaid.rest-api.v1.auth
  "Implements JWT-based authentication and provides authorization middleware."
  (:require [buddy.hashers :as hashers]
            [buddy.sign.jwt :as jwt]
            [plaid.xtdb.access :as pxa]
            [plaid.xtdb.project :as prj]
            [plaid.xtdb.user :as user]
            [taoensso.timbre :as log]))

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
    (if-not (-> request :jwt-data)
      {:status 403
       :body   {:error "Valid token required for this operation."}}
      (handler request))))

(defn wrap-admin-required [handler]
  (fn [{:keys [xtdb] :as request}]
    (let [{:user/keys [is-admin]} (user/get xtdb (-> request :jwt-data :user/id))]
      (if-not is-admin
        {:status 403
         :body   {:error "Admin privileges required for this operation."}}
        (handler request)))))

(defn- -wrap-rw-required
  ([handler key readable? get-id]
   (fn [{xtdb :xtdb :as request}]
     (let [id (get-id request)
           user-id (-> request :jwt-data :user/id)
           f (if readable? pxa/ident-readable? pxa/ident-writeable?)]
       (if-not (f xtdb user-id [key id])
         {:status 403
          :body   {:error (str "User " user-id " lacks sufficient privileges to "
                               (if readable? "read " "edit ") key " " id ".")}}
         (handler request))))))

(defn wrap-readable-required
  ([handler key]
   (wrap-readable-required handler key #(-> % :parameters :path :id)))
  ([handler key get-id]
   (-wrap-rw-required handler key true get-id)))

(defn wrap-writeable-required
  ([handler key]
   (wrap-writeable-required handler key #(-> % :parameters :path :id)))
  ([handler key get-id]
   (-wrap-rw-required handler key false get-id)))

(defn wrap-maintainer-required
  [handler get-project-id]
  (fn [{xtdb :xtdb :as request}]
    (let [user-id (-> request :jwt-data :user/id)
          id (get-project-id request)
          {:project/keys [maintainers]} (prj/get xtdb id)]
      (if-not ((set maintainers) user-id)
        {:status 403
         :body   {:error (str "User " user-id " lacks maintainer privileges for project " id)}}
        (handler request)))))
