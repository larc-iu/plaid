(ns glam.models.project
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [com.fulcrologic.fulcro.mutations :as m]
            [taoensso.timbre :as log]
            #?(:clj [glam.crux.project :as prj])
            #?(:clj [glam.crux.easy :as gce])
            #?(:clj [glam.models.common :as mc])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.crux.user :as usr])))

(def project-keys [:project/name :project/text-layers])

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
      ::pc/output    [:project/id :project/name :project/readers :project/writers :project/text-layers]
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
   (pc/defresolver get-users-for-project [{:keys [crux]} {:project/keys [id]}]
     {::pc/input     #{:project/id}
      ::pc/output    [{:project/users [:user/id :user/privileges]}]
      ::pc/transform ma/admin-required}
     (let [all-user-ids (map :user/id (usr/get-all crux))
           readers (prj/reader-ids crux id)
           writers (prj/writer-ids crux id)]
       {:project/users (mapv (fn [user-id]
                               {:user/id         user-id
                                :user/privileges (cond (some #{user-id} writers) "writer"
                                                       (some #{user-id} readers) "reader"
                                                       :else "none")})
                             all-user-ids)})))

#?(:cljs
   (m/defmutation set-user-privileges
     [args]
     (remote [{:keys [ast]}] true))
   :clj
   (pc/defmutation set-user-privileges [{:keys [crux]} {user-id    :user/id
                                                        project-id :project/id
                                                        privileges :user/privileges}]
     {::pc/transform ma/admin-required}
     (cond
       (not (gce/entity crux project-id))
       (mc/server-error (str "Project doesn't exist:" project-id))

       (not (gce/entity crux user-id))
       (mc/server-error (str "User doesn't exist:" project-id))

       (not (some #{privileges} ["reader" "writer" "none"]))
       (mc/server-error (str "Unknown privileges type: " privileges))

       :else
       (let [tx (into (prj/remove-reader** crux project-id user-id)
                      ;; Filter out match clauses in the second--we've already guarded in the first **
                      (filter #(not= (first %) :crux.tx/match)
                              (case privileges
                                "reader" (prj/add-reader** crux project-id user-id)
                                "writer" (prj/add-writer** crux project-id user-id)
                                nil)))
             success (gce/submit! crux tx)]
         (if success
           (mc/server-message "Updated privileges")
           (mc/server-error "Failed to update user privileges, please refresh and try again"))))))

#?(:clj
   (def project-resolvers [accessible-projects all-projects get-project create-project
                           get-users-for-project set-user-privileges]))

