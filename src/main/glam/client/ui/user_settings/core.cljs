(ns glam.client.ui.user-settings.core
  (:require [com.fulcrologic.fulcro.components :refer [defsc]]
            [com.fulcrologic.fulcro.components :as c]
            [glam.models.session :as sn]
            [glam.client.router :as r]
            [glam.client.ui.user-settings.change-password :refer [ChangePasswordForm ui-change-password-form]]
            [glam.client.ui.material-ui :as mui]))

(defsc UserSettings [this {:keys [change-password-form] :as props}]
  {:ident         (fn [_] [:component/id :user-settings])
   :query         [sn/session-join
                   {:change-password-form (c/get-query ChangePasswordForm)}]
   :initial-state {:change-password-form {}}
   :route-segment (r/route-segment :user-settings)}
       (when (sn/valid-session? props)
         (mui/page-container
           (ui-change-password-form change-password-form))))
