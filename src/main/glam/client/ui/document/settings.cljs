(ns glam.client.ui.document.settings
  (:require [goog.object :as gobj]
            [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.mutations :as m]
            [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.mutations :as m]
            [glam.client.router :as r]
            [taoensso.timbre :as log]
            [glam.models.document :as doc]
            [glam.client.ui.material-ui :as mui]
            [glam.client.ui.common.forms :as forms]
            [glam.client.ui.document.token-editor :refer [Token ui-token]]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [com.fulcrologic.fulcro.ui-state-machines :as uism]))

(defsc ProjectQuery [this _]
  {:query [:project/id :project/name]
   :ident :project/id})

(defsc Settings [this {:document/keys [id name project] :ui/keys [busy?] :as props}]
  {:query                  [:document/id :document/name fs/form-config-join :ui/busy?
                            {:document/project (c/get-query ProjectQuery)}]
   :ident                  :document/id
   :pre-merge              (fn [{:keys [data-tree]}]
                             (merge {:ui/busy? false}
                                    data-tree))
   ::forms/validator       doc/validator
   ::forms/save-mutation   'glam.models.document/save-document
   ::forms/delete-mutation 'glam.models.document/delete-document
   ::forms/delete-message  "Document deleted"
   :form-fields            #{:document/name}}
  (let [dirty (fs/dirty? props)]
    (log/info props)
    (mui/container {:maxWidth "md"}
      (dom/form
        {:onSubmit (fn [e]
                     (.preventDefault e)
                     (uism/trigger! this ::settings :event/save)
                     (c/transact! this [(fs/clear-complete! {:entity-ident [:document/id id]})]))}
        (mui/vertical-grid
          {:spacing 2}
          (forms/text-input-with-label this :document/name "Name" "Must have 1 to 80 characters"
            {:fullWidth true
             :onChange  (fn [e]
                          (m/set-string!! this :document/name :event e)
                          (c/transact! this [(fs/mark-complete! {:entity-ident [:document/id id]
                                                                 :field        :document/name})]))
             :disabled  busy?})
          (forms/form-buttons
            {:component       this
             :validator       doc/validator
             :props           props
             :busy?           busy?
             :submit-token    "Save Document"
             :reset-token     "Discard Changes"
             :on-reset        (fn []
                                (uism/trigger! this ::settings :event/reset)
                                (c/transact! this [(fs/clear-complete! {:entity-ident [:document/id id]})]))
             :on-delete       (fn []
                                (uism/trigger! this ::settings :event/delete)
                                (r/route-to! :project {:id (:project/id project)}))
             :submit-disabled (or (not dirty)
                                  (not= :valid (doc/validator props))
                                  (not (fs/checked? props))
                                  busy?)
             :reset-disabled  (not (and dirty (not busy?)))}))))))

(def ui-settings (c/factory Settings))
