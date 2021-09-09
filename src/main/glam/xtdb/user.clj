(ns glam.xtdb.user
  (:require [xtdb.api :as xt]
            [clojure.spec.alpha :as s]
            [glam.xtdb.util :as xutil]
            [glam.xtdb.easy :as gxe]
            [glam.xtdb.project :as prj])
  (:refer-clojure :exclude [get merge]))

(def attr-keys #{:user/id :user/name :user/email :user/password-hash :user/admin?})

(defn xt->pathom [doc]
  (when doc
    doc))

(defn get [node eid]
  (-> (gxe/entity node eid)
      xt->pathom))

(defn get-all [node] (map xt->pathom (gxe/find-entities node {:user/id '_})))
(defn get-by-name [node name] (xt->pathom (gxe/find-entity node {:user/name name})))
(defn get-by-email [node email] (xt->pathom (gxe/find-entity node {:user/email email})))

(defn create [node {:user/keys [name email admin? password-hash id]}]
  (let [;; make the first user to sign up an admin
        first-signup? (= 0 (count (get-all node)))
        {:user/keys [id] :as record}
        (clojure.core/merge (xutil/new-record "user" id)
                            {:user/name          name
                             :user/email         email
                             :user/password-hash password-hash
                             :user/admin?        (if first-signup? true (boolean admin?))})]
    {:id      id
     :success (gxe/put node record)}))

(defn merge [node eid m]
  (gxe/merge node eid (select-keys m [:user/name :user/email :user/password-hash :user/admin?])))

(defn delete** [node eid]
  "In addition to deleting the user record, we also need to remove it from projects' read and write lists."
  (let [prj-ids (prj/get-accessible-ids node eid)]
    (into (vec (mapcat (fn [project-id]
                         (concat (prj/remove-reader** node project-id eid)
                                 (prj/remove-writer** node project-id eid)))
                       prj-ids))
          [(gxe/delete* eid)])))
(defn delete [node eid]
  (let [tx (delete** node eid)]
    (gxe/submit! node tx)))
