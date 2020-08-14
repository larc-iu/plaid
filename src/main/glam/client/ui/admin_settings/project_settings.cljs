(ns glam.client.ui.admin-settings.project-settings
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [com.fulcrologic.fulcro.algorithms.denormalize :as fdn]
            [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [taoensso.timbre :as log]
            [glam.client.router :as r]
            [glam.models.session :as sn]
            [glam.client.ui.material-ui :as mui]
            [glam.client.ui.material-ui-icon :as muic]
            [glam.client.ui.common.core :as uic]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]))

(defsc ProjectSettings [this {:project/keys [id name] :as props}]
  {:query         [:project/id :project/name]
   :ident         :project/id
   :initial-state {}
   :route-segment (r/last-route-segment :project-settings)
   :will-enter    (fn [app {:keys [id]}]
                    (dr/route-deferred
                      [:project/id (uuid id)]
                      #(df/load! app [:project/id (uuid id)] ProjectSettings
                                 {:post-mutation        `dr/target-ready
                                  :post-mutation-params {:target [:project/id (uuid id)]}})))}
  (mui/container {:maxWidth "lg" :style {:position "relative"}}
    (mui/page-title name)
    (mui/arrow-breadcrumbs {}
      (mui/link {:color "inherit" :href (r/route-for :admin-home) :key "admin"} "Admin Settings")
      (mui/link {:color "inherit" :href (r/route-for :project-management) :key "project"} "Project Management")
      (mui/link {:color "textPrimary" :href (r/route-for :project-settings {:id id}) :key id} name))
    "Hello, world!"))
