(ns glam.models.project
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [com.fulcrologic.fulcro.mutations :as m]
            #?(:clj [glam.xtdb.project :as prj])
            #?(:clj [glam.xtdb.project-config :as prjc])
            #?(:clj [glam.xtdb.easy :as gxe])
            #?(:clj [glam.xtdb.util :as xutil])
            #?(:clj [glam.models.common :as mc])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.xtdb.user :as usr])))

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
   (pc/defresolver accessible-projects [{:keys [node current-user]} _]
     {::pc/output    [{:accessible-projects [:project/id]}]
      ::pc/transform ma/user-required}
     {:accessible-projects (map (fn [id] {:project/id id}) (prj/get-accessible-ids node current-user))}))

#?(:clj
   ;; todo: make this a batch resolver if needed (same for others)
   (pc/defresolver get-project [{:keys [node]} {:project/keys [id]}]
     {::pc/input     #{:project/id}
      ::pc/output    [:project/id :project/name :project/readers :project/writers
                      :project/text-layers :project/documents :project/config]
      ::pc/transform (ma/readable-required :project/id)}
     (let [doc-ids (xutil/identize (prj/get-document-ids node id) :document/id)]
       (-> (prj/get node id)
           (assoc :project/documents doc-ids)))))

;; admin --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver all-projects [{:keys [node]} _]
     {::pc/output    [{:all-projects [:project/id]}]
      ::pc/transform ma/admin-required}
     {:all-projects (prj/get-all node)}))

#?(:clj
   (pc/defmutation create-project [{:keys [node]} {delta :delta [_ temp-id] :ident :as params}]
     {::pc/transform ma/admin-required
      ::pc/output    [:server/error? :server/message]}
     (let [{:project/keys [name] :as new-project} (-> {} (mc/apply-delta delta) (select-keys project-keys))]
       (cond
         ;; project name must be unique
         (gxe/find-entity node {:project/name name})
         (mc/server-error (str "Project already exists with name " name))
         :else
         (let [{:keys [id success]} (prj/create node new-project)]
           (if success
             {:tempids {temp-id id}}
             (mc/server-error "Project creation failed, please refresh and try again")))))))

#?(:clj
   (pc/defresolver get-users-for-project [{:keys [node]} {:project/keys [id]}]
     {::pc/input     #{:project/id}
      ::pc/output    [{:project/users [:user/id :user/privileges]}]
      ::pc/transform ma/admin-required}
     (let [all-user-ids (map :user/id (usr/get-all node))
           readers (prj/reader-ids node id)
           writers (prj/writer-ids node id)]
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
   (pc/defmutation set-user-privileges [{:keys [node]} {user-id    :user/id
                                                        project-id :project/id
                                                        privileges :user/privileges}]
     {::pc/transform ma/admin-required}
     (cond
       (not (gxe/entity node project-id))
       (mc/server-error (str "Project doesn't exist:" project-id))

       (not (gxe/entity node user-id))
       (mc/server-error (str "User doesn't exist:" project-id))

       (not (some #{privileges} ["reader" "writer" "none"]))
       (mc/server-error (str "Unknown privileges type: " privileges))

       :else
       (let [tx (into (prj/remove-reader** node project-id user-id)
                      ;; Filter out match clauses in the second--we've already guarded in the first **
                      (filter #(not= (first %) :xtdb.api/match)
                              (case privileges
                                "reader" (prj/add-reader** node project-id user-id)
                                "writer" (prj/add-writer** node project-id user-id)
                                nil)))
             success (gxe/submit! node tx)]
         (if success
           (mc/server-message "Updated privileges")
           (mc/server-error "Failed to update user privileges, please refresh and try again"))))))

#?(:clj
   (pc/defmutation set-interlinear-span-layer-scope [{:keys [node]} {:span-layer/keys [id] :keys [scope]}]
     {::pc/transform ma/admin-required}
     (cond
       (not (contains? #{:token :sentence nil} scope))
       (mc/server-error (str "Scope must be one of #{:token :sentence nil}, got " scope))

       (nil? id)
       (mc/server-error "Must supply a span layer ID")

       (not (gxe/entity node id))
       (mc/server-error (str "Span layer doesn't exist:" id))

       :else
       (let [success (prjc/update-span-layer-scope node id scope)]
         (if success
           (mc/server-message (str "Span layer marked as " (get {:token    "token-level"
                                                                 :sentence "sentence-level"
                                                                 nil       "excluded from interlinear editing"} scope)))
           (mc/server-error "Failed to update span layer, please refresh and try again"))))))
#?(:clj
   (def project-resolvers [accessible-projects all-projects get-project create-project
                           get-users-for-project set-user-privileges set-interlinear-span-layer-scope]))

