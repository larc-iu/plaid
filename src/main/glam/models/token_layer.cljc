(ns glam.models.token-layer
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [taoensso.timbre :as log]
            #?(:clj [glam.crux.token-layer :as tokl])
            #?(:clj [glam.models.auth :as ma])))

(def token-layer-keys [:token-layer/name :token-layer/span-layers])

(defn valid-name [name] (and (string? name) (<= 1 (count name) 80)))
(defn- field-valid [field v]
  (case field
    :token-layer/name (valid-name v)))

(defn token-layer-valid [form field]
  (let [v (get form field)]
    (field-valid field v)))

(def validator (fs/make-validator token-layer-valid))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-token-layer [{:keys [crux]} {:token-layer/keys [id]}]
     {::pc/input     #{:token-layer/id}
      ::pc/output    [:token-layer/id :token-layer/name :token-layer/span-layers]
      ::pc/transform (ma/readable-required :token-layer/id)}
     (tokl/get crux id)))

;; admin --------------------------------------------------------------------------------
;;

#?(:clj
   (def token-layer-resolvers [get-token-layer]))

