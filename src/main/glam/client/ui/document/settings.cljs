(ns glam.client.ui.document.settings
  (:require [goog.object :as gobj]
            [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.mutations :as m]
            [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.mutations :as m]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [com.fulcrologic.fulcro.ui-state-machines :as uism]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [taoensso.timbre :as log]
            [glam.client.router :as r]
            [glam.models.document :as doc]
            [glam.client.ui.material-ui :as mui]
            [glam.client.ui.common.forms :as forms]
            [glam.client.ui.document.token-editor :refer [Token ui-token]]
            [glam.client.ui.material-ui-icon :as muic]
            ["json-beautify" :as beautify]))

(defsc ProjectQuery [this _]
  {:query [:project/id :project/name]
   :ident :project/id})

(def data-query
  [:document/id
   :document/name
   {:document/text-layers
    [:text-layer/name
     :text-layer/id
     {:text-layer/text [:text/id :text/body :text/document]}
     {:text-layer/token-layers
      [:token-layer/name
       {:token-layer/tokens [:token/id :token/text :token/begin :token/end :token/layer :token/value]}
       {:token-layer/span-layers
        [:span-layer/id :span-layer/name
         {:span-layer/spans [:span/id :span/value :span/layer :span/tokens]}]}]}]}])

(defsc Settings [this {:document/keys [id name project] :>/keys [data] :ui/keys [busy?] :as props}]
  {:query                  [:document/id :document/name fs/form-config-join :ui/busy?
                            {:document/project (c/get-query ProjectQuery)}
                            {:>/data data-query}]
   :ident                  :document/id
   :pre-merge              (fn [{:keys [data-tree]}]
                             (merge {:ui/busy? false}
                                    data-tree))
   ::forms/validator       doc/validator
   ::forms/save-mutation   'glam.models.document/save-document
   ::forms/delete-mutation 'glam.models.document/delete-document
   ::forms/delete-message  "Document deleted"
   :form-fields            #{:document/name}}
  (log/info data)
  (let [dirty (fs/dirty? props)]
    (mui/container {:maxWidth "md"}
      (mui/vertical-grid {:spacing 3}
        (dom/form
          {:onSubmit (fn [e]
                       (.preventDefault e)
                       (uism/trigger! this ::settings :event/save))}
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
               :reset-disabled  (not (and dirty (not busy?)))})))
        (mui/button {:type      "submit"
                     :size      "large"
                     :disabled  busy?
                     :color     "secondary"
                     :variant   "contained"
                     :startIcon (muic/cloud-download)
                     :onClick   (fn [e]
                                  (.preventDefault e)
                                  (let [data (beautify (clj->js data) nil 2 80)
                                        blob (js/Blob. [data] #js {:type "text/json"})
                                        link (.createElement js/document "a")]
                                    (set! (.-download link) (str name ".json"))
                                    (set! (.-href link) (js/window.URL.createObjectURL blob))
                                    (.click link)
                                    (.remove link)))}
          "Export")))))

(def ui-settings (c/factory Settings))
