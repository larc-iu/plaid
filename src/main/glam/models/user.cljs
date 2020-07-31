(ns glam.models.user
  (:require [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.components :as c]))

(defmutation change-own-password
  "Changes the user's password given a :user/email, :current-password, and :new-password.
  on-ok and on-error are lambdas that will be executed when a server response is given
  with any server message passed to it "
  [args]
  (action [{:keys [app]}] (log/info "Beginning change-password"))
  (remote [{:keys [ast]}] (update ast :params dissoc :on-result :on-ok :on-error)))

(defmutation change-own-name
  "Change :user/name"
  [args]
  (action [{:keys [app]}] (log/info "Begin change name"))
  (remote [{:keys [ast]}] true))

;; admin --------------------------------------------------------------------------------
(defmutation delete-user
  [args]
  (action [{:keys [app]}] (log/info "Beginning delete-user"))
  (remote [{:keys [ast]}] true))