(ns glam.crux.span-layer
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce])
  (:refer-clojure :exclude [get]))

(def attr-keys [:span-layer/id
                :span-layer/name
                :span-layer/overlap
                :span-layer/to-many])

(defn crux->pathom [doc]
  (when doc
    (-> doc)))

(defn create [node {:span-layer/keys [id] :as attrs}]
  (let [{:span-layer/keys [id] :as record} (merge (cutil/new-record "span-layer" id)
                                                  {:span-layer/overlap false
                                                   :span-layer/to-many true}
                                                  (select-keys attrs attr-keys))
        tx-status (gce/submit! node [[:crux.tx/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (crux->pathom (gce/find-entity node {:span-layer/id id})))

;; Mutations --------------------------------------------------------------------------------
(defn delete** [node eid]
  [(gce/match* eid (gce/entity node eid))
   (gce/delete* eid)])
(defn delete [node eid]
  (gce/submit-tx-sync node (delete** node eid)))
