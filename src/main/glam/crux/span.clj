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
