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
(defn make-auth-transform [level]
  "Make a transform for a Pathom resolver that checks whether the user has sufficient
  permissions for a given operation. mutate? is a bool that indicates whether this is
  for a resolver or a mutation, and level is one of :admin or :user indicating required
  permissions."
  (fn auth-transform [{::pc/keys [mutate resolve] :as outer-env}]
    (let [pathom-action (if mutate mutate resolve)
          pathom-action-kwd (if mutate ::pc/mutate ::pc/resolve)]
      (-> outer-env
          (assoc
            pathom-action-kwd
            (fn [env params]
              (log/info (str "authorized? " (authorized env level)))
              (if (authorized env level)
                (pathom-action env params)
                (server-error (str "Unauthorized pathom action: session "
                                   (get-in env [:ring/request :session])
                                   " does not satisfy authorization requirement "
                                   level)))))))))

(defn apply-delta [entity delta]
  (let [new-vals (into {} (for [[k {:keys [after]}] delta]
                            [k after]))
        new-entity (merge entity new-vals)]
    new-entity))

(defn validate-delta [record-valid-fn delta]
  (let [new-vals (into {} (for [[k {:keys [after]}] delta]
                            [k after]))]
    (record-valid-fn new-vals)))

(def admin-required (make-auth-transform :admin))
(def user-required (make-auth-transform :user))
