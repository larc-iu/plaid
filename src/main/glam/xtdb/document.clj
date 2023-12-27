(ns glam.xtdb.document
  (:require [xtdb.api :as xt]
            [glam.xtdb.common :as gxc]
            [glam.xtdb.easy :as gxe]
            [glam.xtdb.text :as text])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:document/id
                :document/name
                :document/project])

(defn xt->pathom [doc]
  (when doc
    (-> doc
        (update :document/project gxc/identize :project/id))))

(defn create* [{:document/keys [id] :as attrs}]
  (gxe/put* (gxc/create-record "document" id attrs attr-keys)))

(defn create [node attrs]
  (let [[_ {:document/keys [id]} :as put] (create* attrs)
        tx-status (gxe/submit! node [put])]
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

(gxe/deftx delete [node eid]
  (let [text-ids (map first (xt/q (xt/db node)
                                  '{:find  [?txt]
                                    :where [[?txt :text/document ?doc]]
                                    :in    [?doc]}
                                  eid))
        text-deletes (reduce into (map #(text/delete** node %) text-ids))]
    (conj text-deletes (gxe/delete* eid))))

