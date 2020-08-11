(ns glam.client.ui.drawer
  (:require
    [com.fulcrologic.fulcro.application :as app]
    [com.fulcrologic.fulcro.components :as c :refer [defsc]]
    [com.fulcrologic.fulcro.dom :as dom :refer [div]]
    [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
    [com.fulcrologic.fulcro.ui-state-machines :as sm]
    [com.fulcrologic.fulcro.components :as comp]
    [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
    [glam.models.session :as session :refer [Session session-join valid-session?]]
    [glam.client.application :refer [SPA]]
    [glam.client.router :as r]
    [glam.client.ui.material-ui :as mui]
    [glam.client.ui.material-ui-icon :as muic]
    ))

(def ident [:component/id :drawer])

(defn drawer-item
  ([path text icon onClose]
   (drawer-item path text icon onClose nil))
  ([path text icon onClose divider]
   (mui/list-item {:key     text
                   :button  true
                   :divider (boolean divider)
                   :onClick (fn [e]
                              (onClose)
                              (r/route-to! path))}
     (mui/list-item-icon {} (icon))
     (mui/list-item-text {} text))))

(defsc Drawer [this props {:keys [onClose open?]}]
  {:query         [session-join]
   :ident         (fn [] ident)
   :initial-state {}}
  (let [admin? (session/admin? props)]
    (mui/drawer
      {:open    open?
       :onClose onClose
       :anchor  "left"}
      ((mui/styled-list {:width 300}) {}

       (drawer-item :projects "Projects" muic/home onClose)
       (drawer-item :user-settings "Settings" muic/settings onClose admin?)

       (when admin?
         (drawer-item :admin-home "Admin Settings" muic/supervisor-account onClose))))))

(def ui-drawer (c/factory Drawer))