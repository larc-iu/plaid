(ns glam.models.common
  (:require [com.wsscode.pathom.connect :as pc]
            [com.wsscode.pathom.parser :as pp]
            [taoensso.timbre :as log]))

(defn server-message [msg]
  {:server/message msg
   :server/error?  false})

(defn server-error [msg]
  {:server/message msg
   :server/error?  true})

(defn authorized
  "Given a resolver's environment, say whether it is authorized for a given level"
  [env level]
  (let [{:keys [session/valid? user/admin?]} (get-in env [:ring/request :session])]
    (or (nil? level)
        (and (= level :admin) admin?)
        (and (= level :user) valid?))))

;; pathom security transforms
(defn make-auth-transform [mutate? level]
  "Make a transform for a Pathom resolver that checks whether the user has sufficient
  permissions for a given operation. mutate? is a bool that indicates whether this is
  for a resolver or a mutation, and level is one of :admin or :user indicating required
  permissions."
  (fn auth-transform [outer-env]
    (assoc
      outer-env
      (if mutate? ::pc/mutate ::pc/resolve)
      (fn [env params]
        (log/info (str "authorized? " (authorized env level)))
        (let [action ((if mutate? ::pc/mutate ::pc/resolve) outer-env)
              res (if (authorized env level)
                    (action env params)
                    (server-error (str "Unauthorized pathom action: session "
                                       (get-in env [:ring/request :session])
                                       " does not satisfy authorization requirement "
                                       level)))]
          (log/info (str "auth-tx output: " (pr-str res)))
          res)))))

(def admin-mutation-transform (make-auth-transform true :admin))
(def admin-resolver-transform (make-auth-transform false :admin))
(def user-mutation-transform (make-auth-transform true :user))
(def user-resolver-transform (make-auth-transform false :user))
