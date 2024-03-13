(ns glam.xtdb.span-layer
  (:require [xtdb.api :as xt]
            [glam.xtdb.easy :as gxe]
            [glam.xtdb.common :as gxc]
            [glam.xtdb.relation-layer :as rl])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:span-layer/id
                :span-layer/name
                :span-layer/relation-layers
                :config])

(defn xt->pathom [doc]
  (when doc
    (-> doc)))

(defn create [node {:span-layer/keys [id] :as attrs}]
  (let [{:span-layer/keys [id] :as record} (clojure.core/merge (gxc/new-record "span-layer" id)
                                                                {:span-layer/relation-layers []}
                                                               (select-keys attrs attr-keys))
        tx-status (gxe/submit! node [[:xtdb.api/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (xt->pathom (gxe/find-entity node {:span-layer/id id})))

(defn parent-id [node id]
  (-> (xt/q (xt/db node)
            '{:find  [?tokl]
              :where [[?tokl :token-layer/span-layers ?sl]]
              :in    [?sl]}
            id)
      first
      first))

;; Mutations ----------------------------------------------------------------------
(defn merge
  [node eid m]
  (gxe/merge node eid (select-keys m [:span-layer/name])))

(gxe/deftx delete [node eid]
  (let [parent-layer (parent-id node eid)
        unlink (glam.xtdb.token-layer/remove-span-layer** node parent-layer eid)
        span-ids (map first (xt/q (xt/db node) '{:find  [?s]
                                                 :where [[?s :span/layer ?sl]]
                                                 :in    [?sl]}
                                  eid))
        span-deletions (mapv gxe/delete* span-ids)
        span-layer-deletion [(gxe/delete* eid)]
        relation-layers (:span-layer/relation-layers (gxe/entity node eid))
        relation-layer-deletions (reduce into (map #(rl/delete** node %) relation-layers))]
    (reduce into [unlink
                  span-deletions
                  span-layer-deletion
                  relation-layer-deletions])))

(gxe/deftx add-relation-layer [node span-layer-id relation-layer-id]
  (gxc/add-join** node span-layer-id :span-layer/relation-layers relation-layer-id))

(gxe/deftx remove-relation-layer [node span-layer-id relation-layer-id]
  (gxc/remove-join** node span-layer-id :span-layer/relation-layers relation-layer-id))

