(ns glam.client.ui.admin-settings.project-management
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
            [glam.client.application :refer [SPA]]
            [glam.models.project :as project :refer [validator]]
            [glam.client.ui.material-ui :as mui]
            [glam.client.ui.material-ui-icon :as muic]
            [glam.client.ui.common.forms :as forms]
            [glam.client.router :as r]))


(defsc ProjectListItem [this {:project/keys [id name] :as props}]
  {:ident :project/id
   :query [:project/id :project/name]}
  (mui/list-item {:key    id
                  :button true
                  :onClick #(r/route-to! :project-settings {:id id})} name))

(def ui-project-list-item (c/factory ProjectListItem))

(def ident [:component/id :project-management])
(defsc ProjectManagement [this {:keys [all-projects] :as props}]
  {:ident         (fn [_] ident)
   :query         [{:all-projects (c/get-query ProjectListItem)}]
   :initial-state (fn [_]
                    {:all-projects []})
   :route-segment (r/last-route-segment :project-management)
   :will-enter    (fn [app _]
                    (dr/route-deferred
                      ident
                      #(df/load! app :all-projects ProjectListItem
                                 {:target               (conj ident :all-projects)
                                  :post-mutation        `dr/target-ready
                                  :post-mutation-params {:target ident}})))}

  (js/console.log (pr-str all-projects))
  (mui/container {:maxWidth "lg" :style {:position "relative"}}
    (mui/page-title "Project Management")
    (mui/arrow-breadcrumbs {}
      (mui/link {:color "inherit" :href (r/route-for :admin-home) :key "admin"} "Admin Settings")
      (mui/link {:color "textPrimary" :href (r/route-for :project-management) :key "project"} "Project Management"))
    (mui/list {}
      (map ui-project-list-item all-projects)))

  )

