(ns glam.models.document
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [taoensso.timbre :as log]
            #?(:clj [glam.crux.project :as prj])
            #?(:clj [glam.crux.document :as doc])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.crux.easy :as gce])
            #?(:clj [glam.models.common :as mc :refer [server-error server-message]])))

(def document-keys [:document/name :document/project])

(defn valid-name [name] (and (string? name) (<= 1 (count name) 80)))
(defn- field-valid [field v]
  (case field
    :document/name (valid-name v)))

(defn document-valid [form field]
  (let [v (get form field)]
    (field-valid field v)))

(defn record-valid? [record]
  (every? (fn [[k v]]
            (field-valid k v)) (log/spy record)))

(def validator (fs/make-validator document-valid))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-document [{:keys [crux]} {:document/keys [id]}]
     {::pc/input     #{:document/id}
      ::pc/output    [:document/id :document/name :document/text-layers]
      ::pc/transform (ma/readable-required :document/id)}
     (-> (doc/get crux id)
         (assoc :document/text-layers (doc/get-text-layers crux id)))))

#?(:clj
   (pc/defmutation create-document [{:keys [crux]} {delta :delta [_ temp-id] :ident [_ parent-id] :parent-ident :as params}]
     {::pc/transform ma/parent-writeable-required
      ::pc/output    [:server/error? :server/message]}
     (let [new-document (-> {}
                            (mc/apply-delta delta)
                            (select-keys [:document/name])
                            (assoc :document/project parent-id))]
       (let [{:keys [id success]} (doc/create crux new-document)]
         (if-not success
           (server-error (str "Failed to create document, please refresh and try again"))
           {:tempids {temp-id id}})))))

;; admin --------------------------------------------------------------------------------

#?(:clj
   (def document-resolvers [get-document create-document]))

