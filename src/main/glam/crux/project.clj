(ns glam.crux.project
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce]
            [glam.crux.access :as gca]
            [glam.crux.text-layer :as txtl]
            [glam.crux.document :as doc])
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
               {:project/readers [] :project/writers [] :project/text-layers []}
               (select-keys attrs attr-keys))]
    {:success (gce/put node record)
     :id      id}))

;; Queries --------------------------------------------------------------------------------
(defn get-document-ids [node id]
  (map first (crux/q (crux/db node)
                     '{:find  [?doc]
                       :where [[?doc :document/project ?prj]]
                       :in    [?prj]}
                     id)))

(defn get
  [node id]
  (crux->pathom (gce/find-entity node {:project/id id})))

(defn reader-ids
  [node id]
  (:project/readers (gce/entity node id)))

(defn writer-ids
  [node id]
  (:project/writers (gce/entity node id)))

(defn get-all
  [node]
  (map crux->pathom (gce/find-entities node {:project/id '_})))

(defn get-by-name
  [node name]
  (gce/find-entity node {:project/name name}))

(defn get-accessible-ids [node user-id]
  (gca/get-accessible-ids node user-id :project/id))

(defn get-accessible-projects
  "Return a seq of full projects accessible for a user"
  [node user-id]
  (->> (get-accessible-ids node user-id)
       (map vector)
       (gce/entities node)
       (map crux->pathom)))

;; Mutations --------------------------------------------------------------------------------
(defn delete** [node eid]
  (let [text-layers (:project/text-layers (gce/entity node eid))
        txtl-txs (reduce into (map #(txtl/delete** node %) text-layers))
        ;; note: do NOT use doc/delete since the layer deletions will take care of annos
        documents (get-document-ids node eid)
        doc-txs (map #(gce/delete* %) documents)
        project-txs [(gce/match* eid (gce/entity node eid))
                     (gce/delete* eid)]
        all-txs (reduce into [txtl-txs doc-txs project-txs])]
    all-txs))
(defn delete [node eid]
  ;; TODO: extend with deleting sublayers
  (gce/submit-tx-sync node (delete** node eid)))

(defn add-text-layer** [node project-id text-layer-id]
  (cutil/add-join** node project-id :project/text-layers text-layer-id))
(defn add-text-layer [node project-id text-layer-id]
  (gce/submit! node (add-text-layer** node project-id text-layer-id)))

(defn remove-text-layer** [node project-id text-layer-id]
  (cutil/remove-join** node project-id :project/text-layers text-layer-id))
(defn remove-text-layer [node project-id text-layer-id]
  (gce/submit! node (remove-text-layer** node project-id text-layer-id)))

(defn add-reader** [node project-id user-id]
  (cutil/add-join** node project-id :project/readers user-id))
(defn add-reader [node project-id user-id]
  (gce/submit! node (add-reader** node project-id user-id)))

(defn remove-reader** [node project-id user-id]
  (cutil/remove-from-multi-joins** node project-id [:project/readers :project/writers] user-id))
(defn remove-reader [node project-id user-id]
  (gce/submit! node (remove-reader** node project-id user-id)))

(defn add-writer** [node project-id user-id]
  (cutil/add-to-multi-joins** node project-id [:project/readers :project/writers] user-id))
(defn add-writer [node project-id user-id]
  (gce/submit! node (add-writer** node project-id user-id)))

(defn remove-writer** [node project-id user-id]
  (cutil/remove-join** node project-id :project/writers user-id))
(defn remove-writer [node project-id user-id]
  (gce/submit! node (remove-writer** node project-id user-id)))


