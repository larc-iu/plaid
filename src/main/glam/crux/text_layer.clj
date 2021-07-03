(ns glam.crux.text-layer
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce]
            [glam.crux.token-layer :as tokl])
  (:refer-clojure :exclude [get]))

(def attr-keys [:text-layer/id
                :text-layer/name
                :text-layer/token-layers])

(defn crux->pathom [doc]
  (when doc
    (-> doc
        (update :text-layer/token-layers cutil/identize :token-layer/id))))

(defn create [node {:text-layer/keys [id] :as attrs}]
  (let [{:text-layer/keys [id] :as record} (merge (cutil/new-record "text-layer" id)
                                                  {:text-layer/token-layers []}
                                                  (select-keys attrs attr-keys))
        tx-status (gce/submit! node [[:crux.tx/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (crux->pathom (gce/find-entity node {:text-layer/id id})))

;; Mutations ----------------------------------------------------------------------
(defn add-token-layer** [node text-layer-id token-layer-id]
  (cutil/add-join** node text-layer-id :text-layer/token-layers token-layer-id))
(defn add-token-layer [node text-layer-id token-layer-id]
  (gce/submit! node (add-token-layer** node text-layer-id token-layer-id)))

(defn remove-token-layer** [node text-layer-id token-layer-id]
  (cutil/remove-join** node text-layer-id :text-layer/token-layers token-layer-id))
(defn remove-token-layer [node text-layer-id token-layer-id]
  (gce/submit! node (remove-token-layer** node text-layer-id token-layer-id)))

(defn delete** [node eid]
  (let [token-layers (:text-layer/token-layers (gce/entity node eid))]
    (into
      (reduce into (map #(tokl/delete** node %) token-layers))
      [(gce/match* eid (gce/entity node eid))
       (gce/delete* eid)])))
(defn delete [node eid]
  (gce/submit-tx-sync node (delete** node eid)))
