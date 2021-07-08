(ns glam.models.text-layer
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [taoensso.timbre :as log]
            #?(:clj [glam.crux.text-layer :as txtl])
            #?(:clj [glam.models.auth :as ma])))

(def text-layer-keys [:text-layer/name :text-layer/token-layers])

(defn valid-name [name] (and (string? name) (<= 1 (count name) 80)))
(defn- field-valid [field v]
  (case field
    :text-layer/name (valid-name v)))

(defn text-layer-valid [form field]
  (let [v (get form field)]
    (field-valid field v)))

(def validator (fs/make-validator text-layer-valid))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-text-layer [{:keys [crux]} {:text-layer/keys [id]}]
     {::pc/input     #{:text-layer/id}
      ::pc/output    [:text-layer/id :text-layer/name :text-layer/token-layers]
      ::pc/transform (ma/readable-required :text-layer/id)}
     (txtl/get crux id)))

;; admin --------------------------------------------------------------------------------
;;

#?(:clj
   (def text-layer-resolvers [get-text-layer]))

