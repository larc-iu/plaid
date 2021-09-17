(ns glam.xtdb.span
  (:require [xtdb.api :as xt]
            [glam.xtdb.util :as xutil]
            [glam.xtdb.easy :as gxe]
            [taoensso.timbre :as log])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:span/id
                :span/tokens
                :span/value
                :span/layer])

(defn xt->pathom [doc]
  (when doc
    (-> doc
        (update :span/layer xutil/identize :span-layer/id)
        (update :span/tokens xutil/identize :token/id))))

(defn create* [{:span/keys [id] :as attrs}]
  (gxe/put* (xutil/create-record "span" id attrs attr-keys)))

(defn create [node attrs]
  (let [[_ {:span/keys [id]} :as put] (create* attrs)
        tx-status (gxe/submit! node [put])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (xt->pathom (gxe/find-entity node {:span/id id})))

;; Mutations
(defn merge [node eid m]
  (gxe/merge node eid (select-keys m [:span/value])))

(defn delete** [node eid]
  [;;(gxe/match* eid (gxe/entity node eid))
   (gxe/delete* eid)])
(defn delete [node eid]
  (gxe/submit-tx-sync node (delete** node eid)))

(declare add-token**)
(gxe/deftx add-token [node span-id token-id]
  (xutil/add-join** node span-id :span/tokens token-id))

;; Note: this should NOT be used more than once in a single transaction on a given span, or else its
;; deletion behavior will not work properly.
(declare remove-token**)
(gxe/deftx remove-token [node span-id token-id]
  (let [base-txs (xutil/remove-join** node span-id :span/tokens token-id)]
    (if (= 1 (-> (gxe/entity node span-id) :span/tokens count))
      (into base-txs [(gxe/delete* span-id)])
      base-txs)))
