(ns plaid.xtdb.user
  (:require [buddy.hashers :as hashers]
            [xtdb.api :as xt]
            [taoensso.timbre :as log]
            [plaid.xtdb.common :as pxc])
  (:refer-clojure :exclude [get]))

(def attr-keys [:user/id
                :user/username
                :user/password-hash
                :user/password-changes
                :user/is-admin])

;; reads --------------------------------------------------------------------------------
(defn get [db-like id]
  (pxc/find-entity (pxc/->db db-like) {:user/id id}))

(defn admin? [user-record]
  (:user/is-admin user-record))

(defn get-all [db-like]
  (pxc/find-entities (pxc/->db db-like) {:user/id '_}))

;; writes --------------------------------------------------------------------------------
(defn create* [xt-map id is-admin password]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        password-hash (hashers/derive password)
        put [::xt/put {:xt/id                 id
                       :user/id               id
                       :user/username         id
                       :user/password-hash    password-hash
                       :user/password-changes 0
                       :user/is-admin         is-admin}]
        match [::xt/match id nil]]
    (cond
      (some? (pxc/entity db id))
      (throw (ex-info (pxc/err-msg-already-exists "User" id) {:id id :code 409}))

      :else
      [match put])))

(defn create [{:keys [node] :as xt-map} id is-admin password]
  (pxc/submit-with-extras! node (create* xt-map id is-admin password) #(-> % last last :user/id)))

(defn delete* [xt-map eid]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        user (pxc/entity db eid)]
    (cond
      (nil? user)
      (throw (ex-info (str "User does not exist with ID " eid) {:code 404}))

      :else
      [[::xt/match eid user]
       [::xt/delete eid]])))

(defn delete [{:keys [node] :as xt-map} eid]
  (pxc/submit! node (delete* xt-map eid)))