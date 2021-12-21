(ns glam.xtdb.token
  (:require [xtdb.api :as xt]
            [glam.xtdb.util :as xutil]
            [glam.xtdb.easy :as gxe]
            [glam.xtdb.span :as s]
            [taoensso.timbre :as log])
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

(defn get-tokens
  [node layer-id doc-id]
  (let [tokens (->> (xt/q (xt/db node)
                          '{:find  [(pull ?tok [:token/id :token/text :token/begin :token/end :token/layer])]
                            :where [[?tok :token/layer ?tokl]
                                    [?tok :token/text ?txt]
                                    [?txt :text/document ?doc]]
                            :in    [[?tokl ?doc]]}
                          [layer-id doc-id])
                    (map first))]
    (if-let [{:text/keys [body]} (gxe/entity node (-> tokens first :token/text))]
      (map #(assoc % :token/value (subs body (:token/begin %) (:token/end %))) tokens)
      (do (log/error "Found tokens without a text!")
          []))))

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
