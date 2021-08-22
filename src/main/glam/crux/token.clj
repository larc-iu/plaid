(ns glam.crux.token
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce]
            [glam.crux.span :as s])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:token/id
                :token/text
                :token/begin
                :token/end
                :token/layer])

(defn crux->pathom [doc]
  (when doc
    (-> doc
        (update :token/layer cutil/identize :token-layer/id)
        (update :token/text cutil/identize :text/id))))

(defn create [node {:token/keys [id] :as attrs}]
  (let [{:token/keys [id] :as record} (clojure.core/merge (cutil/new-record "token" id)
                                                          (select-keys attrs attr-keys))
        tx-status (gce/submit! node [[:crux.tx/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (crux->pathom (gce/find-entity node {:token/id id})))

;; Mutations --------------------------------------------------------------------------------
(defn- get-span-ids [node eid]
  (map first (crux/q (crux/db node)
                     '{:find  [?span]
                       :where [[?span :span/tokens ?tok]]
                       :in    [?tok]}
                     eid)))

;; We don't follow the usual pattern of relying on child nodes' delete** functions here because
;; this would lead to children being included multiple times. Instead, we write a bespoke fn.
(defn delete** [node eid]
  (let [spans (get-span-ids node eid)]
    (into
      (reduce into (map #(s/remove-token** node % eid) spans))
      [(gce/match* eid (gce/entity node eid))
       (gce/delete* eid)])))
(defn delete [node eid]
  (gce/submit-tx-sync node (delete** node eid)))
