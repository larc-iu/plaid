(ns glam.xtdb.document
  (:require [xtdb.api :as xt]
            [glam.xtdb.util :as xutil]
            [glam.xtdb.easy :as gxe]
            [glam.xtdb.text :as text])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:document/id
                :document/name
                :document/project])

(defn xt->pathom [doc]
  (when doc
    (-> doc
        (update :document/project xutil/identize :project/id))))

(defn create [node {:document/keys [id] :as attrs}]
  (let [{:document/keys [id] :as record} (clojure.core/merge (xutil/new-record "document" id)
                                                             (select-keys attrs attr-keys))
        tx-status (gxe/submit! node [[:xtdb.api/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (xt->pathom (gxe/find-entity node {:document/id id})))

(defn get-text-layers
  [node id]
  (->> (xt/q (xt/db node)
             '{:find  [?txtl]
               :where [[?doc :document/project ?prj]
                       [?prj :project/text-layers ?txtl]]
               :in    [?doc]}
             id)
       (mapv #(hash-map :text-layer/id (first %)))))

;; Mutations ----------------------------------------------------------------------
(defn merge
  [node eid m]
  (gxe/merge node eid (select-keys m [:document/name])))

(defn delete** [node eid]
  (let [text-ids (map first (xt/q (xt/db node)
                                  '{:find  [?txt]
                                    :where [[?txt :text/document ?doc]]
                                    :in    [?doc]}
                                  eid))
        text-deletes (reduce into (map #(text/delete** node %) text-ids))]
    (conj text-deletes (gxe/delete* eid))))
(defn delete [node eid]
  (gxe/submit-tx-sync node (delete** node eid)))
