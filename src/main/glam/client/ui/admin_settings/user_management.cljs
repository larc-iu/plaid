(ns glam.client.ui.admin-settings.user-management
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [com.fulcrologic.fulcro.algorithms.merge :as merge]
            [com.fulcrologic.fulcro.algorithms.denormalize :as fdn]
            [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [taoensso.timbre :as log]
            [glam.client.router :as r]
            [glam.client.application :refer [SPA]]
            [glam.models.session :as sn]
            [glam.models.user :as user :refer [validator]]
            [glam.client.ui.material-ui :as mui]
            [glam.client.ui.material-ui-icon :as muic]
            [glam.client.ui.common.forms :as forms]
            [com.fulcrologic.fulcro.ui-state-machines :as uism]
            [com.fulcrologic.fulcro.components :as comp]
            [com.fulcrologic.fulcro.application :as app]
            [glam.client.ui.global-snackbar :as snack]
            [com.fulcrologic.fulcro.algorithms.tempid :as tempid]
            [com.fulcrologic.fulcro.algorithms.normalized-state :as fns]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]))

;; ident of the root element
(def ident [:component/id :user-management])

;; --------------------------------------------------------------------------------
;; user edit
;; --------------------------------------------------------------------------------
(def email-typography (mui/styled-typography {:margin-left "1em"}))
(def admin-icon (mui/styled-icon {:margin-right "0.5em"}))

(declare UserAccordion)
(defn make-change-handler [this id expanded-id expand]
  (fn [_]
    (let [open-accordion
          (fn []
            (uism/begin! this forms/edit-form-machine ::edit-user
                         {:actor/form (uism/with-actor-class [:user/id id] UserAccordion)})
            (expand id))
          #_#(df/load! this [:user/id id] UserAccordion
                       {:post-action
                        (fn []
                          (uism/begin! this forms/edit-form-machine ::edit-user
                                       {:actor/form (uism/with-actor-class
                                                      [:user/id id] UserAccordion)})
                          (expand id))})]
      (cond
        ;; clicked on the currently open form--close it and exit the uism
        (= expanded-id id)
        (do
          (expand nil)
          (uism/trigger! this ::edit-user :event/reset)
          (uism/trigger! this ::edit-user :event/exit))
        ;; clicked on a different form--close the existing uism and open the other
        (get-in (app/current-state SPA) (uism/asm-ident ::edit-user))
        (do
          (uism/trigger! this ::edit-user :event/reset)
          (uism/trigger! this ::edit-user :event/exit)
          (open-accordion))
        ;; first click
        :else
        (open-accordion)))))

;; This component is complicated somewhat by the fact that we want to also allow password resets.
;; A new password is not like other user props, in that it will never be loaded, and also can be
;; either used or ignored when editing a user. To accommodate this, we exclude it from the :form-fields
;; vector and need to give it some special attention in the form edit state machine
(defsc UserAccordion [this
                      {:user/keys [id name email admin? new-password] :ui/keys [busy?] :as props}
                      {:keys [expanded-id expand]}]
  {:query                   [:user/id :user/name :user/email :user/new-password :user/admin?
                             fs/form-config-join :ui/busy?]
   :pre-merge               (fn [{:keys [current-normalized data-tree]}]
                              (update data-tree :user/new-password #(if (= % ::merge/not-found) "" %)))
   :ident                   :user/id
   :form-fields             #{:user/name :user/email :user/admin?}
   ::forms/save-mutation    'glam.models.user/save-user
   ::forms/save-message     "User saved"
   ::forms/save-extra-props [:user/new-password]
   ::forms/delete-mutation  'glam.models.user/delete-user
   ::forms/delete-message   "User deleted"}
  (let [dirty (or (> (count new-password) 0)
                  (fs/dirty? props))]
    (mui/accordion {:expanded        (= expanded-id id)
                    :onChange        (make-change-handler this id expanded-id expand)
                    :TransitionProps {:unmountOnExit true}
                    :key             id}
      (mui/accordion-summary {:expandIcon (muic/expand-more)}
        (c/fragment
          (when admin?
            (admin-icon {:color (if (= expanded-id id) "primary" "disabled")}
              (muic/gavel)))
          (mui/typography {} (str name))
          (email-typography {:color "textSecondary"} (str email))))

      (mui/accordion-details {}
        (dom/form
          {:onSubmit (fn [e] (.preventDefault e)
                       (uism/trigger! this ::edit-user :event/save)
                       (m/set-string! this :user/new-password :value "")
                       (c/transact! this [(fs/clear-complete! {:entity-ident [:user/id id]
                                                               :field        :user/new-password})]))}
          (mui/vertical-grid
            (forms/text-input-with-label this :user/name "Name" validator "Must have 2 to 40 characters"
                                         {:fullWidth true
                                          :value     name
                                          :disabled  busy?})
            (forms/text-input-with-label this :user/email "Email" validator "Must be a valid email"
                                         {:value     email
                                          :fullWidth true
                                          :disabled  busy?})
            (forms/text-input-with-label this :user/new-password "New Password" validator "Must be 8 characters or longer"
                                         {:type      "password"
                                          :value     new-password
                                          :fullWidth true
                                          :onChange  (fn [e]
                                                       (m/set-string!! this :user/new-password :event e)
                                                       (forms/complete-field this :user/new-password)
                                                       (when (= (.-value (.-target e)) "")
                                                         (c/transact! this [(fs/clear-complete! {:entity-ident [:user/id id]
                                                                                                 :field        :user/new-password})])))
                                          :disabled  busy?})
            (forms/checkbox-input-with-label this :user/admin? "Admin"
                                             {:checked  admin?
                                              :color    "primary"
                                              :disabled busy?}))

          (forms/form-buttons
            {:component       this
             :validator       validator
             :props           props
             :busy?           busy?
             :submit-text     "Save User"
             :reset-text      "Discard Changes"
             :on-reset        (fn []
                                (uism/trigger! this ::edit-user :event/reset)
                                (c/transact! this [(fs/clear-complete!
                                                     {:entity-ident [:user/id id]
                                                      :field        :user/new-password})])
                                (m/set-string! this :user/new-password :value ""))
             :on-delete       #(uism/trigger! this ::edit-user :event/delete)
             :submit-disabled (not (and dirty
                                        (or (= (count new-password) 0) (= :valid (validator props :user/new-password)))
                                        (fs/checked? props)
                                        (= :valid (validator props))
                                        (not busy?)))
             :reset-disabled  (not (and dirty (not busy?)))}))))))

(def ui-user-accordion (c/factory UserAccordion {:keyfn :user/id}))

;; --------------------------------------------------------------------------------
;; add user
;; --------------------------------------------------------------------------------
(def add-user-fab (mui/styled-fab {:position   "absolute"
                                   :margin-top "3em"
                                   :right      "2em"}))

(defn add-user* [state-map id]
  (let [user-ident [:user/id id]
        user {:user/id id :user/name "" :user/email "" :user/password "" :user/admin? false}]
    (assoc-in state-map user-ident user)))

(defmutation init-add-user [{:keys [id]}]
  (action [{:keys [state]}]
          (swap! state (fn [s]
                         (-> s
                             (add-user* id)
                             (assoc-in (conj ident :add-user) [:user/id id]))))))

(defmutation finish-add-user [{:keys [id]}]
  (action [{:keys [state]}]
          (swap! state (fn [s]
                         (fns/remove-entity s [:user/id id])))))

(defsc AddUser [this {:user/keys [id name email password admin?] :ui/keys [busy?] :as props}]
  {:ident                   :user/id
   :query                   [fs/form-config-join :user/id :user/name :user/email :user/password :user/admin? :ui/busy?]
   :initial-state           {:ui/busy? false}
   :form-fields             #{:user/name :user/email :user/admin? :user/password}
   ::forms/create-mutation  'glam.models.user/create-user
   ::forms/create-message   "User created"
   ::forms/create-append-to (conj ident :users)}
  (let [close-cu-dialog (fn []
                          (uism/trigger! this ::add-user :event/cancel)
                          (c/transact! this [(finish-add-user {:id id})]))]
    (dom/form
      {:onSubmit (fn [e]
                   (.preventDefault e)
                   (uism/trigger! this ::add-user :event/create))}
      (mui/vertical-grid
        (forms/text-input-with-label this :user/name "Name" validator "Must have 2 to 40 characters"
                                     {:fullWidth true
                                      :value     name
                                      :disabled  busy?
                                      :autoFocus true})
        (forms/text-input-with-label this :user/email "Email" validator "Must be a valid email"
                                     {:value     email
                                      :fullWidth true
                                      :disabled  busy?})
        (forms/text-input-with-label this :user/password "Password" validator "Must be 8 characters or longer"
                                     {:type      "password"
                                      :value     password
                                      :fullWidth true
                                      :disabled  busy?
                                      :onChange  (fn [e]
                                                   (m/set-string!! this :user/password :event e)
                                                   (forms/complete-field this :user/password))})
        (forms/checkbox-input-with-label this :user/admin? "Admin"
                                         {:checked  admin?
                                          :color    "primary"
                                          :disabled busy?}))
      (mui/horizontal-grid
        (mui/button
          {:type      "submit"
           :size      "large"
           :color     "primary"
           :variant   "contained"
           :startIcon (muic/create)
           :disabled  (not (and (fs/dirty? props)
                                (fs/checked? props)
                                (= :valid (validator props))
                                (not busy?)))}
          "Create User")
        (mui/button
          {:size      "large"
           :variant   "outlined"
           :onClick   close-cu-dialog
           :startIcon (muic/cancel)}
          "Cancel")))))

(def ui-add-user (c/factory AddUser))

;; --------------------------------------------------------------------------------
;; root
;; --------------------------------------------------------------------------------
(defsc UserManagement [this {:keys [users expanded-id add-user] :ui/keys [modal-open?] :as props}]
  {:ident         (fn [_] ident)
   :query         [{:users (c/get-query UserAccordion)}
                   :expanded-id
                   :ui/modal-open?
                   {:add-user (c/get-query AddUser)}]
   :initial-state (fn [_]
                    {:users          []
                     :expanded-id    {}
                     :ui/modal-open? false})
   :route-segment (r/last-route-segment :user-management)
   :will-enter    (fn [app route-params]
                    (dr/route-deferred
                      ident
                      #(df/load! app :all-users UserAccordion
                                 {:target               (conj ident :users)
                                  :post-mutation        `dr/target-ready
                                  :post-mutation-params {:target ident}})))}
  (mui/container {:maxWidth "lg"}
    (mui/page-title "User Management")
    (mui/arrow-breadcrumbs {}
      (mui/link {:color "inherit" :href (r/route-for :admin-home) :key "admin"} "Admin Settings")
      (mui/link {:color "textPrimary" :href (r/route-for :user-management) :key "user"} "User Management"))

    ;; add user button
    (mui/dialog {:open modal-open? :onClose #(uism/trigger! this ::add-user :event/cancel)}
      (mui/dialog-title {} "Create User")
      (mui/dialog-content {}
        (when add-user
          (ui-add-user add-user))))
    (mui/button
      {:variant   "contained"
       :color     "primary"
       :startIcon (muic/add)
       :onClick (fn []
                  (let [id (tempid/tempid)]
                    (c/transact! this [(init-add-user {:id id})])
                    (uism/begin! this forms/create-form-machine ::add-user
                                 {:actor/form       (uism/with-actor-class [:user/id id] AddUser)
                                  :actor/modal-host (uism/with-actor-class ident UserManagement)})))
       :style {:marginBottom "1em"}}
      "New User")

    ;; user accordions
    (for [user (sort-by (fn [u] [(if (:user/admin? u) 0 1) (:user/name u)]) users)]
      (ui-user-accordion
        (c/computed
          user
          {:expanded-id expanded-id
           :expand      #(m/set-value! this :expanded-id %)})))))

(def ui-user-management (c/factory UserManagement))
