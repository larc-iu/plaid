(ns plaid.xtdb2.user
  (:require [buddy.hashers :as hashers]
            [xtdb.api :as xt]
            [taoensso.timbre :as log]
            [plaid.xtdb2.common :as pxc])
  (:refer-clojure :exclude [get merge]))

(def attr-keys
  [:user/id
   :user/username
   :user/password-hash
   :user/password-changes
   :user/is-admin])

;; reads ---------------------------------------------------------------------------

(defn get-internal
  "Get a user by ID with all fields (including sensitive ones)."
  [node-or-map id]
  (pxc/entity node-or-map :users id))

(defn get
  "Get a user by ID formatted for external consumption."
  [node-or-map id]
  (when-let [user (get-internal node-or-map id)]
    (select-keys user [:user/id :user/username :user/is-admin])))

(defn admin? [user-record]
  (:user/is-admin user-record))

(defn get-all
  "Get all users formatted for external consumption."
  [node-or-map]
  (map #(select-keys % [:user/id :user/username :user/is-admin])
       (pxc/find-entities node-or-map :users {})))

(defn find-by-username
  "Find a user by username. Returns full internal record."
  [node-or-map username]
  (let [node (pxc/->node node-or-map)]
    (pxc/find-entity node :users {:user/username username})))

;; writes --------------------------------------------------------------------------

(defn create*
  "Returns transaction ops to create a new user. Throws if user already exists."
  [xt-map id is-admin password]
  (let [node         (pxc/->node xt-map)
        password-hash (hashers/derive password)
        existing      (pxc/entity node :users id)]
    (when (some? existing)
      (throw (ex-info (pxc/err-msg-already-exists "User" id) {:id id :code 409})))
    [[:put-docs :users {:xt/id                 id
                        :user/id               id
                        :user/username         id
                        :user/password-hash    password-hash
                        :user/password-changes 0
                        :user/is-admin         is-admin}]]))

(defn create
  [{:keys [node] :as xt-map} id is-admin password]
  (pxc/submit! node (create* xt-map id is-admin password)
               #(-> % last last :user/id)))

(defn merge
  [xt-map eid m]
  (when-let [name (:user/username m)]
    (pxc/valid-name? name))
  (let [node   (pxc/->node xt-map)
        intern (get-internal node eid)
        attrs  (select-keys intern [:user/password-hash :user/password-changes
                                    :user/username :user/is-admin])
        attrs  (if-let [new-password (:password m)]
                 (-> attrs
                     (assoc :user/password-hash (hashers/derive new-password))
                     (update :user/password-changes inc))
                 attrs)
        attrs  (-> attrs
                   (cond-> (some? (:user/username m))  (assoc :user/username (:user/username m)))
                   (cond-> (some? (:user/is-admin m))  (assoc :user/is-admin (:user/is-admin m))))]
    (pxc/submit! node (pxc/merge* xt-map :users :user/id eid attrs))))

(defn delete*
  "Returns transaction ops to delete a user. Throws if user not found."
  [xt-map eid]
  (let [node (pxc/->node xt-map)
        user (pxc/entity-with-sys-from node :users eid)]
    (when (nil? user)
      (throw (ex-info (str "User does not exist with ID " eid) {:code 404})))
    [(pxc/match* :users user)
     [:delete-docs :users eid]]))

(defn delete
  [{:keys [node] :as xt-map} eid]
  (pxc/submit! node (delete* xt-map eid)))
