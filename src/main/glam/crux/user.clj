(ns glam.crux.user
  (:require [crux.api :as crux]
            [clojure.spec.alpha :as s]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce]
            [glam.crux.project :as prj])
  (:refer-clojure :exclude [get merge]))

;; just for documentation
(def attrs [:user/id :user/name :user/email :user/password-hash :user/admin?])

(defn crux->pathom [doc]
  (when doc
    doc))

(defn get [node eid]
  (-> (gce/entity node eid)
      crux->pathom))

(defn get-all [node] (map crux->pathom (gce/find-entities node {:user/id '_})))
(defn get-by-name [node name] (crux->pathom (gce/find-entity node {:user/name name})))
(defn get-by-email [node email] (crux->pathom (gce/find-entity node {:user/email email})))

(defn create [node {:user/keys [name email admin? password-hash]}]
  (let [;; make the first user to sign up an admin
        first-signup? (= 0 (count (get-all node)))
        {:user/keys [id] :as record}
        (clojure.core/merge (cutil/new-record "user")
                            {:user/name          name
                             :user/email         email
                             :user/password-hash password-hash
                             :user/admin?        (if first-signup? true (boolean admin?))})]
    (gce/put node record)
    id))

(defn merge [node eid m]
  (gce/merge node eid (select-keys m [:user/name :user/email :user/password-hash :user/admin?])))


(defn delete** [node eid]
  "In addition to deleting the user record, we also need to remove it from projects' read and write lists.
  It's OK to 'overgenerate' the removals since remove-reader*/writer* is powered by `disj` and `disj` doesn't
  care if the item wasn't in the set to begin with: `(disj #{:a :b :c} :d)` => `#{:a :b :c}`"
  ;; TODO: I think this actually should fail if in between the get-visible-ids and the transaction
  ;; one of the projects gets deleted. Maybe consider going back to `deftx`?
  (let [prj-ids (prj/get-visible-ids node eid)]
    (into [(gce/delete* eid)]
          (mapcat (fn [project-id]
                    [(prj/remove-reader* project-id eid)
                     (prj/remove-writer* project-id eid)])
                  prj-ids))))
(defn delete [node eid] (gce/submit! node [(delete** node eid)]))

