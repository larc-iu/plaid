(ns glam.models.user
  (:require [clojure.set :refer [rename-keys]]
            [clojure.spec.alpha :as s]
            [cryptohash-clj.impl.argon2 :refer [chash verify]]
            [com.fulcrologic.guardrails.core :refer [>defn => | ?]]
            [com.wsscode.pathom.connect :as pc :refer [defresolver defmutation]]
            [taoensso.timbre :as log]
            [glam.crux.user :as user]
            [glam.models.common :as mc :refer [server-error server-message]]
            [glam.models.user-common :as uc]
            [glam.crux.common.easy :as cce]))

(defn hash-password [password]
  (chash password))

(defn verify-password [input hashed]
  (verify input hashed))

(defn get-current-user
  "Reads username (email) from the ring session and returns the ID"
  [{:keys [crux] :ring/keys [request] :as env}]
  (when-let [session (:session request)]
    (when (:session/valid? session)
      (if-let [email (:user/email session)]
        (do (log/info "HAVE A USER: " email)
            (cce/find-entity-id crux {:user/email email}))
        (do (log/info "no user")
            nil)))))

;; user level --------------------------------------------------------------------------------
;; todo: should this only work for the user's own id?
(defresolver user-resolver [{:keys [crux]} {:user/keys [id]}]
  {::pc/input     #{:user/id}
   ::pc/output    [:user/email :user/name :user/admin?]
   ::pc/transform mc/user-required}
  (cce/entity crux id))

(pc/defmutation change-own-password
  [{:keys [crux] :as env} {:keys [current-password new-password]}]
  {::pc/transform mc/user-required}
  (let [id (get-current-user env)
        {:user/keys [password-hash]} (cce/entity crux id)]
    (cond
      ;; user must be valid
      (nil? id)
      (server-error "Invalid session")
      ;; current password must be correct
      (not (verify-password current-password password-hash))
      (server-error (str "Current password incorrect"))
      ;; new password must be valid
      (not (uc/valid-password new-password))
      (server-error "New password is invalid")
      :else
      (do
        (user/set-password-hash crux id (hash-password new-password))
        (server-message "Password change successful")))))

(pc/defmutation change-own-name
  [{:keys [crux] :as env} {:keys [name]}]
  {::pc/transform mc/user-required}
  (let [user-id (get-current-user env)
        same-names (cce/find-entities crux {:user/name name})]
    (cond
      ;; user must be valid
      (nil? user-id)
      (server-error (str "No valid user found while attempting to change name"))
      ;; name must not be taken
      (and (not (empty? same-names)) (not= user-id (-> same-names first :user/id)))
      (server-error (str "Name \"" name "\" already taken"))
      ;; name must be valid
      (not (uc/valid-name name))
      (server-error (str "Name \"" name "\" is invalid"))
      :else
      (do
        (user/set-name crux user-id name)
        (server-message (str "Name changed to " name))))))

;; admin level -------------------------------------------------------------------------------
(pc/defresolver all-users-resolver [{:keys [crux]} _]
  {::pc/output    [{:all-users [:user/id]}]
   ::pc/transform mc/admin-required}
  {:all-users (user/get-all crux)})

(pc/defmutation delete-user [{:keys [crux]} {:user/keys [id]}]
  {::pc/transform mc/admin-required}
  (if-not (cce/entity crux id)
    (server-error (str "User not found by ID " id))
    (let [name (:user/name (cce/entity crux id))]
      (user/delete crux id)
      (server-message (str "User " name " deleted")))))

(pc/defmutation save-user [{:keys [crux]} {delta :delta [_ id] :ident :as params}]
  {::pc/transform mc/admin-required
   ::pc/output [:server/error? :server/message]}
  (let [old-user (cce/entity crux id)
        new-user (mc/apply-delta old-user delta)]
    (cond
      ;; email must be unique
      (and (some-> delta :user/email :after) (cce/find-entity crux {:user/email (-> delta :user/email :after)}))
      (server-error (str "User already exists with email " (-> delta :user/email :after)))
      ;; must be valid
      (not (mc/validate-delta uc/record-valid? delta))
      (server-error (str "User delta invalid: " delta))
      :else
      (do
        (cce/put crux new-user)
        (cce/entity crux id)))))

(def resolvers [user-resolver
                all-users-resolver
                change-own-password
                change-own-name
                delete-user
                save-user])
