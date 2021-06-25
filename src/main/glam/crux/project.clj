(ns glam.crux.project
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce]
            [glam.crux.access :as gca])
  (:refer-clojure :exclude [get]))

(def attr-keys [:project/id
                :project/name
                :project/readers
                :project/writers
                :project/text-layers])

(defn crux->pathom [doc]
  (when doc
    (-> doc
        (update :project/readers cutil/identize :user/id)
        (update :project/writers cutil/identize :user/id)
        (update :project/text-layers cutil/identize :text-layer/id))))

(defn create [node {:project/keys [id] :as attrs}]
  (let [{:project/keys [id] :as record}
        (merge (cutil/new-record "project" id)
               (select-keys attrs attr-keys))]
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

(defn get-accessible-ids [node user-id]
  (gca/get-accessible-ids node user-id :project/id))

(defn get-accessible-projects [node user-id]
  "Return a seq of full projects accessible for a user"
  (->> (get-accessible-ids node user-id)
       (map vector)
       (gce/entities node)
       (map crux->pathom)))

;; Mutations --------------------------------------------------------------------------------
(defn delete [node eid]
  ;; TODO: extend with deleting sublayers
  (gce/submit-tx-sync node [(gce/delete* eid)]))

(defn add-text-layer** [node project-id text-layer-id]
  (let [project (gce/entity node project-id)
        text-layer (gce/entity node text-layer-id)]
    [(gce/match* project-id project)
     (gce/match* text-layer-id text-layer)
     (gce/put* (update project :project/text-layers cutil/conj-unique text-layer-id))]))
(defn add-text-layer [node project-id text-layer-id]
  (gce/submit! node (add-text-layer** node project-id text-layer-id)))

(defn remove-text-layer** [node project-id text-layer-id]
  (let [project (gce/entity node project-id)
        text-layer (gce/entity node text-layer-id)]
    [(gce/match* project-id project)
     (gce/match* text-layer-id text-layer)
     (gce/put* (assoc project :project/text-layers (cutil/remove-id project :project/text-layers text-layer-id)))]))
(defn remove-text-layer [node project-id text-layer-id]
  (gce/submit! node (remove-text-layer** node project-id text-layer-id)))

;; TODO: bottom four need to be rewritten like above two
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
     ;; TODO: I don't think this works!
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
     ;; TODO: I don't think this works!
     (gce/put* (update project :project/writers disj user-id))]))
(defn remove-writer [node project-id user-id]
  (gce/submit! node (remove-writer** node project-id user-id)))


