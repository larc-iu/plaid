(ns glam.models.span-layer
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [taoensso.timbre :as log]
            #?(:clj [glam.crux.span-layer :as sl])
            #?(:clj [glam.models.auth :as ma])))

(def span-layer-keys [:span-layer/name
                      :span-layer/span-layers
                      :span-layer/overlap
                      :span-layer/to-many])

(defn valid-name [name] (and (string? name) (<= 1 (count name) 80)))
(defn- field-valid [field v]
  (case field
    :span-layer/name (valid-name v)))

(defn span-layer-valid [form field]
  (let [v (get form field)]
    (field-valid field v)))

(def validator (fs/make-validator span-layer-valid))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-span-layer [{:keys [crux]} {:span-layer/keys [id]}]
     {::pc/input     #{:span-layer/id}
      ::pc/output    [:span-layer/id :span-layer/name :span-layer/overlap :span-layer/to-many]
      ::pc/transform (ma/readable-required :span-layer/id)}
     (sl/get crux id)))

;; admin --------------------------------------------------------------------------------
;;

#?(:clj
   (def span-layer-resolvers [get-span-layer]))
