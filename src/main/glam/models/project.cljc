(ns glam.models.project
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [taoensso.timbre :as log]
            #?(:clj [glam.crux.project :as prj])
            #?(:clj [glam.crux.easy :as gce])
            #?(:clj [glam.models.common :as mc])))

(def validator nil)

;; TODO: return only projects that the user has auth for
#?(:clj
   (pc/defresolver all-projects [{:keys [crux current-user]} _]
     {::pc/output    [{:all-projects [:project/id]}]
      ::pc/transform mc/admin-required}
     (println current-user)
     {:all-projects (prj/get-all crux)}))

#?(:clj
   (pc/defresolver get-project [{:keys [crux]} {:project/keys [id]}]
     {::pc/input  #{:project/id}
      ::pc/output [:project/id :project/name]}
     (gce/entity crux id)))

#?(:clj
   (def project-resolvers [all-projects get-project]))

