(ns glam.models.session
  (:require
    [clojure.spec.alpha :as s]
    [com.fulcrologic.fulcro.server.api-middleware :as fmw]
    [com.fulcrologic.guardrails.core :refer [>defn => | ?]]
    [com.wsscode.pathom.connect :as pc :refer [defresolver defmutation]]
    [dv.fulcro-util :as fu]
    [glam.models.user :as user]
    [glam.neo4j.user :as neo-user]
    [taoensso.timbre :as log]))

(defn augment-session-resp
  "Uses `mutation-response` as the actual return value for a mutation,
   but also stores the data into the session."
  ([mutation-env new-session-data]
   (augment-session-resp mutation-env new-session-data (or new-session-data {})))
  ([mutation-env new-session-data data]
   (let [existing-session (some-> mutation-env :ring/request :session)]
     (log/info "response-updating-session" new-session-data)
     (fmw/augment-response
       data
       (fn [resp]
         (let [new-session (cond->> new-session-data (some? new-session-data) (merge existing-session))]
           (log/info "Setting new session to " new-session)
           (assoc resp :session new-session)))))))

(pc/defmutation signup
  [{:keys [neo4j] :as env} {:keys [email password]}]
  {::pc/sym 'glam.models.session/signup}
  (if-let [user-id (neo-user/get-id-by-email neo4j {:email email})]
    (augment-session-resp env {:session/valid?           false
                               :user/email               email
                               :user/admin?              false
                               :session/server-error-msg "Problem signing up."})
    (do (log/info "doing signup")
        (log/info "inserting user: " email)
        (neo-user/create neo4j {:name          email
                                :email         email
                                :password_hash (user/hash-password password)})
        (augment-session-resp env {:session/valid?           true
                                   :session/server-error-msg nil
                                   :user/email               email
                                   :user/admin?              false}))))

;; todo use a protocol to support pluggable auth
(defmutation login [{:keys [neo4j] :as env} {:keys [username password]}]
  {::pc/output [:session/valid? :user/email :user/admin?]}
  (do
    (log/info "Authenticating" username)
    (let [user-id (neo-user/get-id-by-email neo4j {:email username})]
      (if-let [{hashed-pw :user/password :as user} (user/change-keys (neo-user/get-props neo4j {:uuid user-id}))]
        (do (log/info "User from db: " (dissoc user :user/password))
            (if (user/verify-password password hashed-pw)
              (augment-session-resp env {:session/valid?           true
                                         :user/email               username
                                         :session/server-error-msg nil
                                         :user/admin?              (boolean
                                                                     (:admin
                                                                       (neo-user/get-props neo4j {:uuid user-id})))})
              (do
                (log/error "Invalid credentials supplied for" username)
                (fu/server-error "Invalid credentials"))))
        (fu/server-error "Invalid credentials")))))

(defmutation logout [env params]
  {::pc/output [:session/valid?]}
  (log/info "in logout")
  (augment-session-resp env
                        {:session/valid?           false
                         :session/server-error-msg nil
                         :user/email               ""
                         :user/admin?              false}))

(defresolver current-session-resolver [env _]
  {::pc/output [{::current-session [:session/valid? :user/email :user/admin?]}]}
  (let [{:keys [user/email session/valid? user/admin?] :as session} (get-in env [:ring/request :session])]
    (log/info " in current sesh resolver: " session)
    (if valid?
      (do
        (log/info email "already logged in!")
        {::current-session {:session/valid? true :user/email email :user/admin? admin?}})
      {::current-session {:session/valid? false}})))

(def resolvers [current-session-resolver signup login logout])
