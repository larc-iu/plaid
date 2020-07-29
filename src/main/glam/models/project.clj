(ns glam.models.project
  (:require [glam.crux.project :as prj]
            [glam.crux.common :as gc]
            [com.wsscode.pathom.connect :as pc]
            [clojure.set :refer [rename-keys]]
            [taoensso.timbre :as log]))

;; TODO: return only projects that the user has auth for
(pc/defresolver all-projects [{:keys [crux current-user]} _]
  {::pc/output [{:all-projects [:project/id]}]}
  {:all-projects (prj/get-all crux)})

(pc/defresolver get-project [{:keys [crux]} {:project/keys [id]}]
  {::pc/input  #{:project/id}
   ::pc/output [:project/id :project/name :project/slug]}
  (gc/entity crux id))

(def project-resolvers [all-projects get-project])

