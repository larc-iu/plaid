(ns glam.models.project
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [taoensso.timbre :as log]
            #?(:clj [glam.crux.project :as prj])
            #?(:clj [glam.crux.easy :as gce])
            #?(:clj [glam.models.common :as mc])
            [com.fulcrologic.fulcro.mutations :as m]))

(def project-keys [:project/name])

(defn valid-name [name] (and (string? name) (<= 2 (count name) 80)))
(defn- field-valid [field v]
  (case field
    :project/name (valid-name v)))

(defn project-valid [form field]
  (let [v (get form field)]
    (field-valid field v)))

(def validator (fs/make-validator project-valid))

;; admin --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver visible-projects [{:keys [crux current-user]} _]
     {::pc/output    [{:all-projects [:project/id]}]
      ::pc/transform mc/user-required}
     ;; TODO: filter on visibility
     {:all-projects (prj/get-all crux)}))


;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-project [{:keys [crux]} {:project/keys [id]}]
     {::pc/input     #{:project/id}
      ::pc/output    [:project/id :project/name]
      ::pc/transform mc/user-required}
     (gce/entity crux id)))

;; admin --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver all-projects [{:keys [crux current-user]} _]
     {::pc/output    [{:all-projects [:project/id]}]
      ::pc/transform mc/admin-required}
     {:all-projects (prj/get-all crux)}))

#?(:clj
   (pc/defmutation create-project [{:keys [crux]} {delta :delta [_ id] :ident :as params}]
     {::pc/transform mc/admin-required
      ::pc/output    [:server/error? :server/message]}
     (let [{:project/keys [name] :as new-project} (-> {} (mc/apply-delta delta) (select-keys project-keys))]
       (cond
         ;; project name must be unique
         (gce/find-entity crux {:project/name name})
         (mc/server-error (str "Project already exists with name " name))
         :else
         {:tempids {id (prj/create crux new-project)}}))))

#?(:clj
   (def project-resolvers [all-projects get-project create-project]))

