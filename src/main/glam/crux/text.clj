(ns glam.crux.text
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce]
            [glam.crux.token :as tok])
  (:refer-clojure :exclude [get merge]))

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
(defn- get-span-ids [node eid]
  (map first (crux/q (crux/db node)
                     '{:find  [?span]
                       :where [[?span :span/tokens ?tok]
                               [?tok :token/text ?txt]]
                       :in    [?txt]}
                     eid)))

(defn- get-token-ids [node eid]
  (map first (crux/q (crux/db node)
                     '{:find  [?tok]
                       :where [[?tok :token/text ?txt]]
                       :in    [?txt]}
                     eid)))

;; We don't follow the usual pattern of relying on child nodes' delete** functions here because
;; this would lead to children being included multiple times. Instead, we write a bespoke fn.
(defn delete** [node eid]
  (let [span-deletes (mapv gce/delete* (get-span-ids node eid))
        token-deletes (mapv gce/delete* (get-token-ids node eid))
        text-delete [(gce/delete* eid)]]
    (reduce into
            [span-deletes
             token-deletes
             text-delete])))
(defn delete [node eid]
  (gce/submit-tx-sync node (delete** node eid)))
