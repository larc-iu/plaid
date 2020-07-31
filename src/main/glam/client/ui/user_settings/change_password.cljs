(ns glam.client.ui.user-settings.change-password
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [com.fulcrologic.fulcro.dom :as dom]
            [sablono.core :as html :refer [html]]
            [glam.client.ui.common :as common]
            [glam.client.router :as r]
            [glam.models.session :as sn]
            [glam.models.user :as user]
            [glam.models.user-common :refer [valid-password]]
            [glam.client.ui.material-ui :as mui]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.components :as comp]
            [glam.client.ui.global-snackbar :as snack]))

(def ident [:component/id :change-password-form])

(defn form-valid [form field]
  (let [v (get form field)]
    (case field
      :current-password (valid-password v)
      :new-password (valid-password v)
      :new-password-confirm (= v (:new-password form)))))

(def validator (fs/make-validator form-valid))

;; TODO: rewrite storing passwords in component-local state
(defsc ChangePasswordForm [this {:keys [current-password new-password-confirm new-password busy?] :as props}]
  {:ident         (fn [_] ident)
   :query         [fs/form-config-join sn/session-join :current-password :new-password :new-password-confirm :busy?]
   :initial-state (fn [_]
                    (fs/add-form-config ChangePasswordForm
                                        {:current-password     ""
                                         :new-password         ""
                                         :new-password-confirm ""
                                         :busy?                false}))
   :form-fields   #{:current-password :new-password :new-password-confirm}}
  (let [on-result (fn [{:server/keys [error? message]}]
                    (m/set-value! this :busy? false)
                    (when-not error?
                      (c/transact! this [(fs/clear-complete! {})
                                         (fs/reset-form! {})]))
                    (when message
                      (snack/message! this {:message  message
                                            :severity (if error? "error" "success")})))
        submit (fn []
                 (when-not busy?
                   (m/set-value! this :busy? true)
                   (c/transact! this [(user/change-own-password
                                        {:current-password current-password
                                         :new-password     new-password})]
                                {:on-result on-result})))]

    (mui/padded-paper
      (dom/form
        {:onSubmit (fn [^js/Event e]
                     (.preventDefault e)
                     (log/info "submit")
                     (submit))}

        (mui/vertical-grid
          (mui/typography {:variant "h4"} "Change Password")
          (common/text-input-with-label this :current-password "Current Password" validator "Password must be 8 or more characters long"
            {:type     "password"
             :value    current-password
             :disabled busy?})
          (common/text-input-with-label this :new-password "New Password" validator "Password must be 8 or more characters long"
            {:type     "password"
             :value    new-password
             :disabled busy?})
          (common/text-input-with-label this :new-password-confirm "Confirm New Password" validator "Passwords must match"
            {:type       "password"
             :value      new-password-confirm
             :disabled   busy?
             :last-input true}))

        (mui/horizontal-grid
          (mui/button
            {:type     "submit"
             :size     "large"
             :disabled (or (not (fs/checked? props))
                           (not= :valid (validator props))
                           busy?)
             :variant  "contained"}
            "Change Password")
          (mui/button
            {:size     "large"
             :disabled busy?
             :variant  "outlined"
             :onClick  (fn []
                         (c/transact! this [(fs/clear-complete! {})])
                         (c/transact! this [(fs/reset-form! {})]))}
            "Reset"))))))

(def ui-change-password-form (c/factory ChangePasswordForm))

