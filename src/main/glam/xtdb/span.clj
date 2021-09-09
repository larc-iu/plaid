(ns glam.xtdb.span
  (:require [xtdb.api :as xt]
            [glam.xtdb.util :as xutil]
            [glam.xtdb.easy :as gxe])
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

(defn create [node {:span/keys [id] :as attrs}]
  (let [{:span/keys [id] :as record} (clojure.core/merge (xutil/new-record "span" id)
                                                         (select-keys attrs attr-keys))
        tx-status (gxe/submit! node [[:xtdb.api/put record]])]
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

(defn add-token** [node span-id token-id]
  (xutil/add-join** node span-id :span/tokens token-id))
(defn add-token [node span-id token-id]
  (gxe/submit! node (add-token** node span-id token-id)))

(defn remove-token**
  "Note: this should NOT be used more than once in a single transaction on a given span, or else its
  deletion behavior will not work properly."
  [node span-id token-id]
  (cond-> (xutil/remove-join** node span-id :span/tokens token-id)
          ;; If we are removing the last token, we should also delete the span
          (= 1 (-> node (gxe/entity span-id) :span/tokens count))
          (into (delete** node span-id))))
(defn remove-token [node span-id token-id]
  (gxe/submit! node (remove-token** node span-id token-id)))
