(ns glam.xtdb.project
  (:require [xtdb.api :as xt]
            [glam.xtdb.common :as gxc]
            [glam.xtdb.easy :as gxe]
            [glam.xtdb.access :as gca]
            [glam.xtdb.text-layer :as txtl]
            [glam.xtdb.document :as doc])
  (:refer-clojure :exclude [get]))

(def attr-keys [:project/id
                :project/name
                :project/readers
                :project/writers
                :project/text-layers])

(defn xt->pathom [doc]
  (when doc
    (-> doc
        (update :project/readers gxc/identize :user/id)
        (update :project/writers gxc/identize :user/id)
        (update :project/text-layers gxc/identize :text-layer/id))))

(defn create [node {:project/keys [id] :as attrs}]
  (let [{:project/keys [id] :as record}
        (merge (gxc/new-record "project" id)
               {:project/readers [] :project/writers [] :project/text-layers [] }
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
(gxe/deftx delete [node eid]
  (let [text-layers (:project/text-layers (gxe/entity node eid))
        txtl-txs (reduce into (map #(txtl/delete** node %) text-layers))
        ;; note: do NOT use doc/delete since the layer deletions will take care of annos
        documents (get-document-ids node eid)
        doc-txs (map #(gxe/delete* %) documents)
        project-txs [(gxe/delete* eid)]
        all-txs (reduce into [txtl-txs doc-txs project-txs])]
    all-txs))

(gxe/deftx add-text-layer [node project-id text-layer-id]
  (gxc/add-join** node project-id :project/text-layers text-layer-id))

(gxe/deftx remove-text-layer [node project-id text-layer-id]
  (gxc/remove-join** node project-id :project/text-layers text-layer-id))

(gxe/deftx add-reader [node project-id user-id]
  (gxc/add-join** node project-id :project/readers user-id))

(gxe/deftx remove-reader [node project-id user-id]
  (gxc/remove-from-multi-joins** node project-id [:project/readers :project/writers] user-id))

(gxe/deftx add-writer [node project-id user-id]
  (gxc/add-to-multi-joins** node project-id [:project/readers :project/writers] user-id))

(gxe/deftx remove-writer [node project-id user-id]
  (gxc/remove-join** node project-id :project/writers user-id))

;; This is not actually a project operation, but this is the most sensible place to put it
(gxe/deftx assoc-editor-config-pair [node layer-id editor-name config-key config-value]
  (let [layer (gxe/entity node layer-id)
        new-layer (assoc-in layer [:config editor-name config-key] config-value)]
    [(gxe/put* new-layer)]))

(gxe/deftx dissoc-editor-config-pair [node layer-id editor-name config-key]
  (let [layer (gxe/entity node layer-id)
        new-layer (update-in layer [:config editor-name] dissoc config-key)]
    [(gxe/put* new-layer)]))