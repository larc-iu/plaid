(ns glam.crux.project
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce])
  (:refer-clojure :exclude [get]))

(def attrs [:project/name
            :project/readers
            :project/writers
            :project/text-layers])

(defn crux->pathom [doc]
  (when doc
    (-> doc
        (update :project/readers cutil/identize :user/id)
        (update :project/writers cutil/identize :user/id))))

(defn create [node {:project/keys [name]}]
  (let [{:project/keys [id] :as record}
        (merge (cutil/new-record "project")
               {:project/name        name
                :project/readers     #{}
                :project/writers     #{}
                :project/text-layers []})]
    (gce/put node record)
    id))

;; Queries --------------------------------------------------------------------------------
(defn get
  [node id]
  (crux->pathom (gce/find-entity node {:project/id id})))

(defn get-all
  [node]
  (map crux->pathom (gce/find-entities node {:project/id '_})))

(defn get-by-name
  [node name]
  (gce/find-entity node {:project/name name}))

;; A project is considered visible if a user can read or write on it
(def visible-rule
  '[(visible ?project ?user)
    (or [?project :project/readers ?user]
        [?project :project/writers ?user])])

(defn get-visible-ids [node user-id]
  "Return a seq of uuids"
  (map first
       (crux/q (crux/db node)
               {:find  '[?p]
                :where [['?u :user/id user-id]
                        '(visible ?p ?u)]
                :rules [visible-rule]})))
(defn get-visible [node user-id]
  "Return full projects"
  (->> (get-visible-ids node user-id)
       (map vector)
       (gce/entities node)
       (map crux->pathom)))

;; Transactions --------------------------------------------------------------------------------
(defn delete* [eid] (gce/delete* eid))
(defn delete [node eid]
  (gce/submit! node [(delete* eid)]))

(defn add-reader* [project-id user-id] (gce/update* project-id :project/readers conj user-id))
(defn add-writer* [project-id user-id] (gce/update* project-id :project/writers conj user-id))
(defn remove-reader* [project-id user-id] (gce/update* project-id :project/readers disj user-id))
(defn remove-writer* [project-id user-id] (gce/update* project-id :project/writers disj user-id))
(defn add-reader [node project-id user-id] (gce/submit! node [(add-reader* project-id user-id)]))
(defn add-writer [node project-id user-id] (gce/submit! node [(add-writer* project-id user-id)]))
(defn remove-reader [node project-id user-id] (gce/submit! node [(remove-reader* project-id user-id)]))
(defn remove-writer [node project-id user-id] (gce/submit! node [(remove-writer* project-id user-id)]))
