(ns glam.crux.token
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce])
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
