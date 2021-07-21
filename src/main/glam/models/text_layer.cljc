(ns glam.models.text-layer
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [taoensso.timbre :as log]
            #?(:clj [glam.crux.project :as prj])
            #?(:clj [glam.crux.text-layer :as txtl])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.crux.easy :as gce])
            #?(:clj [glam.models.common :as mc :refer [server-error server-message]])))

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
   (pc/defmutation create-text-layer [{:keys [crux]} {delta :delta [_ temp-id] :ident [_ parent-id] :parent-ident :as params}]
     {::pc/transform ma/admin-required
      ::pc/output    [:server/error? :server/message]}
     (let [new-text-layer (-> {} (mc/apply-delta delta) (select-keys text-layer-keys))]
       (let [{:keys [id success]} (txtl/create crux new-text-layer)]
         (prj/add-text-layer crux parent-id id)
         (if-not success
           (server-error (str "Failed to create text-layer, please refresh and try again"))
           {:tempids {temp-id id}})))))

#?(:clj
   (def text-layer-resolvers [get-text-layer create-text-layer]))

