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

(defn auth-tx [{::pc/keys [resolve] :keys [auth] :as outer-env}]
  "Transform for a Pathom resolver that checks whether the user has sufficient permissions
  for a given operation. Checks the resolver's env for the :auth keyword, which can
  currently be either :user or :admin"
  (assoc
    outer-env
    (if resolve ::pc/resolve ::pc/mutate)
    (fn [env params]
      (if (authorized env auth)
        (resolve env params)
        (server-error (str "Unauthorized mutation: session "
                           (get-in env [:ring/request :session])
                           " does not satisfy authorization requirement "
                           auth))))))