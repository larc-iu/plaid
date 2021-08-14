(ns glam.crux.document
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:document/id
                :document/name
                :document/project])

(defn crux->pathom [doc]
  (when doc
    (-> doc
        (update :document/project cutil/identize :project/id))))

(defn create [node {:document/keys [id] :as attrs}]
  (let [{:document/keys [id] :as record} (clojure.core/merge (cutil/new-record "document" id)
                                                             (select-keys attrs attr-keys))
        tx-status (gce/submit! node [[:crux.tx/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (crux->pathom (gce/find-entity node {:document/id id})))

(defn get-texts
  [node id]
  (->> (crux/q (crux/db node)
               '{:find  [?txt]
                 :where [[?txt :text/document ?doc]]
                 :in    [?doc]}
               id)
       first
       (mapv #(hash-map :text/id %))))

;; Mutations ----------------------------------------------------------------------
(defn merge
  [node eid m]
  (gce/merge node eid (select-keys m [:document/name])))

;; TODO: gotta delete all the data
(defn delete** [node eid]
  [(gce/delete* eid)])
(defn delete [node eid]
  (gce/submit-tx-sync node (delete** node eid)))
