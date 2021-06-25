(ns glam.crux.text-layer
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce])
  (:refer-clojure :exclude [get]))

(def attr-keys [:text-layer/id
                :text-layer/name
                :text-layer/token-layers])

(defn crux->pathom [doc]
  (when doc
    doc))

(defn create [node {:text-layer/keys [id] :as attrs}]
  (let [{:text-layer/keys [id] :as record} (merge (cutil/new-record "text-layer" id)
                                                  (select-keys attrs attr-keys))
        tx-status (gce/submit! node [[:crux.tx/put record]])]
    {:success tx-status
     :id      id}))