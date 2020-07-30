(ns glam.models.user
  (:require [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.components :as c]))

(defmutation change-own-password
  "Changes the user's password given a :user/email, :current-password, and :new-password.
  on-success and on-error are transaction vectors that will be transacted when a server
  response is given. :message-handler is a fn that will be given the server message,
  if there is one"
  [{:keys [on-success on-error message-handler form-component]}]
  (action [{:keys [app]}]
    (log/info "Beginning change-password"))
  (remote [{:keys [ast]}]
    (update ast :params dissoc :message-handler :form-component :on-success :on-error))
  (ok-action [{:keys [result] :as env}]
    (log/info "change password OK")
    (when (vector? on-success)
      (c/transact! form-component on-success))
    (if-let [message (get-in result [:body `change-own-password])]
      (message-handler message)))
  (error-action [{:keys [result] :as env}]
    (log/info "change password error")
    (when-not (empty? on-error)
      (c/transact! form-component on-error))
    (if-let [message (get-in result [:body `change-own-password])]
      (message-handler message))))

(defmutation change-own-name
  "Change :user/name"
  [{:keys [callback]}]
  (action [{:keys [app]}]
    (log/info "Begin change name"))
  (remote [{:keys [ast]}]
    (update ast :params dissoc :callback))
  (ok-action [{:keys [result]}]
    (when-let [response (get-in result [:body `change-own-name])]
      (log/info (pr-str response))
      (callback response)))
  (error-action [{:keys [result]}]
    (when-let [response (get-in result [:body `change-own-name])]
      (callback response))))

;; admin --------------------------------------------------------------------------------
(defmutation delete-user
  [{:keys [name on-success]}]
  (action [{:keys [app]}]
    (log/info "Begin change name"))
  (remote [{:keys [ast]}]
    (update ast :params dissoc :on-success))
  (ok-action [_]
    (on-success)))