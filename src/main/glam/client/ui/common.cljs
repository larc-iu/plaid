(ns glam.client.ui.common
  (:require [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.components :as c]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [glam.client.ui.material-ui :as mui]))

(defn loader []
  (mui/box {:alignItems     "center"
            :justifyContent "center"
            :display        "flex"
            :minHeight      400}
    (mui/circular-progress {:size "6em"})))

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
  [component field label validator validation-message input-attrs]
  (let [{:keys [invalid?]} (field-attrs component field validator)]
    (mui/text-field
      (merge {:variant    "filled"
              :error      invalid?
              :helperText (if invalid? validation-message "")
              :label      label}
             input-attrs))))

