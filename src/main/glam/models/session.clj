(ns glam.models.session
  (:require
    [clojure.spec.alpha :as s]
    [com.fulcrologic.fulcro.server.api-middleware :as fmw]
    [com.fulcrologic.guardrails.core :refer [>defn => | ?]]
    [com.wsscode.pathom.connect :as pc :refer [defresolver defmutation]]
    [glam.models.user :as user]
    [glam.models.common :refer [server-error]]
    [glam.crux.user :as cuser]
    [taoensso.timbre :as log]
    [glam.crux.easy :as gce]))

(defn augment-session-resp
  "Uses `mutation-response` as the actual return value for a mutation,
   but also stores the data into the session."
  ([mutation-env new-session-data]
   (augment-session-resp mutation-env new-session-data (or new-session-data {})))
  ([mutation-env new-session-data data]
   (let [existing-session (some-> mutation-env :ring/request :session)]
     (fmw/augment-response
       data
       (fn [resp]
         (let [new-session (cond->> new-session-data (some? new-session-data) (merge existing-session))]
           (assoc resp :session new-session)))))))

(pc/defmutation signup
  [{:keys [crux] :as env} {:keys [email password]}]
  {}
  (if-let [{:user/keys [id]} (cuser/get-by-email crux email)]
    (augment-session-resp env {:session/valid?           false
                               :user/email               email
                               :user/id                  id
                               :user/admin?              false
                               :session/server-error-msg "Problem signing up."})
    (do (log/info "doing signup")
        (log/info "inserting user: " email)
        ;; TODO should also check for error
        (let [id (:id (cuser/create crux {:user/name          email
                                          :user/email         email
                                          :user/password-hash (user/hash-password password)}))
              admin? (:user/admin? (gce/entity crux id))]
          (augment-session-resp env {:session/valid?           true
                                     :session/server-error-msg nil
                                     :user/email               email
                                     :user/id                  id
                                     :user/admin?              admin?})))))

;; todo use a protocol to support pluggable auth
(defmutation login [{:keys [crux] :as env} {:keys [username password]}]
  {::pc/output [:session/valid? :user/email :user/id :user/admin?]}
  (do
    (log/info "Authenticating" username)
    (if-let [{:user/keys [id password-hash admin?] :as user} (cuser/get-by-email crux username)]
      (do (log/info "Successful login: " (dissoc user :user/password-hash))
          (if (user/verify-password password password-hash)
            (augment-session-resp env {:session/valid?           true
                                       :session/server-error-msg nil
                                       :user/email               username
                                       :user/admin?              admin?
                                       :user/id                  id})
            (do
              (log/error "Invalid credentials supplied for" username)
              (server-error "Invalid credentials"))))
      (server-error "Invalid credentials"))))

(defmutation logout [env params]
  {::pc/output [:session/valid?
                :session/server-error-msg
                :user/email :user/id :user/admin?]}
  (log/info "in logout")
  (augment-session-resp env
                        {:session/valid?           false
                         :session/server-error-msg nil
                         :user/email               ""
                         :user/id                  nil
                         :user/admin?              false}))

(defresolver current-session-resolver [env _]
  {::pc/output [{::current-session [:session/valid? :user/email :user/id :user/admin?]}]}
  (let [{:keys [user/email session/valid? user/admin? user/id] :as session} (get-in env [:ring/request :session])]
    (log/info " in current sesh resolver: " session)
    (if valid?
      (do
        (log/info email "already logged in!")
        {::current-session {:session/valid? true :user/email email :user/admin? admin? :user/id id}})
      {::current-session {:session/valid? false}})))

(def resolvers [current-session-resolver signup login logout])
