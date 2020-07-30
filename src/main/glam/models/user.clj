(ns glam.models.user
  (:require [clojure.set :refer [rename-keys]]
            [clojure.spec.alpha :as s]
            [cryptohash-clj.impl.argon2 :refer [chash verify]]
            [com.fulcrologic.guardrails.core :refer [>defn => | ?]]
            [com.wsscode.pathom.connect :as pc :refer [defresolver defmutation]]
            [taoensso.timbre :as log]
            [glam.crux.user :as user]
            [glam.models.common :as mc :refer [server-error server-message]]
            [glam.crux.common :as gc]))

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
            (gc/find-entity-id crux {:user/email email}))
        (do (log/info "no user")
            nil)))))

;; user level --------------------------------------------------------------------------------
;; todo: should this only work for the user's own id?
(defresolver user-resolver [{:keys [crux]} {:user/keys [id]}]
  {::pc/input     #{:user/id}
   ::pc/output    [:user/email :user/name :user/admin?]
   ::pc/transform mc/user-required}
  (gc/entity crux id))

(pc/defmutation change-own-password
  [{:keys [crux] :as env} {:keys [:user/email current-password new-password]}]
  {::pc/transform mc/user-required}
  (let [id (get-current-user env)
        {:user/keys [password-hash]} (gc/entity crux id)]
    (if (nil? id)
      (server-error (str "No user found with email " email))
      (if-not (verify-password current-password password-hash)
        (server-error (str "Current password incorrect"))
        (do
          (user/set-password-hash crux id (hash-password new-password))
          (server-message "Password change successful"))))))

(pc/defmutation change-own-name
  [{:keys [crux] :as env} {:keys [name]}]
  {::pc/transform mc/user-required}
  (let [user-id (get-current-user env)]
    (if (nil? user-id)
      (server-error (str "No valid user found while attempting to change name"))
      (let [same-names (gc/find-entities crux {:user/name name})]
        (if (and (not (empty? same-names)) (not= user-id (-> same-names first :user/id)))
          (server-error (str "Name \"" name "\" already taken"))
          (do (user/set-name crux user-id name)
              (server-message (str "Name changed to " name))))))))

;; admin level -------------------------------------------------------------------------------
(pc/defresolver all-users-resolver [{:keys [crux]} _]
  {::pc/output    [{:all-users [:user/id]}]
   ::pc/transform mc/admin-required}
  {:all-users (user/get-all crux)})

(pc/defmutation set-name [{:keys [crux]} {:user/keys [id name]}]
  {::pc/transform mc/admin-required}
  (user/set-name crux id name))

(pc/defmutation set-email [{:keys [crux]} {:user/keys [id email]}]
  {::pc/transform mc/admin-required}
  (user/set-email crux id email))

(pc/defmutation set-admin? [{:keys [crux]} {:user/keys [id admin?]}]
  {::pc/transform mc/admin-required}
  (user/set-admin? crux id admin?))

(pc/defmutation delete-user [{:keys [crux]} {:user/keys [id]}]
  {::pc/transform mc/admin-required}
  (user/delete crux id))

(def resolvers [user-resolver
                all-users-resolver
                change-own-password
                change-own-name
                set-name
                set-email
                set-admin?
                delete-user])
