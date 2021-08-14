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
      ::pc/output    [:document/id :document/name :document/texts]
      ::pc/transform (ma/readable-required :document/id)}
     (-> (doc/get crux id)
         (assoc :document/texts (doc/get-texts crux id)))))

;; admin --------------------------------------------------------------------------------

#?(:clj
   (def document-resolvers [get-document]))

