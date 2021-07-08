(ns glam.client.ui.admin.core
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr :refer [defrouter]]
            [glam.models.session :as sn]
            [glam.client.router :as r]
            [glam.client.ui.common.core :refer [loader]]
            [glam.client.ui.material-ui :as mui]
            [glam.client.ui.admin.user-management :refer [UserManagement]]
            [glam.client.ui.admin.project.core :refer [ProjectAdminRouter]]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [com.fulcrologic.fulcro.dom :as dom]
            [glam.client.ui.material-ui-icon :as muic]))

(def ident [:component/id :admin-home])

(def md-card-media (mui/styled-card-media {:height "120px"}))
(defn link-card [route text icon]
  (mui/card {}
    (mui/card-action-area {:onClick #(r/route-to! route)
                           :style   {:textAlign "center"}}
      (md-card-media {}
        (icon {:color "secondary"
               :style {:fontSize  120
                       :marginTop "10px"}}))
      (mui/card-content {}
        (mui/typography {:variant "h5"} text)))))

(defsc AdminHome [this props]
  {:ident         (fn [_] ident)
   :query         [sn/session-join]
   :initial-state (fn [_] sn/session-ident (c/get-initial-state sn/Session {}))
   :route-segment (r/last-route-segment :admin-home)}
  (when (and (sn/valid-session? props) (sn/admin? props))
    (mui/container {:maxWidth "lg"}
      (mui/page-title {:style {:marginBottom "0.7em"}} "Admin Settings")

      (mui/grid {:container true :spacing 3}
        (mui/grid {:item true :xs 6 :md 3}
          (link-card :user-management "Manage Users" muic/supervised-user-circle-sharp))
        (mui/grid {:item true :xs 6 :md 3}
          (link-card :project-overview "Manage Projects" muic/work-outline-two-tone))))))

(defrouter AdminRouter
  [this {:keys [current-state route-factory route-props pending-path-segment]}]
  {:route-segment       (r/router-segment :admin-router)
   :router-targets      [AdminHome UserManagement ProjectAdminRouter]
   :always-render-body? false}
  (loader))
