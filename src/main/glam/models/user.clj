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
(defresolver user-resolver [{:keys [crux]} {:user/keys [id]}]
  {::pc/input     #{:user/id}
   ::pc/output    [:user/email :user/name :user/admin?]
   ::pc/transform mc/user-required}
  (gc/entity crux id))

(pc/defmutation change-password
  [{:keys [crux] :as env} {:keys [:user/email current-password new-password]}]
  {::pc/transform mc/user-required}
  (let [{:user/keys [id password-hash] :as user} (user/get-by-email crux email)]
    (if (nil? user)
      (server-error (str "No user found with email " email))
      (if-not (verify-password current-password password-hash)
        (server-error (str "Current password incorrect"))
        (do
          (user/set-password-hash crux id new-password)
          (server-message "Password change successful"))))))

;; admin level -------------------------------------------------------------------------------
(pc/defresolver all-users-resolver [{:keys [crux]} _]
  {::pc/output    [{:all-users [:user/id]}]
   ::pc/transform mc/admin-required}
  {:all-users (user/get-all crux)})

(def resolvers [user-resolver
                all-users-resolver
                change-password])
