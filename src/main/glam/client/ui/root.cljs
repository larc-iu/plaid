(ns glam.client.ui.root
  (:require
    [com.fulcrologic.fulcro.application :as app]
    [com.fulcrologic.fulcro.components :as c :refer [defsc]]
    [com.fulcrologic.fulcro.dom :as dom :refer [div]]
    [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
    [com.fulcrologic.fulcro.ui-state-machines :as sm]
    [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
    [glam.models.session :as session :refer [Session session-join valid-session?]]
    [glam.client.application :refer [SPA]]
    [glam.client.router :as r]
    [glam.client.ui.material-ui :as mui]
    [glam.client.ui.material-ui-icon :as muic]
    [glam.client.ui.drawer :refer [ui-drawer Drawer]]
    [glam.client.ui.common.core :refer [loader]]
    [glam.client.ui.project.core :refer [ProjectRouter]]
    [glam.client.ui.user-settings.core :refer [UserSettings]]
    [glam.client.ui.admin-settings.core :refer [AdminRouter]]
    [glam.client.ui.home :refer [Home]]
    [glam.client.ui.login :refer [logout-button Login]]
    [glam.client.ui.global-snackbar :refer [ui-global-snackbar GlobalSnackbar]]
    [com.fulcrologic.fulcro.components :as comp]))

(dr/defrouter TopRouter
  [this {:keys [current-state route-factory route-props]}]
  {:router-targets      [Home ProjectRouter UserSettings AdminRouter]
   :always-render-body? false}
  (loader))

(def ui-top-router (c/factory TopRouter))

(def ident [:component/id :page-container])

(defmutation set-open [{:keys [open?]}]
  (action [{:keys [state]}]
          (swap! state #(assoc-in % (conj ident :root/drawer-open?) open?))))

(defsc PageContainer [this {:root/keys [drawer global-snackbar router drawer-open?] :as props}]
  {:query         [{:root/router (c/get-query TopRouter)}
                   {:root/global-snackbar (c/get-query GlobalSnackbar)}
                   {:root/drawer (c/get-query Drawer)}
                   :root/drawer-open?
                   [::sm/asm-id ::TopRouter]
                   session-join]
   :ident         (fn [] ident)
   :initial-state (fn [_] {:root/router          (c/get-initial-state TopRouter {})
                           :root/global-snackbar (c/get-initial-state GlobalSnackbar {})
                           :root/drawer          (c/get-initial-state Drawer {})
                           :root/drawer-open?    false
                           session/session-ident (c/get-initial-state Session {})})}
  (let [session? (valid-session? props)]
    (mui/theme-provider {:theme mui/default-theme}
      (ui-global-snackbar global-snackbar)
      (mui/app-bar {:position "static"}
        (mui/toolbar {:variant "dense"}
          (mui/icon-button {:edge     "start"
                            :color    "inherit"
                            :disabled (not session?)
                            :onClick  #(c/transact! this [(set-open {:open? true})])}
            (muic/menu {:fontSize "large"}))
          ((mui/styled-typography {:flex-grow 1}) {:variant "h5"} "Glam")
          (logout-button this session?)))
      (when session?
        (ui-drawer
          (c/computed drawer {:open?   drawer-open?
                              :onClose #(c/transact! this [(set-open {:open? false})])})))
      (mui/css-baseline)
      (ui-top-router router))))

(def ui-page-container (c/factory PageContainer))

(defsc Root [_ {:root/keys [page-container]}]
  {:query         [{:root/page-container (c/get-query PageContainer)}]
   :initial-state (fn [_] {:root/page-container (c/get-initial-state PageContainer {})})}
  ^:inline (ui-page-container page-container))
