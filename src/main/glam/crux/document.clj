(ns glam.crux.document
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce]
            [glam.crux.text :as text])
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

(defn get-text-layers
  [node id]
  (->> (crux/q (crux/db node)
               '{:find  [?txtl]
                 :where [[?doc :document/project ?prj]
                         [?prj :project/text-layers ?txtl]]
                 :in    [?doc]}
               id)
       (mapv #(hash-map :text-layer/id (first %)))))

;; Mutations ----------------------------------------------------------------------
(defn merge
  [node eid m]
  (gce/merge node eid (select-keys m [:document/name])))

(defn delete** [node eid]
  (let [text-ids (map first (crux/q (crux/db node)
                                    '{:find  [?txt]
                                      :where [[?txt :text/document ?doc]]
                                      :in    [?doc]}
                                    eid))
        text-deletes (reduce into (map #(text/delete** node %) text-ids))]
    (conj text-deletes (gce/delete* eid))))
(defn delete [node eid]
  (gce/submit-tx-sync node (delete** node eid)))
