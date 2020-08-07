(ns glam.client.ui.admin-settings.user-management
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
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
            [glam.client.ui.global-snackbar :as snack]))

(def ident [:component/id :user-management])

(def email-typography (mui/styled-typography {:margin-left "1em"}))
(def admin-icon (mui/styled-icon {:margin-right "0.5em"}))

(declare UserAccordion)
(defn make-change-handler [this id expanded-id expand]
  (fn [_]
    (let [open-accordion
          #(df/load! this [:user/id id] UserAccordion
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

(defsc UserAccordion [this
                      {:user/keys [id name email admin? reader writer] :ui/keys [busy?] :as props}
                      {:keys [expanded-id expand on-delete]}]
  {:query                [:user/id :user/name :user/email :user/admin? :user/reader :user/writer
                          fs/form-config-join :ui/busy?]
   :ident                :user/id
   :initial-state        {}
   :form-fields          #{:user/name :user/email :user/admin? :user/reader :user/writer}
   ::forms/save-mutation 'glam.models.user/save-user
   ::forms/save-message  "User saved"}
  (mui/accordion {:expanded        (= expanded-id id)
                  :onChange        (make-change-handler this id expanded-id expand)
                  :TransitionProps {:unmountOnExit true}}
    (mui/accordion-summary {:expandIcon (muic/expand-more)}
      (c/fragment
        (when admin?
          (admin-icon {:color (if (= expanded-id id) "primary" "disabled")}
            (muic/gavel)))
        (mui/typography {} (str name))
        (email-typography {:color "textSecondary"} (str email))))

    (mui/accordion-details {}
      (dom/form
        {:onSubmit (fn [e] (.preventDefault e) (uism/trigger! this ::edit-user :event/save))}
        (mui/vertical-grid
          (forms/text-input-with-label this :user/name "Name" validator "Must have 2 to 40 characters"
                                       {:type     "text"
                                        :value    name
                                        :disabled busy?})
          (forms/text-input-with-label this :user/email "Email" validator "Must be a valid email"
                                       {:value    email
                                        :disabled busy?})
          (forms/checkbox-input-with-label this :user/admin? "Admin"
                                           {:checked  admin?
                                            :color    "primary"
                                            :disabled busy?}))

        (forms/form-buttons
          {:component   this
           :validator   validator
           :props       props
           :busy?       busy?
           :submit-text "Save User"
           :reset-text  "Discard Changes"
           :on-reset    #(uism/trigger! this ::edit-user :event/reset)
           :on-delete   (fn []
                          (m/set-value!! this :ui/busy? true)
                          (uism/trigger! this ::edit-user :event/exit)
                          (on-delete #(m/set-value!! this :ui/busy? false)))})))))

(def ui-user-accordion (c/factory UserAccordion {:keyfn :user/id}))

(def um-container (mui/styled-container {:position "relative"}))

(def add-user-fab (mui/styled-fab {:position   "absolute"
                                   :margin-top "3em"
                                   :right      "2em"}))

(defsc UserManagement [this {:keys [users expanded-id] :as props}]
  {:ident         (fn [_] ident)
   :query         [{:users (c/get-query UserAccordion)}
                   :expanded-id]
   :initial-state (fn [_]
                    {:users       (c/get-initial-state UserAccordion)
                     :expanded-id {}})
   :load-fn       #(df/load! SPA :all-users UserAccordion {:target (conj ident :users)})}
  (um-container {}
    (c/fragment
      (for [{:user/keys [id] :as user} (sort-by (fn [u] [(if (:user/admin? u) 0 1) (:user/name u)]) users)]
        (ui-user-accordion
          (c/computed
            user
            {:expanded-id expanded-id
             :expand      #(m/set-value! this :expanded-id %)
             :on-delete   (fn [on-fail]
                            (comp/transact! this [(user/delete-user {:user/id id})]
                                            {:on-result
                                             (fn [{:server/keys [error? message]}]
                                               (if error?
                                                 (on-fail)
                                                 (m/set-value! this :users (log/spy (vec (filter #(not= (:user/id %) id) users)))))
                                               (when message
                                                 (snack/message! this {:message  message
                                                                       :severity (if error? "error" "success")})))}))})))
      (add-user-fab
        {:label "Add"
         :color "primary"}
        (muic/add)))))

(def ui-user-management (c/factory UserManagement))
