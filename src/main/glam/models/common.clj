(ns glam.models.common
  (:require [com.wsscode.pathom.connect :as pc]
            [com.wsscode.pathom.parser :as pp]
            [taoensso.timbre :as log]))

(defn server-message [msg]
  {:server/message msg
   :server/error?  false})

(defn server-error [msg]
  {:server/message msg
   :server/error?  true})

(defn apply-delta [entity delta]
  (let [new-vals (into {} (for [[k {:keys [after]}] delta]
                            [k after]))
        new-entity (merge entity new-vals)]
    new-entity))

(defn validate-delta [record-valid-fn delta]
  (let [new-vals (into {} (for [[k {:keys [after]}] delta]
                            [k after]))]
    (println new-vals)
    (record-valid-fn new-vals)))

