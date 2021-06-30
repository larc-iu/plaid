(ns glam.models.project
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [taoensso.timbre :as log]
            #?(:clj [glam.crux.project :as prj])
            #?(:clj [glam.crux.easy :as gce])
            #?(:clj [glam.models.common :as mc])
            #?(:clj [glam.models.auth :as ma])
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

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver accessible-projects [{:keys [crux current-user]} _]
     {::pc/output    [{:accessible-projects [:project/id]}]
      ::pc/transform ma/user-required}
     {:accessible-projects (map (fn [id] {:project/id id}) (prj/get-accessible-ids crux (:user/id current-user)))}))

#?(:clj
   ;; todo: make this a batch resolver if needed (same for others)
   (pc/defresolver get-project [{:keys [crux]} {:project/keys [id]}]
     {::pc/input     #{:project/id}
      ::pc/output    [:project/id :project/name]
      ::pc/transform (ma/readable-required :project/id)}
     (prj/get crux id)))

;; admin --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver all-projects [{:keys [crux]} _]
     {::pc/output    [{:all-projects [:project/id]}]
      ::pc/transform ma/admin-required}
     {:all-projects (prj/get-all crux)}))

#?(:clj
   (pc/defmutation create-project [{:keys [crux]} {delta :delta [_ temp-id] :ident :as params}]
     {::pc/transform ma/admin-required
      ::pc/output    [:server/error? :server/message]}
     (let [{:project/keys [name] :as new-project} (-> {} (mc/apply-delta delta) (select-keys project-keys))]
       (cond
         ;; project name must be unique
         (gce/find-entity crux {:project/name name})
         (mc/server-error (str "Project already exists with name " name))
         :else
         (let [{:keys [id success]} (prj/create crux new-project)]
           (if success
             {:tempids {temp-id id}}
             (mc/server-error "Project creation failed, please refresh and try again")))))))

#?(:clj
   (def project-resolvers [accessible-projects all-projects get-project create-project]))

