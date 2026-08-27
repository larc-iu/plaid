(ns plaid.rest-api.v1.user
  (:require [clojure.string :as str]
            [plaid.media.avatar :as avatar]
            [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.pagination :as pagination]
            [reitit.coercion.malli]
            [plaid.sql.user :as user]
            [ring.util.response :as response])
  (:import [java.io ByteArrayInputStream]))

(defn- self-or-admin?
  "Profile pictures follow the same rule as PATCH /users/:id: you may change
  your own, and an admin may change anyone's. The admin half is the only
  moderation lever in a shared deployment: without it, a picture nobody else can
  remove is visible to every user."
  [db request id]
  (let [current-user-id (pra/->user-id request)]
    (or (= id current-user-id)
        (user/admin? (user/get db current-user-id)))))

(defn- avatar-cache-headers
  "A picture is addressed by its own content hash (`?v=`), so a URL carrying one
  can never go stale and is cached for a year. A bare URL has no such guarantee
  and gets a minute, enough to collapse the burst of requests a roster of users
  produces without pinning a replaced picture in the cache."
  [versioned?]
  {"Cache-Control" (if versioned?
                     "private, max-age=31536000, immutable"
                     "private, max-age=60")})

(def user-routes
  ["/users"
   {:openapi {:security [{:auth []}]}
    :middleware [pra/wrap-login-required]}

   [""
    {:get {:summary "List/search users, keyset-paginated by username"
           ;; Task #95 locked the roster down to admins (it was an account-
           ;; enumeration surface for any authenticated caller). It's now also
           ;; open to project AND vocab MAINTAINERS, who need to find users to
           ;; grant project/vocab access — see `wrap-user-directory-access`. Ordinary
           ;; readers/writers still get 403. Optional `?q=` filters to usernames
           ;; containing that text. Returns the uniform {:entries :next-cursor}
           ;; envelope (default page 100, max 1000).
           :middleware [pra/wrap-user-directory-access]
           :parameters {:query (into [:map [:q {:optional true} string?]] pagination/query-params)}
           :handler (fn [{db :db {query :query} :parameters}]
                      (pagination/list-response query (fn [opts] (user/get-all db (assoc opts :q (:q query))))))}
     :post {:summary "Create a new user"
            :middleware [pra/wrap-admin-required]
            :parameters {:body {:username string? :password string? :is-admin boolean?}}
            :handler (fn [{{{:keys [username password is-admin]} :body} :parameters db :db user-id :user/id}]
                       (let [result (user/create db username is-admin password user-id)]
                         (if (:success result)
                           {:status 201
                            :body {:id (:extra result)}}
                           {:status (or (:code result) 500)
                            :body {:error (:error result)}})))}}]

   ["/:id"
    {:parameters {:path [:map [:id string?]]}}
    [""
     {:get {:summary "Get a user by ID"
            :handler (fn [{{{:keys [id]} :path} :parameters db :db}]
                       (let [user (user/get db id)]
                         (if (some? user)
                           {:status 200
                            :body user}
                           {:status 404
                            :body {:error "User not found"}})))}
      :patch {:summary (str "Modify a user. Admins may change the username, password, and admin status of any user. "
                            "All other users may only modify their own username or password.")
              :parameters {:body [:map
                                  [:password {:optional true} string?]
                                  [:username {:optional true} string?]
                                  [:is-admin {:optional true} boolean?]]}
              :handler (fn [{{{:keys [id]} :path {:keys [username password is-admin]} :body} :parameters
                             db :db
                             :as request}]
                         (let [current-user-id (pra/->user-id request)
                               current-user (user/get db current-user-id)
                               is-self? (= id current-user-id)
                               is-admin? (user/admin? current-user)]
                           (cond
                             is-admin?
                             (let [{:keys [success code error]} (user/merge db
                                                                            id
                                                                            {:password password
                                                                             :user/username username
                                                                             :user/is-admin is-admin}
                                                                            current-user-id)]
                               (if success
                                 {:status 200
                                  :body (user/get db id)}
                                 {:status (or code 500)
                                  :body {:error error}}))

                             (and is-self? (not is-admin))
                             (let [{:keys [success code error]} (user/merge db
                                                                            id
                                                                            {:password password
                                                                             :user/username username}
                                                                            current-user-id)]
                               (if success
                                 {:status 200
                                  :body (user/get db id)}
                                 {:status (or code 500)
                                  :body {:error error}}))

                             :else
                             {:status 403
                              :body {:error "You can only modify your own username and password"}})))}

      :delete {:summary (str "Deactivate a user. Users are never hard-deleted (audit attribution must "
                             "survive); deactivation rejects their logins and tokens, strips their project "
                             "memberships and vocab maintainerships, and revokes their API tokens. The "
                             "username stays reserved and the user remains visible in listings with a "
                             "<body>deactivated-at</body> timestamp. Reversible via the activate endpoint, "
                             "which restores login only (not memberships or tokens).")
               :middleware [pra/wrap-admin-required]
               :handler (fn [{{{:keys [id]} :path} :parameters db :db user-id :user/id}]
                          (let [{:keys [success code error]} (user/deactivate db id user-id)]
                            (if success
                              {:status 204}
                              {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]
    ["/avatar"
     {:get {:summary (str "Get a user's profile picture. Readable by any logged-in user, matching "
                          "<body>GET /users/:id</body>. Pass the user record's <body>avatar-hash</body> "
                          "as <body>?v=</body> to get an immutable, year-long cache entry that still "
                          "updates the moment the picture changes. Also accepts the JWT as a "
                          "<body>?token=</body> query parameter, since an HTML image element cannot "
                          "send an Authorization header.")
            :handler (fn [{{{:keys [id]} :path} :parameters db :db
                           headers :headers query-params :query-params}]
                       (if-let [{:keys [content-type bytes hash]} (user/get-avatar db id)]
                         (let [etag (str "\"" hash "\"")
                               ;; Blank counts as absent: `?v=` with nothing after
                               ;; it names no particular picture, so it must not
                               ;; earn the immutable cache entry.
                               cache (avatar-cache-headers
                                      (not (str/blank? (get query-params "v"))))]
                           (if (= (get headers "if-none-match") etag)
                             {:status 304 :headers (assoc cache "ETag" etag) :body ""}
                             (-> (response/response (ByteArrayInputStream. bytes))
                                 (response/header "Content-Type" content-type)
                                 (response/header "Content-Length" (str (alength ^bytes bytes)))
                                 (response/header "ETag" etag)
                                 (update :headers merge cache))))
                         {:status 404 :body {:error "User has no profile picture"}}))}

      :put {:summary (str "Upload a profile picture for a user. Your own, or anyone's if you are an "
                          "admin. The image is decoded, center-cropped to a square, scaled to the "
                          "configured edge length, and re-encoded server-side, so camera metadata is "
                          "dropped and EXIF orientation is applied rather than carried. Accepts PNG, "
                          "JPEG, WebP, and GIF. Stores PNG when the source has transparency and JPEG "
                          "otherwise. Replaces any existing picture.")
            :parameters {:path [:map [:id string?]]}
            :openapi {:requestBody {:content {"multipart/form-data"
                                              {:schema {:type "object"
                                                        :properties {:file {:type "string"
                                                                            :format "binary"
                                                                            :description "Image file (PNG, JPEG, WebP, or GIF)"}}
                                                        :required ["file"]}}}}}
            :handler (fn [{{{:keys [id]} :path} :parameters db :db :as request}]
                       (let [file (get (:multipart-params request) "file")
                             temp-file (:tempfile file)]
                         (cond
                           (not (self-or-admin? db request id))
                           {:status 403 :body {:error "You can only change your own profile picture"}}

                           (nil? temp-file)
                           {:status 400 :body {:error "No file provided in multipart upload"}}

                           :else
                           (let [result (avatar/normalize temp-file)]
                             (if-not (:success result)
                               {:status (:code result) :body {:error (:error result)}}
                               (let [{:keys [success code error]}
                                     (user/set-avatar! db id result (pra/->user-id request))]
                                 (if success
                                   {:status 200 :body (user/get db id)}
                                   {:status (or code 500) :body {:error error}})))))))}

      :delete {:summary "Remove a user's profile picture. Your own, or anyone's if you are an admin."
               :handler (fn [{{{:keys [id]} :path} :parameters db :db :as request}]
                          (if-not (self-or-admin? db request id)
                            {:status 403 :body {:error "You can only change your own profile picture"}}
                            (let [{:keys [success code error]}
                                  (user/delete-avatar! db id (pra/->user-id request))]
                              (if success
                                {:status 204}
                                {:status (or code 500) :body {:error error}}))))}}]
    ["/activate"
     {:post {:summary (str "Reactivate a deactivated user, restoring their ability to log in. Project "
                           "memberships, vocab maintainerships, and API tokens removed at deactivation "
                           "are NOT restored — re-grant them deliberately. 400 if the user is not "
                           "deactivated.")
             :middleware [pra/wrap-admin-required]
             :handler (fn [{{{:keys [id]} :path} :parameters db :db user-id :user/id}]
                        (let [{:keys [success code error]} (user/reactivate db id user-id)]
                          (if success
                            {:status 200 :body (user/get db id)}
                            {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]]])
