(ns glam.client.ui.admin.project.core
  (:require
    [com.fulcrologic.fulcro.routing.dynamic-routing :as dr :refer [defrouter]]
    [glam.client.router :as r]
    [glam.client.ui.common.core :refer [loader]]
    [glam.client.ui.admin.project.overview :refer [ProjectOverview]]
    [glam.client.ui.admin.project.settings :refer [ProjectSettings]]))

(defrouter ProjectAdminRouter
           [this {:keys [current-state route-factory route-props pending-path-segment]}]
           {:route-segment       (r/router-segment :project-admin-router)
            :router-targets      [ProjectOverview ProjectSettings]
            :always-render-body? false}
           (loader))
