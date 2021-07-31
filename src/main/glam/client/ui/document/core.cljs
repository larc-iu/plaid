(ns glam.client.ui.document.core
  (:require
    [com.fulcrologic.fulcro.components :as c :refer [defsc]]
    [com.fulcrologic.fulcro.routing.dynamic-routing :as dr :refer [defrouter]]
    [com.fulcrologic.fulcro.data-fetch :as df]
    [glam.client.router :as r]
    [glam.client.ui.common.core :refer [loader]]
    [glam.client.ui.project.projects-page :refer [ProjectsPage]]
    [glam.client.ui.project.project :refer [ProjectDetail]]
    [taoensso.timbre :as log]))

;; ;; top level --------------------------------------------------------------------------------
;; ;; router for all routes under "/project/" is contained in a container component, Projects
;; (defrouter ProjectRouter
;;   [this {:keys [current-state route-factory route-props]}]
;;   {:route-segment  (r/router-segment :project-router)
;;    :router-targets [ProjectsPage ProjectDetail]
;;    :always-render-body? false}
;;   (loader))

