(ns glam.xtdb.text-layer
  (:require [xtdb.api :as xt]
            [glam.xtdb.util :as xutil]
            [glam.xtdb.easy :as gxe]
            [glam.xtdb.token-layer :as tokl])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:text-layer/id
                :text-layer/name
                :text-layer/token-layers])

(defn xt->pathom [doc]
  (when doc
    (-> doc
        (update :text-layer/token-layers xutil/identize :token-layer/id))))

(defn create [node {:text-layer/keys [id] :as attrs}]
  (let [{:text-layer/keys [id] :as record} (clojure.core/merge (xutil/new-record "text-layer" id)
                                                               {:text-layer/token-layers []}
                                                               (select-keys attrs attr-keys))
        tx-status (gxe/submit! node [[:xtdb.api/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (xt->pathom (gxe/find-entity node {:text-layer/id id})))

(defn parent-id [node id]
  (-> (xt/q (xt/db node)
            '{:find  [?p]
              :where [[?p :project/text-layers ?txtl]]
              :in    [?txtl]}
            id)
      first
      first))

;; Mutations ----------------------------------------------------------------------
(defn merge
  "Note: don't include the join"
  [node eid m]
  (gxe/merge node eid (select-keys m [:text-layer/name])))

(defn add-token-layer** [node text-layer-id token-layer-id]
  (xutil/add-join** node text-layer-id :text-layer/token-layers token-layer-id))
(defn add-token-layer [node text-layer-id token-layer-id]
  (gxe/submit! node (add-token-layer** node text-layer-id token-layer-id)))

(defn remove-token-layer** [node text-layer-id token-layer-id]
  (xutil/remove-join** node text-layer-id :text-layer/token-layers token-layer-id))
(defn remove-token-layer [node text-layer-id token-layer-id]
  (gxe/submit! node (remove-token-layer** node text-layer-id token-layer-id)))

(defn delete** [node eid]
  (let [token-layers (:text-layer/token-layers (gxe/entity node eid))
        token-layer-deletions (reduce into (mapv #(tokl/delete** node %) token-layers))
        text-ids (map first (xt/q (xt/db node) '{:find  [?txt]
                                                 :where [[?txt :text/layer ?txtl]]
                                                 :in    [?txtl]}
                                  eid))
        text-deletions (mapv gxe/delete* text-ids)]
    (reduce
      into
      [token-layer-deletions
       text-deletions
       [(gxe/match* eid (gxe/entity node eid))
        (gxe/delete* eid)]])))
(defn delete [node eid]
  (gxe/submit-tx-sync node (delete** node eid)))
