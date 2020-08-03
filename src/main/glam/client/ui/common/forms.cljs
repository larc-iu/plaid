(ns glam.client.ui.common.forms
  (:require [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [com.fulcrologic.fulcro.algorithms.merge :as merge]
            [com.fulcrologic.fulcro.algorithms.normalized-state :as fns]
            [com.fulcrologic.fulcro.algorithms.data-targeting :as dt]
            [com.fulcrologic.fulcro.ui-state-machines :as uism]
            [com.fulcrologic.fulcro.components :as c]
            [com.fulcrologic.fulcro.dom :as dom]
            [glam.client.ui.material-ui :as mui]
            [glam.client.ui.global-snackbar :as snack]
            [com.fulcrologic.fulcro.mutations :as m]
            [clojure.set :as set]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.algorithms.tempid :as tempid]
            [com.fulcrologic.fulcro.components :as comp]
            [glam.client.ui.material-ui-icon :as muic]))

(defn complete-field
  [this field]
  (c/transact! this [(fs/mark-complete! {:entity-ident (c/get-ident this)
                                         :field        field})]))

;; form stuff
(defn field-attrs
  "A helper function for getting aspects of a particular field."
  [component field validator]
  (let [form (c/props component)
        entity-ident (c/get-ident component form)
        id (str (first entity-ident) "-" (second entity-ident))
        is-dirty? (fs/dirty? form field)
        clean? (not is-dirty?)
        validity (validator form field)
        is-invalid? (= :invalid validity)
        value (get form field "")]
    {:dirty?   is-dirty?
     :ident    entity-ident
     :id       id
     :clean?   clean?
     :validity validity
     :invalid? is-invalid?
     :value    value}))

(defn input-field
  [id attrs]
  (dom/input
    (merge {:id   id
            :name id}
           attrs)))

(defn text-input-with-label
  "Text input based on mui/text-field for use with forms. Note: onBlur completes the field by default."
  [component field label validator validation-message {:keys [last-input] :as input-attrs}]
  (let [{:keys [invalid?]} (field-attrs component field validator)]
    (mui/text-field
      (merge {:key        (str field)
              :variant    "filled"
              :error      invalid?
              :helperText (if invalid? validation-message "")
              :label      label
              :onBlur     #(complete-field component field)
              :onChange   (if last-input
                            (fn [e]
                              (m/set-string!! component field :event e)
                              (complete-field component field))
                            (fn [e]
                              (m/set-string!! component field :event e)))}
             (dissoc input-attrs :last-input)))))

(defn checkbox-input-with-label
  "Checkbox based on mui/checkbox for use with forms. Note: onChange completes the field by default."
  [component field label input-attrs]
  (mui/form-control-label
    {:key     (str field)
     :label   label
     :control (mui/checkbox
                (merge {:onChange (fn [e]
                                    (m/set-value!! component field (.-checked (.-target e)))
                                    (complete-field component field))}
                       input-attrs))}))

(def delete-button (mui/styled-button {:background-color "rgb(220, 0, 78)"}))
(defn form-buttons
  [{:keys [component validator props busy? submit-text reset-text on-reset delete-text on-delete]}]
  (let [using-busy?-and-busy? (and (not (nil? busy?)) busy?)
        on-reset (or on-reset (fn []
                                (c/transact! component [(fs/clear-complete! {})])
                                (c/transact! component [(fs/reset-form! {})])))]
    (mui/horizontal-grid
      (mui/button
        {:type      "submit"
         :size      "large"
         :disabled  (or (not (fs/dirty? props))
                        (not (fs/checked? props))
                        (not= :valid (validator props))
                        using-busy?-and-busy?)
         :color     "primary"
         :variant   "contained"
         :startIcon (muic/save)}
        (or submit-text "Submit"))
      (mui/button
        {:size      "large"
         :disabled  (or (not (fs/dirty? props))
                        using-busy?-and-busy?)
         :variant   "outlined"
         :onClick   on-reset
         :startIcon (muic/restore)}
        (or reset-text "Reset"))
      (when on-delete
        (delete-button
          {:size      "large"
           :disabled  using-busy?-and-busy?
           :variant   "contained"
           :color     "secondary"
           :onClick   on-delete
           :startIcon (muic/delete)}
          (or delete-text "Delete"))))))


;; form machine ----------------------------------------------------------------------------------

(defn mark-filled-fields-complete*
  "Helper function against app state. This function marks `initialized-keys` as complete on the form given a set of
  keys that you consider initialized. Like form state's mark-complete, but on a set instead of a single field."
  [state-map {:keys [entity-ident initialized-keys]}]
  (let [mark-complete* (fn [entity {::fs/keys [fields complete?] :as form-config}]
                         (let [to-mark (set/union (set complete?) (set/intersection (set fields) (set initialized-keys)))
                               to-mark (into #{}
                                             (filter (fn [k] (not (nil? (get entity k)))))
                                             to-mark)]
                           [entity (assoc form-config ::fs/complete? to-mark)]))]
    (fs/update-forms state-map mark-complete* entity-ident)))

(def global-events
  {:event/exit {::uism/handler (fn [env]
                                 (log/debug "edit form: exiting")
                                 (uism/exit env))}})

(uism/defstatemachine edit-form-machine
  {::uism/actor-names
   #{:actor/form}

   ::uism/aliases
   {:busy? [:actor/form :ui/busy?]}

   ::uism/states
   {:initial
    ;; kickoff: add form config, mark fields complete, and begin editing
    {::uism/handler
     (fn [env]
       (let [FormClass (uism/actor-class env :actor/form)
             form-ident (uism/actor->ident env :actor/form)]
         (log/info "edit form: initialized")
         (-> env
             (uism/apply-action fs/add-form-config* FormClass form-ident)
             (uism/apply-action fs/entity->pristine* form-ident)
             ;; TODO: should this only apply to filled fields?
             (uism/apply-action fs/mark-complete* form-ident)
             (uism/activate :state/editing))))}

    :state/editing
    ;; editing: we can (1) exit, (2) begin a save, (3) restore pristine state
    {::uism/events
     (merge global-events
            {:event/save
             {::uism/handler
              (fn [{::uism/keys [state-map] :as env}]
                (log/info "edit form: handling save")
                (let [FormClass (uism/actor-class env :actor/form)
                      form-ident (uism/actor->ident env :actor/form)
                      save-mutation (-> FormClass c/component-options ::save-mutation)
                      props (fns/ui->props state-map FormClass form-ident)
                      delta (fs/dirty-fields props true)]
                  (if-not save-mutation
                    (log/info (str "Class " FormClass " must have a 'glam.client.common.forms/save-mutation"))
                    (do
                      (log/info (pr-str (keys (::uism/state-map env))))
                      (log/info (pr-str (::uism/event-data env)))
                      (-> env
                          (uism/assoc-aliased :busy? true)
                          (uism/activate :state/saving)
                          (uism/trigger-remote-mutation :actor/form save-mutation
                                                        {::uism/ok-event    :event/save-ok
                                                         ::uism/error-event :event/save-error
                                                         :ident             form-ident
                                                         :delta             (get delta form-ident)}))))))}
             :event/reset
             {::uism/handler
              (fn [{::uism/keys [state-map] :as env}]
                (let [FormClass (uism/actor-class env :actor/form)
                      form-ident (uism/actor->ident env :actor/form)
                      props (fns/ui->props state-map FormClass form-ident)]
                  (log/info "edit form: handling reset")
                  (when (fs/dirty? props)
                    (snack/message! {:message "Changes discarded"})
                    (let [form-ident (uism/actor->ident env :actor/form)]
                      (uism/apply-action env fs/pristine->entity* form-ident)))))}})}

    :state/saving
    ;; in the middle of a save: remote mutation will emit save-ok or save-error, and if it's OK,
    ;; update the pristine state
    {::uism/events
     (merge
       global-events
       {:event/save-ok
        {::uism/handler
         (fn [env]
           (let [form-ident (uism/actor->ident env :actor/form)
                 FormClass (uism/actor-class env :actor/form)
                 message (or (-> FormClass c/component-options ::save-message) "Saved")]
             ;; update pristine state and go to :state/editing
             (log/info "edit form: save ok")
             (snack/message! {:message message :severity "success"})
             (-> env
                 (uism/apply-action fs/entity->pristine* form-ident)
                 (uism/assoc-aliased :busy? false)
                 (uism/activate :state/editing))))}
        :event/save-error
        {::uism/handler
         (fn [{::uism/keys [event-data] :as env}]
           (let [FormClass (uism/actor-class env :actor/form)
                 save-mutation (-> FormClass c/component-options ::save-mutation)
                 message (some-> event-data ::uism/mutation-result :body (get save-mutation) :server/message)]
             (log/info "edit form: save failed")
             (snack/message! {:message  (if message message "Error occurred, save has failed.")
                              :severity "error"})
             (-> env
                 (uism/assoc-aliased :busy? false)
                 (uism/activate :state/editing))))}})}}})
