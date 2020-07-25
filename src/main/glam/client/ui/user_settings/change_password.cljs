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
            [taoensso.timbre :as log]))

(def ident [:component/id :change-password-form])

(defn form-valid [form field]
  (let [v (get form field)]
    (case field
      :current-password (valid-password v)
      :new-password (valid-password v)
      :new-password-confirm (= v (:new-password form)))))

(def validator (fs/make-validator form-valid))

(defn complete-field
  [this field]
  (c/transact! this [(fs/mark-complete! {:entity-ident ident
                                         :field        field})]))

(defmutation mark-busy [{:keys [busy?]}]
  (action [{:keys [state]}]
    (swap! state #(assoc-in % (conj ident :busy?) busy?))))

(defmutation handle-server-message [{:server/keys [message error?]}]
  (action [{:keys [state]}]
    (swap! state (fn [s]
                   (-> s
                       (assoc-in (conj ident :server-msg) message)
                       (assoc-in (conj ident :server-err) error?))))))

;; TODO: rewrite storing passwords in component-local state
(defsc ChangePasswordForm [this {:keys [current-password
                                        new-password-confirm
                                        new-password
                                        server-msg
                                        server-err
                                        busy?]
                                 :as   props}]
  {:ident         (fn [_] ident)
   :query         [fs/form-config-join
                   sn/session-join
                   :current-password
                   :new-password
                   :new-password-confirm
                   :server-msg
                   :server-err
                   :busy?]
   :initial-state (fn [_]
                    (fs/add-form-config ChangePasswordForm
                                        {:current-password     ""
                                         :new-password         ""
                                         :new-password-confirm ""
                                         :server-msg           ""
                                         :server-err           false
                                         :busy?                false}))
   :form-fields   #{:current-password :new-password :new-password-confirm}}
  (let [submit (fn []
                 (when-not busy?
                   (c/transact! this [(handle-server-message {:server/error?  ""
                                                              :server/message ""})
                                      (mark-busy {:busy? true})
                                      (user/change-password
                                        {:current-password current-password
                                         :new-password     new-password
                                         :user/email       (:user/email (sn/get-session props))
                                         :form-component   this
                                         :on-success       [(mark-busy {:busy? false})
                                                            (fs/clear-complete! {})
                                                            (fs/reset-form! {})]
                                         :on-error         [(mark-busy {:busy? false})]
                                         :message-handler  handle-server-message})])))]


    (dom/form
      {:onSubmit (fn [^js/Event e]
                   (.preventDefault e)
                   (log/info "submit")
                   (submit))}

      (mui/grid {:container true :direction "column" :spacing 1}
        (mui/grid {:item true}
          (mui/typography {:variant "h4"} "Change Password"))
        (mui/grid {:item true}
          (when-not (empty? server-msg)
            (mui/alert {:severity (if server-err "error" "success")}
              server-msg)))

        (mui/grid {:item true}
          (common/text-input-with-label this :current-password "Current Password" validator "Password must be 8 or more characters long"
            {:type     "password"
             :value    current-password
             :disabled busy?
             :onBlur   #(complete-field this :current-password)
             :onChange #(m/set-string!! this :current-password :event %)}))
        (mui/grid {:item true}
          (common/text-input-with-label this :new-password "New Password" validator "Password must be 8 or more characters long"
            {:type     "password"
             :value    new-password
             :disabled busy?
             :onBlur   #(complete-field this :new-password)
             :onChange #(m/set-string!! this :new-password :event %)}))
        (mui/grid {:item true}
          (common/text-input-with-label this :new-password-confirm "Confirm New Password" validator "Passwords must match"
            {:type     "password"
             :value    new-password-confirm
             :disabled busy?
             :onBlur   #(complete-field this :new-password-confirm)
             :onChange (fn [e]
                         (m/set-string!! this :new-password-confirm :event e)
                         ;; also mark complete when it's valid since this is the last in the form
                         (complete-field this :new-password-confirm))}))

        (mui/grid {:container true :item true :direction "row" :spacing 1}
          (mui/grid {:item true}
            (mui/button
              {:type     "submit"
               :size     "large"
               :disabled (or (not (fs/checked? props))
                             (not= :valid (validator props))
                             busy?)
               :variant  "contained"}
              "Change Password"))
          (mui/grid {:item true}
            (mui/button
              {:onClick  (fn []
                           (c/transact! this [(handle-server-message {:server/error?  false
                                                                      :server/message ""})])
                           (c/transact! this [(fs/clear-complete! {})])
                           (c/transact! this [(fs/reset-form! {})]))
               :size     "large"
               :disabled busy?
               :variant  "outlined"}
              "Reset")))))))

(def ui-change-password-form (c/factory ChangePasswordForm))

