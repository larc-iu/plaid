(ns glam.xtdb.vocab
  (:require [xtdb.api :as xt]
            [glam.xtdb.util :as xutil]
            [glam.xtdb.easy :as gxe]
            [glam.xtdb.project-config :as prjc])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:vocab/id
                :vocab/name])

(defn create [node {:vocab/keys [id] :as attrs}]
  (let [{:vocab/keys [id] :as record} (clojure.core/merge (xutil/new-record "vocab" id)
                                                          (select-keys attrs attr-keys))
        tx-status (gxe/submit! node [[:xtdb.api/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  #_(xt->pathom (gxe/find-entity node {:vocab/id id})))

(defn parent-id [node id]
  (-> (xt/q (xt/db node)
            '{:find  [?tokl]
              :where [[?tokl :token-layer/vocabs ?sl]]
              :in    [?sl]}
            id)
      first
      first))

;; Mutations ----------------------------------------------------------------------
(defn merge
  [node eid m]
  (gxe/merge node eid (select-keys m [:vocab/name])))
(defn delete** [node eid]
  #_(let [remove-from-project-tx (prjc/update-vocab-scope** node eid nil)
        span-ids (map first (xt/q (xt/db node) '{:find  [?s]
                                                 :where [[?s :span/layer ?sl]]
                                                 :in    [?sl]}
                                  eid))
        span-deletions (mapv gxe/delete* span-ids)
        vocab-deletion [(gxe/delete* eid)]]
    (reduce into [remove-from-project-tx
                  span-deletions
                  vocab-deletion])))
(defn delete [node eid]
  (gxe/submit-tx-sync node (delete** node eid)))
