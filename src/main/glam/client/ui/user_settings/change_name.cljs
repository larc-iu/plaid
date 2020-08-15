(ns glam.client.ui.user-settings.change-name
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [com.fulcrologic.fulcro.dom :as dom]
            [glam.client.ui.common.forms :as forms]
            [glam.client.ui.global-snackbar :as snack]
            [glam.models.session :as sn]
            [glam.models.user :as user :refer [valid-name]]
            [glam.client.ui.material-ui :as mui]
            [com.fulcrologic.fulcro.mutations :as m]))

(def ident [:component/id :change-name-form])

(defn form-valid [form field]
  (let [v (get form field)]
    (case field
      :new-name (valid-name v))))

(def validator (fs/make-validator form-valid))

(defsc ChangeNameForm [this {:keys [new-name] :as props}]
  {:ident         (fn [_] ident)
   :query         [sn/session-join fs/form-config-join :new-name]
   :initial-state (fn [_] (fs/add-form-config ChangeNameForm
                                              {:new-name ""}))
   :validator     validator
   :form-fields   #{:new-name}}
  (let [submit (fn []
                 (c/transact! this [(fs/clear-complete! {})
                                    (fs/reset-form! {})])
                 (c/transact! this [(user/change-own-name {:name new-name})]
                              {:on-result (fn [{:server/keys [message error?]}]
                                            (js/console.log "got message " message)
                                            (snack/message! this {:severity (if error? "error" "success")
                                                                  :message  message}))})
                 (m/set-string! this :new-name :value ""))]
    (mui/padded-paper
      (dom/div
        (dom/form
          {:onSubmit (fn [^js/Event e]
                       (.preventDefault e)
                       (submit))}

          (mui/grid {:container true :direction "column" :spacing 1}
            (mui/grid {:item true}
              (mui/typography {:variant "h4"} "Change Name"))

            (mui/grid {:item true}
              (forms/text-input-with-label this :new-name "Name" "Name must be between 2 and 40 characters long"
                {:type     "text"
                 :onChange (fn [e]
                             (m/set-string!! this :new-name :event e)
                             (c/transact! this [(fs/mark-complete! {:entity-ident ident
                                                                    :field        :new-name})]))}))

            (mui/grid {:container true :item true :direction "row" :spacing 1}
              (mui/grid {:item true}
                (mui/button
                  {:type     "submit"
                   :size     "large"
                   :disabled (not= :valid (validator props))
                   :variant  "contained"}
                  "Change Name")))))))))

(def ui-change-name-form (c/factory ChangeNameForm))

