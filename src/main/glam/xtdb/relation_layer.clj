(ns glam.xtdb.relation-layer
  (:require [xtdb.api :as xt]
            [glam.xtdb.easy :as gxe]
            [glam.xtdb.common :as gxc])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:relation-layer/id
                :relation-layer/name
                :config])

(defn xt->pathom [doc]
  (when doc
    (-> doc)))

(defn create [node {:relation-layer/keys [id] :as attrs}]
  (let [{:relation-layer/keys [id] :as record} (clojure.core/merge (gxc/new-record "relation-layer" id)
                                                                   (select-keys attrs attr-keys))
        tx-status (gxe/submit! node [[:xtdb.api/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (xt->pathom (gxe/find-entity node {:relation-layer/id id})))

(defn parent-id [node id]
  (-> (xt/q (xt/db node)
            '{:find  [?sl]
              :where [[?sl :span-layer/relation-layers ?rl]]
              :in    [?rl]}
            id)
      first
      first))

;; Mutations ----------------------------------------------------------------------
(defn merge
  [node eid m]
  (gxe/merge node eid (select-keys m [:relation-layer/name])))

(gxe/deftx delete [node eid]
  (let [parent-layer (parent-id node eid)
        unlink (glam.xtdb.span-layer/remove-relation-layer** node parent-layer eid)
        relation-ids (map first (xt/q (xt/db node) '{:find  [?r]
                                                     :where [[?r :relation/layer ?rl]]
                                                     :in    [?rl]}
                                      eid))
        relation-deletions (mapv gxe/delete* relation-ids)
        relation-layer-deletion [(gxe/delete* eid)]]
    (reduce into [unlink
                  relation-deletions
                  relation-layer-deletion])))
