(ns glam.xtdb.token
  (:require [xtdb.api :as xt]
            [glam.xtdb.util :as xutil]
            [glam.xtdb.easy :as gxe]
            [glam.xtdb.span :as s])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:token/id
                :token/text
                :token/begin
                :token/end
                :token/layer])

(defn xt->pathom [doc]
  (when doc
    (-> doc
        (update :token/layer xutil/identize :token-layer/id)
        (update :token/text xutil/identize :text/id))))

(defn create* [{:token/keys [id] :as attrs}]
  (gxe/put* (xutil/create-record "token" id attrs attr-keys)))

(defn create [node attrs]
  (let [[_ {:token/keys [id]} :as put] (create* attrs)
        tx-status (gxe/submit! node [put])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (xt->pathom (gxe/find-entity node {:token/id id})))

;; Mutations --------------------------------------------------------------------------------
(defn- get-span-ids [node eid]
  (map first (xt/q (xt/db node)
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
      [(gxe/match* eid (gxe/entity node eid))
       (gxe/delete* eid)])))
(defn delete [node eid]
  (gxe/submit-tx-sync node (delete** node eid)))
