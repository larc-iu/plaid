(ns glam.crux.text-layer
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce])
  (:refer-clojure :exclude [get]))

(def attrs [:text-layer/name
            ;; nyi
            :text-layer/token-layers])

(defn crux->pathom [doc]
  (when doc
    doc))

(defn create [node {:text-layer/keys [name]}])

