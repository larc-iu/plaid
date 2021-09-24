(ns glam.xtdb.project
  (:require [xtdb.api :as xt]
            [glam.xtdb.util :as xutil]
            [glam.xtdb.easy :as gxe]
            [glam.xtdb.access :as gca]
            [glam.xtdb.text-layer :as txtl]
            [glam.xtdb.document :as doc])
  (:refer-clojure :exclude [get]))

(def attr-keys [:project/id
                :project/name
                :project/readers
                :project/writers
                :project/text-layers
                :project/config])

(defn xt->pathom [doc]
  (when doc
    (-> doc
        (update :project/readers xutil/identize :user/id)
        (update :project/writers xutil/identize :user/id)
        (update :project/text-layers xutil/identize :text-layer/id))))

;; This is used to hold on to interface-specific information that can't be known in advance,
;; e.g. which span-layer ought to be used for free translation in the interlinear editing
;; interface.
(def base-config
  {:editors {:interlinear {:span-layer-scopes {}}}})

(defn create [node {:project/keys [id] :as attrs}]
  (let [{:project/keys [id] :as record}
        (merge (xutil/new-record "project" id)
               {:project/readers [] :project/writers [] :project/text-layers [] :project/config base-config}
               (select-keys attrs attr-keys))]
    {:success (gxe/put node record)
     :id      id}))

;; Queries --------------------------------------------------------------------------------
(defn get-document-ids [node id]
  (map first (xt/q (xt/db node)
                   '{:find  [?doc]
                     :where [[?doc :document/project ?prj]]
                     :in    [?prj]}
                   id)))

(defn get
  [node id]
  (xt->pathom (gxe/find-entity node {:project/id id})))

(defn reader-ids
  [node id]
  (:project/readers (gxe/entity node id)))

(defn writer-ids
  [node id]
  (:project/writers (gxe/entity node id)))

(defn get-all
  [node]
  (map xt->pathom (gxe/find-entities node {:project/id '_})))

(defn get-by-name
  [node name]
  (gxe/find-entity node {:project/name name}))

(defn get-accessible-ids [node user-id]
  (gca/get-accessible-ids node user-id :project/id))

(defn get-accessible-projects
  "Return a seq of full projects accessible for a user"
  [node user-id]
  (->> (get-accessible-ids node user-id)
       (map vector)
       (gxe/entities node)
       (map xt->pathom)))

;; Mutations --------------------------------------------------------------------------------
(defn delete** [node eid]
  (let [text-layers (:project/text-layers (gxe/entity node eid))
        txtl-txs (reduce into (map #(txtl/delete** node %) text-layers))
        ;; note: do NOT use doc/delete since the layer deletions will take care of annos
        documents (get-document-ids node eid)
        doc-txs (map #(gxe/delete* %) documents)
        project-txs [(gxe/match* eid (gxe/entity node eid))
                     (gxe/delete* eid)]
        all-txs (reduce into [txtl-txs doc-txs project-txs])]
    all-txs))
(defn delete [node eid]
  ;; TODO: extend with deleting sublayers
  (gxe/submit-tx-sync node (delete** node eid)))

(defn add-text-layer** [node project-id text-layer-id]
  (xutil/add-join** node project-id :project/text-layers text-layer-id))
(defn add-text-layer [node project-id text-layer-id]
  (gxe/submit! node (add-text-layer** node project-id text-layer-id)))

(defn remove-text-layer** [node project-id text-layer-id]
  (xutil/remove-join** node project-id :project/text-layers text-layer-id))
(defn remove-text-layer [node project-id text-layer-id]
  (gxe/submit! node (remove-text-layer** node project-id text-layer-id)))

(defn add-reader** [node project-id user-id]
  (xutil/add-join** node project-id :project/readers user-id))
(defn add-reader [node project-id user-id]
  (gxe/submit! node (add-reader** node project-id user-id)))

(defn remove-reader** [node project-id user-id]
  (xutil/remove-from-multi-joins** node project-id [:project/readers :project/writers] user-id))
(defn remove-reader [node project-id user-id]
  (gxe/submit! node (remove-reader** node project-id user-id)))

(defn add-writer** [node project-id user-id]
  (xutil/add-to-multi-joins** node project-id [:project/readers :project/writers] user-id))
(defn add-writer [node project-id user-id]
  (gxe/submit! node (add-writer** node project-id user-id)))

(defn remove-writer** [node project-id user-id]
  (xutil/remove-join** node project-id :project/writers user-id))
(defn remove-writer [node project-id user-id]
  (gxe/submit! node (remove-writer** node project-id user-id)))


