(ns glam.models.auth
  (:require [taoensso.timbre :as log]
            [glam.models.common :as mc]
            [com.wsscode.pathom.connect :as pc]
            [glam.crux.easy :as gce]))



;; pathom security transforms
(defn make-auth-transform [auth-fn failure-message]
  "Make a transform for a Pathom resolver that checks whether the user has sufficient
  permissions for a given operation. auth-fn is a 2-arg function env -> params -> boolean"
  (fn auth-transform [{::pc/keys [mutate resolve] :as outer-env}]
    (let [pathom-action (if mutate mutate resolve)
          pathom-action-kwd (if mutate ::pc/mutate ::pc/resolve)]
      (-> outer-env
          ;; apply the transformation
          (assoc
            pathom-action-kwd
            (fn [env params]
              (log/info (str "Hit resolver/mutator: " (pr-str (::pc/resolver-data env))))
              (if (auth-fn env params)
                (pathom-action env params)
                (let [msg (str "Unauthorized pathom action: session " (get-in env [:ring/request :session])
                               " does not satisfy authorization requirement: " failure-message)]
                  (log/warn (str "Unauthorized request: " msg))
                  (mc/server-error msg)))))))))

(defn- project-readable [id-key {:keys [crux] :as env} params]
  (when-not (id-key params)
    (throw (ex-info "Tried to determine if id-key was readable for a user, but it was not present in params."
                    {:id-key id-key
                     :params params
                     :resolver-env env})))
  (let [{user-id :user/id} (get-in env [:ring/request :session])
        {:user/keys [reader writer]} (gce/entity crux user-id)
        id (id-key params)]
    (case id-key
      :project/id (or (contains? reader id) (contains? writer id)))))
(defn- project-writeable [id-key {:keys [crux] :as env} params]
  (when-not (id-key params)
    (throw (ex-info "Tried to determine if id-key was writeable for a user, but it was not present in params."
                    {:id-key id-key
                     :params params
                     :resolver-env env})))
  (let [{user-id :user/id} (get-in env [:ring/request :session])
        {:user/keys [writer]} (gce/entity crux user-id)
        id (id-key params)]
    (case id-key
      :project/id (contains? writer id))))
(defn project-readable-required [id-key]
  (make-auth-transform (partial project-readable id-key) "current user cannot read the project involved in this query"))
(defn project-writeable-required [id-key]
  (make-auth-transform (partial project-writeable id-key) "current user cannot modify the project involved in this query"))

(defn- level-authorized
  "Given a resolver's environment, say whether it is authorized for a given level"
  [level env params]
  (let [{:keys [session/valid? user/admin?]} (get-in env [:ring/request :session])]
    (or (nil? level)
        (and (= level :admin) admin?)
        (and (= level :user) valid?))))
(def admin-required (make-auth-transform (partial level-authorized :admin) "admin required"))
(def user-required (make-auth-transform (partial level-authorized :user) "valid login required"))
