(ns glam.client.ui.admin-settings.user-management
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [com.fulcrologic.fulcro.algorithms.denormalize :as fdn]
            [com.fulcrologic.fulcro.dom :as dom]
            [sablono.core :as html :refer [html]]
            [glam.client.ui.common :as common]
            [glam.client.router :as r]
            [glam.models.session :as sn]
            [glam.models.user :as user]
            [glam.models.user-common :refer [valid-password]]
            [glam.client.ui.material-ui :as mui]
            [glam.client.application :refer [SPA]]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.data-fetch :as df]))

(def ident [:component/id :user-management])

(defsc UserRow [_ _]
  {:query [:user/id :user/name :user/email :user/admin?]})

(defsc UserManagement [this {:keys [users] :as props}]
  {:ident         (fn [_] ident)
   :query         [:users]
   :initial-state {:users []}
   :load-fn       #(df/load! SPA :all-users UserRow {:target (conj ident :users)})}
  (mui/container {}
    (mui/material-table {:title   "User Management"
                         :columns [{:title "Name" :field :name}
                                   {:title "Email" :field :email}
                                   {:title "Admin?" :field :admin? :type "boolean"}]
                         :data    (clj->js users)
                         :options {:pageSize        10
                                   :pageSizeOptions [10 25 50]}})))

(def ui-user-management (c/factory UserManagement))