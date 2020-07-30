(ns glam.client.ui.user-settings.core
  (:require [com.fulcrologic.fulcro.components :refer [defsc]]
            [com.fulcrologic.fulcro.components :as c]
            [glam.models.session :as sn]
            [glam.client.router :as r]
            [glam.client.ui.user-settings.change-password :refer [ChangePasswordForm ui-change-password-form]]
            [glam.client.ui.user-settings.change-name :refer [ChangeNameForm ui-change-name-form]]
            [glam.client.ui.material-ui :as mui]))

(defsc UserSettings [this {:keys [change-name-form
                                  change-password-form] :as props}]
  {:ident         (fn [_] [:component/id :user-settings])
   :query         [sn/session-join
                   {:change-name-form (c/get-query ChangeNameForm)}
                   {:change-password-form (c/get-query ChangePasswordForm)}]
   :initial-state {:change-name-form     {}
                   :change-password-form {}}
   :route-segment (r/route-segment :user-settings)}
  (when (sn/valid-session? props)
    (mui/page-container
      (c/fragment
        (ui-change-name-form change-name-form)
        (ui-change-password-form change-password-form)))))
