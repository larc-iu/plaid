(ns glam.crux.text
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce]
            [glam.crux.token-layer :as tokl])
  (:refer-clojure :exclude [get merge]))

;; TODO: do tokens as well, do resolvers, do

(def attr-keys [:text/id
                :text/document
                :text/layer
                :text/body])

(defn crux->pathom [doc]
  (when doc
    (-> doc
        (update :text/layer cutil/identize :text-layer/id)
        (update :text/document cutil/identize :document/id))))

(defn create [node {:text/keys [id] :as attrs}]
  (let [{:text/keys [id] :as record} (clojure.core/merge (cutil/new-record "text" id)
                                                         (select-keys attrs attr-keys))
        tx-status (gce/submit! node [[:crux.tx/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (crux->pathom (gce/find-entity node {:text/id id})))

;; Mutations ----------------------------------------------------------------------
;;
;;(defn delete** [node eid]
;;  (let [token-layers (:text/token-layers (gce/entity node eid))]
;;    (into
;;      (reduce into (map #(tokl/delete** node %) token-layers))
;;      [(gce/match* eid (gce/entity node eid))
;;       (gce/delete* eid)])))
;;(defn delete [node eid]
;;  (gce/submit-tx-sync node (delete** node eid)))
