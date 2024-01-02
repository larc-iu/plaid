(ns glam.client.ui.common.forms
  (:require [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [com.fulcrologic.fulcro.algorithms.merge :as merge]
            [com.fulcrologic.fulcro.algorithms.normalized-state :as fns]
            [com.fulcrologic.fulcro.algorithms.denormalize :as fdn]
            [com.fulcrologic.fulcro.algorithms.data-targeting :as dt]
            [com.fulcrologic.fulcro.ui-state-machines :as uism]
            [com.fulcrologic.fulcro.components :as c]
            [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [com.fulcrologic.fulcro.dom :as dom]
            [glam.client.application :refer [SPA]]
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
  [component field-key label validation-message {:keys [last-input] :as input-attrs}]
  (let [validator (::validator (c/component-options component))]
    (when (nil? validator)
      (log/error "No validator provided for" component "! Make sure its options map has ::forms/validator"))
    (let [{:keys [invalid?]} (field-attrs component field-key validator)]
      (mui/text-field
        (merge {:key        (str field-key)
                :variant    "filled"
                :error      invalid?
                :helperText (if invalid? validation-message "")
                :label      label
                :onBlur     (fn [e]
                              (when (not= (.-value (.-target e)) "")
                                (complete-field component field-key)))
                :onChange   (if last-input
                              (fn [e]
                                (m/set-string! component field-key :event e)
                                (complete-field component field-key))
                              (fn [e]
                                (m/set-string! component field-key :event e)))
                :value      (field-key (c/props component))}
               (dissoc input-attrs :last-input))))))

(defn checkbox-input-with-label
  "Checkbox based on mui/checkbox for use with forms. Note: onChange completes the field by default."
  [component field-key label input-attrs]
  (mui/form-control-label
    {:key     (str field-key)
     :label   label
     :checked (field-key (c/props component))
     :control (mui/checkbox
                (merge {:onChange (fn [e]
                                    (m/set-value! component field-key (.-checked (.-target e)))
                                    (complete-field component field-key))}
                       input-attrs))}))

(def delete-button (mui/styled-button {#_#_:background-color "rgb(220, 0, 78)"}))
(defn form-buttons
  [{:keys [component validator props busy? submit-text reset-text on-reset delete-text on-delete
           submit-disabled reset-disabled]}]
  (let [using-busy?-and-busy? (and (not (nil? busy?)) busy?)
        on-reset (or on-reset (fn []
                                (c/transact! component [(fs/clear-complete! {})])
                                (c/transact! component [(fs/reset-form! {})])))]
    (mui/horizontal-grid
      (mui/button
        {:type      "submit"
         :size      "large"
         :disabled  (if-not (nil? submit-disabled)
                      submit-disabled
                      (not (and (fs/dirty? props)
                                (fs/checked? props)
                                (= :valid (validator props))
                                (not using-busy?-and-busy?))))
         :color     "primary"
         :variant   "contained"
         :startIcon (muic/save)}
        (or submit-text "Submit"))
      (mui/button
        {:size      "large"
         :disabled  (if-not (nil? reset-disabled)
                      reset-disabled
                      (not (and (fs/dirty? props)
                                (not using-busy?-and-busy?))))
         :variant   "outlined"
         :onClick   on-reset
         :startIcon (muic/restore)}
        (or reset-text "Reset"))
      (when on-delete
        (delete-button
          {:size      "large"
           :disabled  using-busy?-and-busy?
           :variant   "outlined"
           :onClick   on-delete
           :startIcon (muic/delete)}
          (or delete-text "Delete"))))))


;; form machine ----------------------------------------------------------------------------------

(defn mark-filled-fields-complete*
  "Helper function against app state. This function marks `initialized-keys` as complete on the form given a set of
  keys that you consider initialized. Like form state's mark-complete, but on a set instead of a single field.
  A field is considered filled if it's non-nil and it's not the empty string"
  [state-map {:keys [entity-ident initialized-keys]}]
  (let [mark-complete* (fn [entity {::fs/keys [fields complete?] :as form-config}]
                         (let [to-mark (set/union (set complete?) (set/intersection (set fields) (set initialized-keys)))
                               to-mark (into #{}
                                             (filter (fn [k] (and (not (nil? (get entity k)))
                                                                  (not (and (string? (get entity k))
                                                                            (= 0 (count (get entity k))))))))
                                             to-mark)]
                           [entity (assoc form-config ::fs/complete? to-mark)]))]
    (fs/update-forms state-map mark-complete* entity-ident)))

(def global-events
  {:event/exit {::uism/handler (fn [env]
                                 (log/debug "edit form: exiting")
                                 (uism/exit env))}})

;; A state machine for editing some entity with an ident. This machine makes the following assumptions:
;; - if saving is being used:
;;   - ::save-mutation is present on the form component's options
;;   - ::save-message is present optionally present the form component's options
;;   - ::save-extra-props is optionally present identifying keys in the components props to be sent to the server
;; - if deletion is being used:
;;   - ::delete-mutation is present on the form component's options
;;   - ::delete-message is optionally present on the form component's options
;; - the component will query for `:ui/busy?` and use it to lock inputs when true
;; - no recursive forms! (not sure what would happen)
;; - no edges (also not sure what would happen)
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
             form-ident (uism/actor->ident env :actor/form)
             {:keys [form-fields]} (c/component-options FormClass)]
         (log/info "edit form: initialized")
         (-> env
             (uism/load-actor :actor/form {::uism/ok-event    :event/load-ok
                                           ::uism/error-event :event/load-error})
             (uism/assoc-aliased :busy? true)
             (uism/activate :state/loading))))}

    :state/loading
    {::uism/events
     {:event/load-ok
      {::uism/handler
       (fn [env]
         (let [FormClass (uism/actor-class env :actor/form)
               form-ident (uism/actor->ident env :actor/form)
               {:keys [form-fields]} (c/component-options FormClass)]
           (log/info "edit form: loaded " FormClass form-ident)
           (-> env
               (uism/apply-action fs/add-form-config* FormClass form-ident {:destructive? true})
               (uism/apply-action fs/entity->pristine* form-ident)
               (uism/apply-action mark-filled-fields-complete* {:entity-ident     form-ident
                                                                :initialized-keys form-fields})
               ;(uism/apply-action fs/mark-complete* form-ident)
               (uism/assoc-aliased :busy? false)
               (uism/activate :state/editing))))}
      :event/load-error
      {::uism/handler
       (fn [env]
         (let [FormClass (uism/actor-class env :actor/form)
               form-ident (uism/actor->ident env :actor/form)
               {:keys [form-fields]} (c/component-options FormClass)]
           (log/error "edit form: load error, exiting")
           (js/alert "An error has occurred. Please refresh your tab and try again.")
           (-> env
               (uism/assoc-aliased :busy? false)
               (uism/exit))))}}}

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
                      delta (fs/dirty-fields props true)
                      extra-props-list (-> FormClass c/component-options ::save-extra-props)
                      extra-props (select-keys props extra-props-list)]
                  (if-not save-mutation
                    (log/info (str "Class " FormClass " must have a 'glam.client.common.forms/save-mutation"))
                    (-> env
                        (uism/assoc-aliased :busy? true)
                        (uism/activate :state/saving)
                        (uism/trigger-remote-mutation
                          :actor/form
                          save-mutation
                          (merge
                            {::uism/ok-event    :event/save-ok
                             ::uism/error-event :event/save-error
                             :ident             form-ident
                             :delta             (get delta form-ident)}
                            extra-props))))))}
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
                      (uism/apply-action env fs/pristine->entity* form-ident)))))}
             :event/delete
             {::uism/handler
              (fn [env]
                (let [proceed (js/confirm "Really delete?")
                      FormClass (uism/actor-class env :actor/form)
                      form-ident (uism/actor->ident env :actor/form)
                      delete-mutation (-> FormClass c/component-options ::delete-mutation)]
                  (cond
                    (not delete-mutation)
                    (log/error (str "Class " FormClass " must have a 'glam.client.common.forms/delete-mutation"))

                    proceed
                    (-> env
                        (uism/assoc-aliased :busy? true)
                        (uism/activate :state/deleting)
                        (uism/trigger-remote-mutation :actor/form delete-mutation
                                                      {::uism/ok-event    :event/delete-ok
                                                       ::uism/error-event :event/delete-error
                                                       :ident             form-ident})))))}})}

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
             (c/transact! SPA [(fs/reset-form! {:form-ident (::uism/source-actor-ident env)})])
             (snack/message! {:message  (if message message "Error occurred, save has failed.")
                              :severity "error"})
             (-> env
                 (uism/assoc-aliased :busy? false)
                 (uism/activate :state/editing))))}})}

    :state/deleting
    {::uism/events
     (merge
       global-events
       {:event/delete-ok
        {::uism/handler
         (fn [env]
           (let [FormClass (uism/actor-class env :actor/form)
                 form-ident (uism/actor->ident env :actor/form)
                 message (or (-> FormClass c/component-options ::delete-message) "Deleted")]
             ;; update pristine state and go to :state/editing
             (log/info "edit form: delete ok")
             (snack/message! {:message message :severity "success"})
             (-> env
                 (uism/apply-action fns/remove-entity form-ident)
                 (uism/exit))))}
        :event/delete-error
        {::uism/handler
         (fn [{::uism/keys [event-data] :as env}]
           (let [FormClass (uism/actor-class env :actor/form)
                 delete-mutation (-> FormClass c/component-options ::delete-mutation)
                 message (some-> event-data ::uism/mutation-result :body (get delete-mutation) :server/message)]
             (log/info "edit form: delete failed")
             (snack/message! {:message  (if message message "Error occurred, delete has failed.")
                              :severity "error"})
             (-> env
                 (uism/assoc-aliased :busy? false)
                 (uism/activate :state/editing))))}})}}})

(defmutation prepare-for-create
  "Set up the modal component and the join before letting the UISM take over"
  [{:keys [ident modal-join-key form-class]}]
  (action [{:keys [state ref]}]
          (swap! state (fn [s]
                         (-> s
                             (assoc-in ident (into (c/get-initial-state form-class) [ident]))
                             (assoc-in (conj ref modal-join-key) ident))))))

(uism/defstatemachine create-form-machine
  {::uism/actor-names
   #{:actor/form
     :actor/modal-host}

   ::uism/aliases
   {:busy?       [:actor/form :ui/busy?]
    :modal-open? [:actor/modal-host :ui/modal-open?]}

   ::uism/states
   {:initial
    ;; kickoff: add form config, mark fields complete, open modal if using, and begin editing
    {::uism/handler
     (fn [env]
       (let [FormClass (uism/actor-class env :actor/form)
             form-ident (uism/actor->ident env :actor/form)
             modal-ident (uism/actor->ident env :actor/modal-host)
             {:keys [form-fields]} (c/component-options FormClass)]
         (log/info "create form: initialized")
         (log/info (pr-str modal-ident))
         (-> env
             (uism/clear-timeout! ::exiting)
             (uism/apply-action fs/add-form-config* FormClass form-ident)
             (uism/apply-action mark-filled-fields-complete* {:entity-ident     form-ident
                                                              :initialized-keys form-fields})
             (cond->
               modal-ident
               (uism/assoc-aliased :modal-open? true))
             (uism/activate :state/editing))))}

    :state/editing
    ;; editing: we can (1) create the entity, (2) cancel
    {::uism/events
     {:event/create
      {::uism/handler
       (fn [{::uism/keys [state-map] :as env}]
         (log/info "edit form: handling create")
         (let [FormClass (uism/actor-class env :actor/form)
               form-ident (uism/actor->ident env :actor/form)
               modal-ident (uism/actor->ident env :actor/modal-host)
               create-mutation (-> FormClass c/component-options ::create-mutation)
               props (fns/ui->props state-map FormClass form-ident)
               delta (fs/dirty-fields props true)]
           (if-not create-mutation
             (log/error (str "Class " FormClass " must have a 'glam.client.common.forms/create-mutation"))
             (-> env
                 (uism/assoc-aliased :busy? true)
                 (uism/activate :state/creating)
                 (uism/trigger-remote-mutation
                   :actor/form
                   create-mutation
                   {::uism/ok-event    :event/create-ok
                    ::uism/error-event :event/create-error
                    :ident             form-ident
                    :parent-ident      modal-ident
                    :parent-id         (second modal-ident)
                    :delta             (get delta form-ident)})))))}
      :event/cancel
      {::uism/handler
       (fn [env]
         (let [form-ident (uism/actor->ident env :actor/form)
               modal-ident (uism/actor->ident env :actor/modal-host)]
           (log/info "Creation canceled")
           (-> env
               (cond->
                 modal-ident
                 (uism/assoc-aliased :modal-open? false))
               (uism/set-timeout ::exiting :event/exiting {} 200))))}
      :event/exiting
      {::uism/handler
       (fn [env]
         (let [form-ident (uism/actor->ident env :actor/form)]
           (-> env
               (uism/apply-action fns/remove-entity form-ident)
               (uism/exit))))}}}

    :state/creating
    {::uism/events
     (merge
       global-events
       {:event/create-ok
        {::uism/handler
         (fn [env]
           (let [FormClass (uism/actor-class env :actor/form)
                 form-ident (uism/actor->ident env :actor/form)
                 modal-ident (uism/actor->ident env :actor/modal-host)
                 message (or (-> FormClass c/component-options ::create-message) "Created")
                 target-list (conj modal-ident (-> FormClass c/component-options ::create-append-to))]
             (log/info "create ok")
             (log/info (str "ident: " (pr-str form-ident)))
             (log/info (str "target list: " (pr-str target-list)))
             (snack/message! {:message message :severity "success"})
             (-> env
                 (cond->
                   modal-ident
                   (uism/assoc-aliased :modal-open? false))
                 (uism/apply-action fs/entity->pristine* form-ident)
                 (uism/assoc-aliased :busy? false)
                 (uism/apply-action update-in target-list conj form-ident)
                 ;; Ensure it's a vector of idents--if it was previously empty, it will be a list
                 (uism/apply-action update-in target-list vec)
                 (uism/exit))))}
        :event/create-error
        {::uism/handler
         (fn [{::uism/keys [event-data] :as env}]
           (let [FormClass (uism/actor-class env :actor/form)
                 create-mutation (-> FormClass c/component-options ::create-mutation)
                 message (some-> event-data ::uism/mutation-result :body (get create-mutation) :server/message)]
             (log/info "edit form: create failed")
             (snack/message! {:message  (if message message "Error occurred, create has failed.")
                              :severity "error"})
             (-> env
                 (uism/assoc-aliased :busy? false)
                 (uism/activate :state/editing))))}})}}})