(ns glam.client.ui.admin.project.settings
  "The UI for admin settings on a single project."
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
            [com.fulcrologic.fulcro.components :as comp]
            [com.fulcrologic.fulcro.algorithms.tempid :as tempid]
            [com.fulcrologic.fulcro.ui-state-machines :as uism]
            [com.fulcrologic.fulcro.mutations :as m]
            [glam.client.router :as r]
            [glam.models.project :as prj]
            [glam.models.text-layer :as txtl]
            [glam.models.token-layer :as tokl]
            [glam.models.span-layer :as sl]
            [glam.client.ui.material-ui :as mui]
            [glam.client.ui.global-snackbar :as snack]
            [glam.client.ui.material-ui-icon :as muic]
            [glam.client.ui.common.core :as uic]
            [glam.client.util :as gcu]
            [glam.client.ui.common.forms :as forms]
            [com.fulcrologic.fulcro.algorithms.normalized-state :as fns]))
;; Mutations --------------------------------------------------------------------------------------------
;; ======================================================================================================
(m/defmutation shift-span-layer
  [{:keys [id up? load-fn]}]
  (action [{:keys [state ref]}]
          (swap! state (fn [s]
                         (-> s
                             (assoc-in (conj ref :ui/busy?) true)))))
  (remote [{:keys [ast]}]
          (log/info ast)
          (let [ast (-> ast
                        (assoc :key `sl/shift-span-layer)
                        (update :params dissoc :load-fn))]
            ast))
  (result-action [{:keys [state ref app component] :as env}]
                 (swap! state (fn [s] (assoc-in s (conj ref :ui/busy?) false)))
                 (let [{:server/keys [message error?]} (get-in env [:result :body `sl/shift-span-layer])]
                   (when message
                     (if error?
                       (snack/message! {:message  message
                                        :severity (if error? "error" "success")}))))
                 (load-fn app)))

;; Side panel components --------------------------------------------------------------------------------
;; ======================================================================================================
(declare SpanLayerForm)
(defsc SpanLayerListItem
  [this {:span-layer/keys [id name]} {:keys [set-active-layer]}]
  {:query [:span-layer/name :span-layer/id]
   :ident :span-layer/id}
  (mui/tree-item {:label   name
                  :nodeId  (str id)
                  :icon    (muic/settings-ethernet)
                  :onClick (fn []
                             (set-active-layer [:span-layer/id id])
                             (uism/begin! this forms/edit-form-machine ::edit-span-layer
                                          {:actor/form (uism/with-actor-class [:span-layer/id id] SpanLayerForm)}))}))

(def ui-span-layer-list-item (comp/computed-factory SpanLayerListItem {:keyfn :span-layer/id}))

(declare TokenLayerForm)
(defsc TokenLayerListItem
  [this {:token-layer/keys [id name span-layers]} {:keys [set-active-layer]}]
  {:query [:token-layer/id :token-layer/name
           {:token-layer/span-layers (comp/get-query SpanLayerListItem)}]
   :ident :token-layer/id}
  (mui/tree-item {:label   name
                  :nodeId  (str id)
                  :icon    (muic/more-horiz)
                  :onClick (fn []
                             (set-active-layer [:token-layer/id id])
                             (uism/begin! this forms/edit-form-machine ::edit-token-layer
                                          {:actor/form (uism/with-actor-class [:token-layer/id id] TokenLayerForm)}))}
    (when span-layers
      (doall
        (map ui-span-layer-list-item
             (map #(comp/computed % {:set-active-layer set-active-layer}) span-layers))))))

(def ui-token-layer-list-item (comp/computed-factory TokenLayerListItem {:keyfn :token-layer/id}))

(declare TextLayerForm)
(defsc TextLayerListItem
  [this {:text-layer/keys [id name token-layers]} {:keys [set-active-layer]}]
  {:query [:text-layer/id :text-layer/name {:text-layer/token-layers (comp/get-query TokenLayerListItem)}]
   :ident :text-layer/id}
  (mui/tree-item {:label   name
                  :nodeId  (str id)
                  :icon    (muic/description-outlined)
                  :onClick (fn []
                             (set-active-layer [:text-layer/id id])
                             (uism/begin! this forms/edit-form-machine ::edit-text-layer
                                          {:actor/form (uism/with-actor-class [:text-layer/id id] TextLayerForm)}))}
    (when token-layers
      (doall
        (map ui-token-layer-list-item
             (map #(comp/computed % {:set-active-layer set-active-layer}) token-layers))))))

(def ui-text-layer-list-item (comp/computed-factory TextLayerListItem {:keyfn :text-layer/id}))

;; Modals for creating layers ---------------------------------------------------------------------------
;; ======================================================================================================
(defsc AddSpanLayer [this {:span-layer/keys [id] :ui/keys [busy?] :as props}]
  {:ident                   :span-layer/id
   :query                   [fs/form-config-join :span-layer/id :span-layer/name :ui/busy?]
   :initial-state           {:ui/busy? false :span-layer/name ""}
   :form-fields             #{:span-layer/name}
   ::forms/validator        sl/validator
   ::forms/create-mutation  'glam.models.span-layer/create-span-layer
   ::forms/create-message   "Span layer added"
   ::forms/create-append-to :token-layer/span-layers}
  (let [close-ctl-dialog (fn []
                           (uism/trigger! this ::add-span-layer :event/cancel))]
    (dom/form
      {:onSubmit (fn [e]
                   (.preventDefault e)
                   (uism/trigger! this ::add-span-layer :event/create))}
      (mui/box {:m 1 :p 1}
        (mui/vertical-grid
          (forms/text-input-with-label this :span-layer/name "Name" "Must have 1 to 80 characters"
            {:fullWidth  true
             :disabled   busy?
             :autoFocus  true
             :last-input true}))
        (mui/horizontal-grid
          (mui/button
            {:type      "submit"
             :size      "large"
             :color     "primary"
             :variant   "contained"
             :startIcon (muic/create)
             :disabled  (not (and (fs/dirty? props)
                                  (fs/checked? props)
                                  (= :valid (sl/validator props))
                                  (not busy?)))}
            "Create Span Layer")
          (mui/button
            {:size      "large"
             :variant   "outlined"
             :onClick   close-ctl-dialog
             :startIcon (muic/cancel)}
            "Cancel"))))))

(def ui-add-span-layer (c/factory AddSpanLayer))

(defsc AddTokenLayer [this {:token-layer/keys [id] :ui/keys [busy?] :as props}]
  {:ident                   :token-layer/id
   :query                   [fs/form-config-join :token-layer/id :token-layer/name :ui/busy?]
   :initial-state           {:ui/busy? false :token-layer/name ""}
   :form-fields             #{:token-layer/name}
   ::forms/validator        tokl/validator
   ::forms/create-mutation  'glam.models.token-layer/create-token-layer
   ::forms/create-message   "Token layer added"
   ::forms/create-append-to :text-layer/token-layers}
  (let [close-ctl-dialog (fn []
                           (uism/trigger! this ::add-token-layer :event/cancel))]
    (dom/form
      {:onSubmit (fn [e]
                   (.preventDefault e)
                   (uism/trigger! this ::add-token-layer :event/create))}
      (mui/box {:m 1 :p 1}
        (mui/vertical-grid
          (forms/text-input-with-label this :token-layer/name "Name" "Must have 1 to 80 characters"
            {:fullWidth  true
             :disabled   busy?
             :autoFocus  true
             :last-input true}))
        (mui/horizontal-grid
          (mui/button
            {:type      "submit"
             :size      "large"
             :color     "primary"
             :variant   "contained"
             :startIcon (muic/create)
             :disabled  (not (and (fs/dirty? props)
                                  (fs/checked? props)
                                  (= :valid (tokl/validator props))
                                  (not busy?)))}
            "Create Token Layer")
          (mui/button
            {:size      "large"
             :variant   "outlined"
             :onClick   close-ctl-dialog
             :startIcon (muic/cancel)}
            "Cancel"))))))

(def ui-add-token-layer (c/factory AddTokenLayer))

(defsc AddTextLayer [this {:text-layer/keys [id] :ui/keys [busy?] :as props}]
  {:ident                   :text-layer/id
   :query                   [fs/form-config-join :text-layer/id :text-layer/name :ui/busy?]
   :initial-state           {:ui/busy? false :text-layer/name ""}
   :form-fields             #{:text-layer/name}
   ::forms/validator        txtl/validator
   ::forms/create-mutation  'glam.models.text-layer/create-text-layer
   ::forms/create-message   "Text layer added"
   ::forms/create-append-to :project/text-layers}
  (let [close-ctl-dialog (fn []
                           (uism/trigger! this ::add-text-layer :event/cancel))]
    (dom/form
      {:onSubmit (fn [e]
                   (.preventDefault e)
                   (uism/trigger! this ::add-text-layer :event/create))}
      (mui/box {:m 1 :p 1}
        (mui/vertical-grid
          (forms/text-input-with-label this :text-layer/name "Name" "Must have 1 to 80 characters"
            {:fullWidth  true
             :disabled   busy?
             :autoFocus  true
             :last-input true}))
        (mui/horizontal-grid
          (mui/button
            {:type      "submit"
             :size      "large"
             :color     "primary"
             :variant   "contained"
             :startIcon (muic/create)
             :disabled  (not (and (fs/dirty? props)
                                  (fs/checked? props)
                                  (= :valid (txtl/validator props))
                                  (not busy?)))}
            "Create Text Layer")
          (mui/button
            {:size      "large"
             :variant   "outlined"
             :onClick   close-ctl-dialog
             :startIcon (muic/cancel)}
            "Cancel"))))))

(def ui-add-text-layer (c/factory AddTextLayer))

;; Main panel components --------------------------------------------------------------------------------
;; ======================================================================================================
(defn exit-layer-uism
  "Triggered when a new panel is activated--we need to use this function to close the current UISM.
  It's a little complicated, because we need to get a ref to the component that needs to be closed, which
  we don't easily have from the perspective of the thing being clicked. To get around this, we find all
  components using the ident that needs to be closed, and "
  [this props]
  ;; See what the active layer is and note some information about it
  ;; TODO: not a lovely solution to use class name... anything better?
  (let [[id-kwd class-name asm-id] (cond
                                     (:text-layer/id props) [:text-layer/id "TextLayerForm" ::edit-text-layer]
                                     (:token-layer/id props) [:token-layer/id "TokenLayerForm" ::edit-token-layer]
                                     (:span-layer/id props) [:span-layer/id "SpanLayerForm" ::edit-span-layer]
                                     :else nil)]
    (if id-kwd
      (let [components (c/ident->components this [id-kwd (id-kwd props)])
            form-component (first (filter #(clojure.string/includes? (c/component-name %) class-name)
                                          components))]
        (log/info "Exiting uism: " id-kwd)
        (uism/trigger! form-component asm-id :event/reset)
        (uism/trigger! form-component asm-id :event/exit))
      (log/warn "Tried to exit a UISM, but didn't recognize the type. Props :" props))))

(defsc SpanLayerForm
  [this {:span-layer/keys [id name] :ui/keys [busy?] :as props} {:keys [load-fn]}]
  {:query                  [:span-layer/name :span-layer/id
                            fs/form-config-join :ui/busy?]
   :ident                  :span-layer/id
   :pre-merge              (fn [{:keys [data-tree] :as m}]
                             (merge {:ui/busy? false}
                                    data-tree))
   :form-fields            #{:span-layer/name}
   ::forms/validator       sl/validator
   ::forms/save-mutation   'glam.models.span-layer/save-span-layer
   ::forms/delete-mutation 'glam.models.span-layer/delete-span-layer
   ::forms/delete-message  "Span layer deleted"}
  (let [dirty (fs/dirty? props)]
    (dom/form
      {:onSubmit (fn [e]
                   (.preventDefault e)
                   (uism/trigger! this ::edit-span-layer :event/save)
                   (c/transact! this [(fs/clear-complete! {:entity-ident [:span-layer/id id]})]))}
      (mui/vertical-grid
        {:spacing 2}
        (mui/typography {:variant "h5"} "Span Layer: " name)
        (mui/horizontal-grid
          (mui/button
            {:variant   "outlined"
             :onClick   #(c/transact! this [(shift-span-layer {:id id :up? false :load-fn load-fn})])
             :startIcon (muic/arrow-upward)}
            "Shift up")
          (mui/button
            {:variant   "outlined"
             :onClick   #(c/transact! this [(shift-span-layer {:id id :up? true :load-fn load-fn})])
             :startIcon (muic/arrow-downward)}
            "Shift down"))
        (forms/text-input-with-label this :span-layer/name "Name" "Must have 1 to 80 characters"
          {:fullWidth true
           :disabled  busy?})
        (forms/form-buttons
          {:component       this
           :validator       sl/validator
           :props           props
           :busy?           busy?
           :submit-token    "Save Span Layer"
           :reset-token     "Discard Changes"
           :on-reset        (fn []
                              (uism/trigger! this ::edit-span-layer :event/reset)
                              (c/transact! this [(fs/clear-complete! {:entity-ident [:span-layer/id id]})]))
           :on-delete       #(uism/trigger! this ::edit-span-layer :event/delete)
           :submit-disabled (or (not dirty)
                                (not= :valid (sl/validator props))
                                (not (fs/checked? props))
                                busy?)
           :reset-disabled  (not (and dirty (not busy?)))})))))

(def ui-span-layer-form (comp/computed-factory SpanLayerForm))

(defsc TokenLayerForm
  [this {:token-layer/keys [id name] :ui/keys [busy? modal-open? add-span-layer] :as props}]
  {:query                  [:token-layer/id :token-layer/name fs/form-config-join :ui/busy? :ui/modal-open?
                            {:ui/add-span-layer (c/get-query AddSpanLayer)}]
   :ident                  :token-layer/id
   :pre-merge              (fn [{:keys [data-tree] :as m}]
                             (merge {:ui/modal-open? false
                                     :ui/busy?       false}
                                    data-tree))
   :form-fields            #{:token-layer/name}
   ::forms/validator       tokl/validator
   ::forms/save-mutation   'glam.models.token-layer/save-token-layer
   ::forms/delete-mutation 'glam.models.token-layer/delete-token-layer
   ::forms/delete-message  "Token layer deleted"}
  (let [dirty (fs/dirty? props)]
    (c/fragment
      (mui/dialog {:open (and (not busy?) modal-open?) :onClose #(uism/trigger! this ::add-span-layer :event/cancel)}
        (mui/dialog-title {} "Add Span Layer")
        (mui/dialog-content {}
          (when add-span-layer
            (ui-add-span-layer add-span-layer))))
      (dom/form
        {:onSubmit (fn [e]
                     (.preventDefault e)
                     (uism/trigger! this ::edit-token-layer :event/save)
                     (c/transact! this [(fs/clear-complete! {:entity-ident [:token-layer/id id]})]))}
        (mui/vertical-grid
          {:spacing 2}
          (mui/typography {:variant "h5"} "Token Layer: " name)
          (forms/text-input-with-label this :token-layer/name "Name" "Must have 1 to 80 characters"
            {:fullWidth true
             :disabled  busy?})
          (mui/button
            {:variant   "outlined"
             :color     "primary"
             :startIcon (muic/add)
             :style     {:marginTop "1em"}
             :onClick   (fn []
                          (let [tempid (tempid/tempid)]
                            (c/transact! this [(forms/prepare-for-create {:ident          [:span-layer/id tempid]
                                                                          :modal-join-key :ui/add-span-layer
                                                                          :form-class     AddSpanLayer})])
                            (uism/begin! this forms/create-form-machine ::add-span-layer
                                         {:actor/form       (uism/with-actor-class [:span-layer/id tempid] AddSpanLayer)
                                          :actor/modal-host (uism/with-actor-class [:token-layer/id id] TokenLayerForm)})))}
            "Add Span Layer")
          (forms/form-buttons
            {:component       this
             :validator       tokl/validator
             :props           props
             :busy?           busy?
             :submit-token    "Save Span Layer"
             :reset-token     "Discard Changes"
             :on-reset        (fn []
                                (uism/trigger! this ::edit-token-layer :event/reset)
                                (c/transact! this [(fs/clear-complete! {:entity-ident [:token-layer/id id]})]))
             :on-delete       #(uism/trigger! this ::edit-token-layer :event/delete)
             :submit-disabled (or (not dirty)
                                  (not= :valid (tokl/validator props))
                                  (not (fs/checked? props))
                                  busy?)
             :reset-disabled  (not (and dirty (not busy?)))}))))))

(def ui-token-layer-form (comp/factory TokenLayerForm))

(defsc TextLayerForm
  [this {:text-layer/keys [id name] :ui/keys [busy? modal-open? add-token-layer] :as props}]
  {:query                  [:text-layer/id :text-layer/name fs/form-config-join :ui/busy? :ui/modal-open?
                            {:ui/add-token-layer (c/get-query AddTokenLayer)}]
   :pre-merge              (fn [{:keys [data-tree] :as m}]
                             (merge {:ui/modal-open? false
                                     :ui/busy?       false}
                                    data-tree))
   :ident                  :text-layer/id
   :form-fields            #{:text-layer/name}
   ::forms/validator       txtl/validator
   ::forms/save-mutation   'glam.models.text-layer/save-text-layer
   ::forms/delete-mutation 'glam.models.text-layer/delete-text-layer
   ::forms/delete-message  "Text layer deleted"}
  (let [dirty (fs/dirty? props)]
    (c/fragment
      ;; TODO: modal-open? is nil for a bit until pre-merge runs. Won't cause issues for now, but it is annoying.
      (mui/dialog {:open (and (not busy?) modal-open?) :onClose #(uism/trigger! this ::add-token-layer :event/cancel)}
        (mui/dialog-title {} "Add Token Layer")
        (mui/dialog-content {}
          (when add-token-layer
            (ui-add-token-layer add-token-layer))))
      (dom/form
        {:onSubmit (fn [e]
                     (.preventDefault e)
                     (uism/trigger! this ::edit-text-layer :event/save)
                     (c/transact! this [(fs/clear-complete! {:entity-ident [:text-layer/id id]})]))}
        (mui/vertical-grid
          {:spacing 2}
          (mui/typography {:variant "h5"} "Text Layer: " name)
          (forms/text-input-with-label this :text-layer/name "Name" "Must have 1 to 80 characters"
            {:fullWidth true
             :disabled  busy?})
          (mui/button
            {:variant   "outlined"
             :color     "primary"
             :startIcon (muic/add)
             :style     {:marginTop "1em"}
             :onClick   (fn []
                          (let [tempid (tempid/tempid)]
                            (c/transact! this [(forms/prepare-for-create {:ident          [:token-layer/id tempid]
                                                                          :modal-join-key :ui/add-token-layer
                                                                          :form-class     AddTokenLayer})])
                            (uism/begin! this forms/create-form-machine ::add-token-layer
                                         {:actor/form       (uism/with-actor-class [:token-layer/id tempid] AddTokenLayer)
                                          :actor/modal-host (uism/with-actor-class [:text-layer/id id] TextLayerForm)})))}
            "Add Token Layer")
          (forms/form-buttons
            {:component       this
             :validator       txtl/validator
             :props           props
             :busy?           busy?
             :submit-text     "Save Text Layer"
             :reset-text      "Discard Changes"
             :on-reset        (fn []
                                (uism/trigger! this ::edit-text-layer :event/reset)
                                (c/transact! this [(fs/clear-complete! {:entity-ident [:text-layer/id id]})]))
             :on-delete       #(uism/trigger! this ::edit-text-layer :event/delete)
             :submit-disabled (or (not dirty)
                                  (not= :valid (txtl/validator props))
                                  (not (fs/checked? props))
                                  busy?)
             :reset-disabled  (not (and dirty (not busy?)))}))))))

(def ui-text-layer-form (comp/factory TextLayerForm))

;; We need a union to account for the fact that we have one location that will have entities of
;; potentially many types.
(defsc LayerUnion [this props {:keys [load-fn]}]
  {:ident (fn []
            (cond
              (:text-layer/id props) [:text-layer/id (:text-layer/id props)]
              (:token-layer/id props) [:token-layer/id (:token-layer/id props)]
              (:span-layer/id props) [:span-layer/id (:span-layer/id props)]
              :else (do
                      (if (or (nil? props)
                              (and (map? props)
                                   (not (some #(= (name %) "id") (keys props)))))
                        (log/warn "No layer selected")
                        (log/error "Unrecognized layer type!" props))
                      [:component/id ::no-layer])))
   :query (fn [] {:text-layer/id  (comp/get-query TextLayerForm)
                  :token-layer/id (comp/get-query TokenLayerForm)
                  :span-layer/id  (comp/get-query SpanLayerForm)})}
  (cond
    (:text-layer/id props) (ui-text-layer-form props)
    (:token-layer/id props) (ui-token-layer-form props)
    (:span-layer/id props) (ui-span-layer-form props {:load-fn load-fn})
    (or (nil? props)
        (and (map? props)
             (not (some #(= (name %) "id") props)))) (mui/typography
                                                       {:variant   "subtitle1"
                                                        :component "h3"}
                                                       "Select a layer")
    :else (dom/div "Unknown layer type!")))

(def ui-layer-union (comp/computed-factory LayerUnion))

;; User permissions -----------------------------------------------------------------------------------
;; ====================================================================================================
(defsc UserPermissionListItem [this
                               {:user/keys [id name email privileges] :ui/keys [busy?] :as props}
                               {project-id :project/id}]
  {:query     [:user/id :user/name :user/email :user/privileges :ui/busy?]
   :ident     :user/id
   :pre-merge (fn [{:keys [data-tree]}]
                (merge {:ui/busy?            false
                        :original-privileges (:user/privileges data-tree)}
                       data-tree))}
  (let [on-result (fn [{:server/keys [error? message]}]
                    (m/set-value! this :ui/busy? false)
                    (when error?
                      (snack/message! {:severity "error" :message message})
                      (m/set-value! this :user/privileges (:original-privileges props))))
        on-change (fn [e]
                    (let [v (.-value (.-target e))]
                      (log/info "event" e)
                      (log/info "value" v)
                      (m/set-value! this :busy? true)
                      (m/set-value! this :user/privileges v)
                      (c/transact! this
                                   [(prj/set-user-privileges
                                      {:project/id      project-id
                                       :user/id         id
                                       :user/privileges v})]
                                   {:on-result on-result})))]
    (mui/list-item {}
      (mui/list-item-text {:primary name :secondary email})
      (mui/list-item-secondary-action
        {}
        (mui/minw-100-select
          {:variant  "filled"
           :value    privileges
           :disabled busy?
           :onChange on-change}
          (mui/menu-item {:value "none"} "None")
          (mui/menu-item {:value "reader"} "Reader")
          (mui/menu-item {:value "writer"} "Writer"))))))

(def ui-user-permission-list-item (c/computed-factory UserPermissionListItem {:keyfn :user/id}))

;; Interface configuration ----------------------------------------------------------------------------
;; ====================================================================================================
(declare ProjectSettings)
(defmutation set-interlinear-span-layer-scope
  [_]
  (action [{:keys [state ref]}]
          (swap! state (fn [s]
                         (-> s
                             (assoc-in (conj ref :ui/busy?) true)))))
  (remote [{:keys [ast]}]
          (let [ast (assoc ast :key `prj/set-interlinear-span-layer-scope)]
            ast))
  (result-action [{:keys [state ref app component] :as env}]
                 (swap! state (fn [s] (assoc-in s (conj ref :ui/busy?) false)))
                 (let [{:server/keys [message error?]} (get-in env [:result :body `prj/set-interlinear-span-layer-scope])]
                   (when message
                     (if error?
                       (snack/message! {:message  message
                                        :severity (if error? "error" "success")})
                       )))
                 (df/load! app ref ProjectSettings)))
(defsc SpanLayerQuery [this props]
  {:ident :span-layer/id
   :query [:span-layer/id :span-layer/name]})
(defsc TokenLayerQuery [this props]
  {:ident :token-layer/id
   :query [:token-layer/id :token-layer/name {:token-layer/span-layers (c/get-query SpanLayerQuery)}]})
(defsc TextLayerQuery [this props]
  {:ident :text-layer/id
   :query [:text-layer/id :text-layer/name
           {:text-layer/token-layers (c/get-query TokenLayerQuery)}]})
(defsc InterfaceConfiguration [this {:project/keys [id config text-layers] :ui/keys [busy?] :as props}]
  {:ident     :project/id
   :pre-merge (fn [{:keys [data-tree]}]
                (merge {:ui/busy? false}
                       data-tree))
   :query     [:project/id :project/config {:project/text-layers (c/get-query TextLayerQuery)}
               :ui/busy?]}
  (let [span-layers (flatten (for [text-layer text-layers]
                               (for [token-layer (:text-layer/token-layers text-layer)]
                                 (:token-layer/span-layers token-layer))))]
    (log/info (get-in config [:editors :interlinear]))
    (dom/div
      (mui/typography {:variant "h5"} "Interlinear Interface")
      (dom/p "Select the span layers that represent sentence-level information (e.g. a free translation)
              instead of token-level information (like a gloss).")
      (dom/p (dom/strong "Warning: ") "changing the layer's type will result in all existing spans "
             "on that layer being deleted.")
      (mui/list {}
        (mapv (fn [{:span-layer/keys [id name]}]
                (let [scope (get-in config [:editors :interlinear :span-layer-scopes id] "unused")]
                  (js/console.log scope)
                  (mui/list-item {:key (str id) :style {:marginBottom "1em"}}
                    (mui/list-item-text {:primary name})
                    (mui/list-item-secondary-action
                      {}
                      (mui/minw-100-select
                        {:variant  "filled"
                         :value    scope
                         :disabled busy?
                         :onChange (fn [e]
                                     (let [v (.-value (.-target e))]
                                       (c/transact! this [(set-interlinear-span-layer-scope
                                                            {:span-layer/id id
                                                             :scope         (if (= "unused" v) nil (keyword v))})])))}
                        (mui/menu-item {:value "unused"} "Not used")
                        (mui/menu-item {:value "token"} "Token")
                        (mui/menu-item {:value "sentence"} "Sentence"))))))
              span-layers)))))

(def ui-interface-configuration (c/factory InterfaceConfiguration))

;; Top-level components -------------------------------------------------------------------------------
;; ====================================================================================================
(defn- all-ids
  "Helper function: we want all items to be expanded by default in the tree-view, and to do this we need to
  hand the tree-view all the IDs of our nodes."
  [{txtid :text-layer/id
    tokid :token-layer/id
    slid  :span-layer/id :as props}]
  (cond (some? txtid) (conj (flatten (map all-ids (:text-layer/token-layers props))) (str txtid))
        (some? tokid) (conj (flatten (map all-ids (:token-layer/span-layers props))) (str tokid))
        (some? slid) [(str slid)]
        (nil? props) (log/warn "No layer selected")
        :else (do (log/error "Unknown layer type!" props) [])))

(defsc ProjectSettings [this {:project/keys [id name text-layers users]
                              :ui/keys      [active-tab add-text-layer modal-open? active-layer] :as props
                              :>/keys       [interfaces]}]
  {:query         [:project/id
                   :project/name
                   {:project/users (c/get-query UserPermissionListItem)}
                   {:project/text-layers (c/get-query TextLayerListItem)}
                   {:ui/active-layer (c/get-query LayerUnion)}
                   {:ui/add-text-layer (c/get-query AddTextLayer)}
                   {:>/interfaces (c/get-query InterfaceConfiguration)}
                   :ui/active-tab
                   :ui/modal-open?]
   :ident         :project/id
   :initial-state {}
   :pre-merge     (fn [{:keys [data-tree current-normalized] :as m}]
                    ;; initial-state doesn't work for some reason
                    (merge {:ui/active-tab  "layers"
                            :ui/modal-open? false}
                           current-normalized
                           data-tree))
   :route-segment (r/last-route-segment :project-settings)
   :will-enter    (fn [app {:keys [id]}]
                    (let [parsed-id (gcu/parse-id id)]
                      (dr/route-deferred
                        [:project/id parsed-id]
                        #(df/load! app [:project/id parsed-id] ProjectSettings
                                   {:post-mutation        `dr/target-ready
                                    :post-mutation-params {:target [:project/id parsed-id]}}))))}
  (let [set-active-layer (fn set-active-layer [ident]
                           (when active-layer
                             (exit-layer-uism this active-layer))
                           (m/set-value! this :ui/active-layer ident))
        load-fn #(df/load! % [:project/id id] ProjectSettings)]
    (mui/container {:maxWidth "lg" :style {:position "relative"}}
      (mui/page-title name)
      (mui/arrow-breadcrumbs {}
        (mui/link {:variant "subtitle1" :color "inherit" :href (r/route-for :admin-home) :key "admin"} "Admin Settings")
        (mui/link {:variant "subtitle1" :color "inherit" :href (r/route-for :project-overview) :key "project"} "Project Management")
        (mui/link {:variant "subtitle1" :color "textPrimary" :underline "none" :key id} name))

      ;; add text layer modal
      (mui/dialog {:open    modal-open?
                   :onClose (fn []
                              (uism/trigger! this ::add-text-layer :event/cancel))}
        (mui/dialog-title {} "Add Text Layer")
        (mui/dialog-content {}
          (when add-text-layer
            (ui-add-text-layer add-text-layer))))

      ;; Tab 1: layer configuration
      (mui/tab-context {:value active-tab}
        (mui/tabs {:value    active-tab
                   :onChange (fn [_ tab]
                               (df/load! this [:project/id id] ProjectSettings)
                               (m/set-value! this :ui/active-tab tab))}
          (mui/tab {:label "Layers" :value "layers"})
          (mui/tab {:label "Access" :value "access"})
          (mui/tab {:label "Interfaces" :value "interfaces"}))

        (mui/tab-panel {:value "layers"}
          (mui/grid {:container true :spacing 1}
            ;; Layer list
            (mui/grid {:item true :xs 12 :md 3}
              (mui/padded-paper {}
                (comp/fragment
                  (if (empty? text-layers)
                    (mui/zero-state "No layers configured.")
                    (mui/tree-view {:expanded (reduce into [] (map all-ids text-layers))}
                      (mapv ui-text-layer-list-item
                            (map #(comp/computed % {:set-active-layer set-active-layer}) text-layers))))
                  (mui/button
                    {:variant   "outlined"
                     :color     "primary"
                     :startIcon (muic/add)
                     :style     {:marginTop "1em"}
                     :onClick   (fn []
                                  (let [tempid (tempid/tempid)]
                                    (c/transact! this [(forms/prepare-for-create {:ident          [:text-layer/id tempid]
                                                                                  :modal-join-key :ui/add-text-layer
                                                                                  :form-class     AddTextLayer})])
                                    (uism/begin! this forms/create-form-machine ::add-text-layer
                                                 {:actor/form       (uism/with-actor-class [:text-layer/id tempid] AddTextLayer)
                                                  :actor/modal-host (uism/with-actor-class [:project/id id] ProjectSettings)})))}
                    "Add Text Layer"))))
            ;; Layer configuration
            (mui/grid {:item true :xs 12 :md 9}
              (mui/padded-paper {}
                (if (empty? text-layers)
                  (mui/zero-state "No layers configured.")
                  (ui-layer-union (:ui/active-layer props) {:load-fn load-fn}))))))

        ;; Tab 2: user permissions
        (mui/tab-panel {:value "access"}
          (mui/container {:maxWidth "sm"}
            (mui/padded-paper
              (when users
                (mui/list
                  {:subheading "Project Access Privileges"}
                  (mapv ui-user-permission-list-item
                        (map #(c/computed % {:project/id id}) users)))))))

        (mui/tab-panel {:value "interfaces"}
          (mui/container {:maxWidth "sm"}
            (mui/padded-paper
              (ui-interface-configuration interfaces))))))))
