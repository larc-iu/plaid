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
    {:success (gce/put node record)
     :id      id}))

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

;; Mutations --------------------------------------------------------------------------------
(defn delete [node eid]
  (gce/submit-tx-sync node [(gce/delete* eid)]))

(defn add-reader** [node project-id user-id]
  (let [user (gce/entity node user-id)
        project (gce/entity node project-id)]
    [(gce/match* user-id user)
     (gce/match* project-id project)
     (gce/put* (update project :project/readers conj user-id))]))
(defn add-reader [node project-id user-id]
  (gce/submit! node (add-reader** node project-id user-id)))

(defn remove-reader** [node project-id user-id]
  (let [user (gce/entity node user-id)
        project (gce/entity node project-id)]
    [(gce/match* user-id user)
     (gce/match* project-id project)
     (gce/put* (update project :project/readers disj user-id))]))
(defn remove-reader [node project-id user-id]
  (gce/submit! node (remove-reader** node project-id user-id)))

(defn add-writer** [node project-id user-id]
  (let [user (gce/entity node user-id)
        project (gce/entity node project-id)]
    [(gce/match* user-id user)
     (gce/match* project-id project)
     (gce/put* (update project :project/writers conj user-id))]))
(defn add-writer [node project-id user-id]
  (gce/submit! node (add-writer** node project-id user-id)))

(defn remove-writer** [node project-id user-id]
  (let [user (gce/entity node user-id)
        project (gce/entity node project-id)]
    [(gce/match* user-id user)
     (gce/match* project-id project)
     (gce/put* (update project :project/writers disj user-id))]))
(defn remove-writer [node project-id user-id]
  (gce/submit! node (remove-writer** node project-id user-id)))


