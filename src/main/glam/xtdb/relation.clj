(ns glam.xtdb.relation
  (:require [xtdb.api :as xt]
            [glam.xtdb.easy :as gxe]
            [glam.xtdb.common :as gxc]
            [taoensso.timbre :as log])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:relation/id
                :relation/layer
                :relation/source
                :relation/target
                :relation/value])

(def snapshot-attrs [:relation/id :relation/value :relation/source :relation/target])

(defn xt->pathom [doc]
  (when doc
    (-> doc
        (update :relation/layer gxc/identize :relation-layer/id)
        (update :relation/source gxc/identize :span/id)
        (update :relation/target gxc/identize :span/id))))

(defn create* [{:relation/keys [id] :as attrs}]
  (gxe/put* (gxc/create-record "relation" id attrs attr-keys)))

(defn create [node attrs]
  (let [[_ {:relation/keys [id]} :as put] (create* attrs)
        tx-status (gxe/submit! node [put])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (xt->pathom (gxe/find-entity node {:relation/id id})))

;; Mutations --------------------------------------------------------------------------------
(defn merge [node eid m]
  (gxe/merge node eid (select-keys m [:relation/value])))

(gxe/deftx delete [node eid]
  [(gxe/delete* eid)])