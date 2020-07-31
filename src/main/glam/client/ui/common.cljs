(ns glam.client.ui.common
  (:require [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.components :as c]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [glam.client.ui.material-ui :as mui]
            [com.fulcrologic.fulcro.mutations :as m]))

(defn loader []
  (mui/box {:alignItems     "center"
            :justifyContent "center"
            :display        "flex"
            :minHeight      400}
    (mui/circular-progress {:size "6em"})))

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
  "Text input based on mui/text-field for use with forms. Note: onBlur completes
  the field by default."
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

