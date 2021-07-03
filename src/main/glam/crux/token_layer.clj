(ns glam.crux.token-layer
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce]
            [glam.crux.span-layer :as sl])
  (:refer-clojure :exclude [get]))

(def attr-keys [:token-layer/id
                :token-layer/name
                :token-layer/span-layers])

(defn crux->pathom [doc]
  (when doc
    (-> doc
        (update :token-layer/span-layers cutil/identize :span-layer/id))))

(defn create [node {:token-layer/keys [id] :as attrs}]
  (let [{:token-layer/keys [id] :as record} (merge (cutil/new-record "token-layer" id)
                                                   {:token-layer/span-layers []}
                                                   (select-keys attrs attr-keys))
        tx-status (gce/submit! node [[:crux.tx/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (crux->pathom (gce/find-entity node {:token-layer/id id})))

;; Mutations ----------------------------------------------------------------------
(defn add-span-layer** [node token-layer-id span-layer-id]
  (cutil/add-join** node token-layer-id :token-layer/span-layers span-layer-id))
(defn add-span-layer [node token-layer-id span-layer-id]
  (gce/submit! node (add-span-layer** node token-layer-id span-layer-id)))

(defn remove-span-layer** [node token-layer-id span-layer-id]
  (cutil/remove-join** node token-layer-id :token-layer/span-layers span-layer-id))
(defn remove-span-layer [node token-layer-id span-layer-id]
  (gce/submit! node (remove-span-layer** node token-layer-id span-layer-id)))

(defn delete** [node eid]
  (let [span-layers (:token-layer/span-layers (gce/entity node eid))]
    (into
      (reduce into (map #(sl/delete** node %) span-layers))
      [(gce/match* eid (gce/entity node eid))
       (gce/delete* eid)])))
(defn delete [node eid]
  (gce/submit-tx-sync node (delete** node eid)))
