(ns glam.client.ui.document.core
  (:require
    [com.fulcrologic.fulcro.components :as c :refer [defsc]]
    [com.fulcrologic.fulcro.routing.dynamic-routing :as dr :refer [defrouter]]
    [glam.client.router :as r]
    [glam.client.ui.common.core :refer [loader]]
    [glam.client.ui.document.document :refer [Document]]
    [taoensso.timbre :as log]))

(defrouter DocumentRouter
  [this props]
  {:route-segment       (r/router-segment :document-router)
   :router-targets      [Document]
   :always-render-body? false}
  (loader))
