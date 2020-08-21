(ns glam.models.auth
  (:require [taoensso.timbre :as log]
            [glam.models.common :as mc]
            [com.wsscode.pathom.connect :as pc]))



(defn level-authorized
  "Given a resolver's environment, say whether it is authorized for a given level"
  [level env]
  (let [{:keys [session/valid? user/admin?]} (get-in env [:ring/request :session])]
    (or (nil? level)
        (and (= level :admin) admin?)
        (and (= level :user) valid?))))

;; pathom security transforms
(defn make-auth-transform [auth-fn failure-message]
  "Make a transform for a Pathom resolver that checks whether the user has sufficient
  permissions for a given operation. auth-fn is a single-arg function env -> boolean"
  (fn auth-transform [{::pc/keys [mutate resolve] :as outer-env}]
    (let [pathom-action (if mutate mutate resolve)
          pathom-action-kwd (if mutate ::pc/mutate ::pc/resolve)]
      (-> outer-env
          (assoc
            pathom-action-kwd
            (fn [env params]
              (println "!!!!")
              (println (keys env))
              (println (::pc/resolver-data env))
              (println params)
              (if (auth-fn env)
                (pathom-action env params)
                (mc/server-error (str "Unauthorized pathom action: session "
                                   (get-in env [:ring/request :session])
                                   " does not satisfy authorization requirement: "
                                   failure-message)))))))))


(def admin-required (make-auth-transform (partial level-authorized :admin) "admin required"))
(def user-required (make-auth-transform (partial level-authorized :user) "valid login required"))
