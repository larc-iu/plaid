(ns glam.crux.span
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:span/id
                :span/tokens
                :span/value
                :span/layer])

(defn crux->pathom [doc]
  (when doc
    (-> doc
        (update :span/layer cutil/identize :span-layer/id)
        (update :span/tokens cutil/identize :token/id))))

(defn create [node {:span/keys [id] :as attrs}]
  (let [{:span/keys [id] :as record} (clojure.core/merge (cutil/new-record "span" id)
                                                         (select-keys attrs attr-keys))
        tx-status (gce/submit! node [[:crux.tx/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (crux->pathom (gce/find-entity node {:span/id id})))

;; Mutations
(defn merge [node eid m]
  (gce/merge node eid (select-keys m [:span/value])))

(defn delete** [node eid]
  [;;(gce/match* eid (gce/entity node eid))
   (gce/delete* eid)])
(defn delete [node eid]
  (gce/submit-tx-sync node (delete** node eid)))

(defn add-token** [node span-id token-id]
  (cutil/add-join** node span-id :span/tokens token-id))
(defn add-token [node span-id token-id]
  (gce/submit! node (add-token** node span-id token-id)))

(defn remove-token**
  "Note: this should NOT be used more than once in a single transaction on a given span, or else its
  deletion behavior will not work properly."
  [node span-id token-id]
  (cond-> (cutil/remove-join** node span-id :span/tokens token-id)
          ;; If we are removing the last token, we should also delete the span
          (= 1 (-> node (gce/entity span-id) :span/tokens count))
          (into (delete** node span-id))))
(defn remove-token [node span-id token-id]
  (gce/submit! node (remove-token** node span-id token-id)))
