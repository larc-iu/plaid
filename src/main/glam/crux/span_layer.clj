(ns glam.crux.span-layer
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:span-layer/id
                :span-layer/name])

(defn crux->pathom [doc]
  (when doc
    (-> doc)))

(defn create [node {:span-layer/keys [id] :as attrs}]
  (let [{:span-layer/keys [id] :as record} (clojure.core/merge (cutil/new-record "span-layer" id)
                                                               (select-keys attrs attr-keys))
        tx-status (gce/submit! node [[:crux.tx/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (crux->pathom (gce/find-entity node {:span-layer/id id})))

(defn parent-id [node id]
  (-> (crux/q (crux/db node)
              '{:find  [?tokl]
                :where [[?tokl :token-layer/span-layers ?sl]]
                :in    [?sl]}
              id)
      first
      first))

;; Mutations ----------------------------------------------------------------------
(defn merge
  [node eid m]
  (gce/merge node eid (select-keys m [:span-layer/name])))
(defn delete** [node eid]
  [(gce/match* eid (gce/entity node eid))
   (gce/delete* eid)])
(defn delete [node eid]
  (gce/submit-tx-sync node (delete** node eid)))
