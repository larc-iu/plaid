(ns glam.client.ui.project.project
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [com.fulcrologic.fulcro.application :as app]
            [com.fulcrologic.fulcro.ui-state-machines :as sm]
            [glam.client.router :as r]
            [glam.client.util :as gcu]
            [glam.client.ui.material-ui :as mui]
            [glam.models.session :as session :refer [Session]]
            [glam.models.document :as doc]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [com.fulcrologic.fulcro.ui-state-machines :as uism]
            [glam.client.ui.common.forms :as forms]
            [glam.client.ui.material-ui-icon :as muic]
            [com.fulcrologic.fulcro.algorithms.tempid :as tempid]))

;; add doc dialog --------------------------------------------------------------------------------
(defsc AddDocument [this {:document/keys [id] :ui/keys [busy?] :as props}]
  {:ident                   :document/id
   :query                   [fs/form-config-join :document/id :document/name :ui/busy?]
   :initial-state           {:ui/busy? false :document/name ""}
   :form-fields             #{:document/name}
   ::forms/validator        doc/validator
   ::forms/create-mutation  'glam.models.document/create-document
   ::forms/create-message   "Text layer added"
   ::forms/create-append-to :project/documents}
  (let [close-ctl-dialog (fn []
                           (uism/trigger! this ::add-document :event/cancel))]
    (dom/form
      {:onSubmit (fn [e]
                   (.preventDefault e)
                   (uism/trigger! this ::add-document :event/create))}
      (mui/box {:m 1 :p 1}
        (mui/vertical-grid
          (forms/text-input-with-label this :document/name "Name" "Must have 1 to 80 characters"
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
                                  (= :valid (doc/validator props))
                                  (not busy?)))}
            "Create Document")
          (mui/button
            {:size      "large"
             :variant   "outlined"
             :onClick   close-ctl-dialog
             :startIcon (muic/cancel)}
            "Cancel"))))))

(def ui-add-document (c/factory AddDocument))

;; core components --------------------------------------------------------------------------------
(defsc DocumentListItem
  [this {:document/keys [id name] :as props}]
  {:query [:document/id :document/name]
   :ident :document/id}

  ;; todo: fix link once document view is implemented
  (mui/list-item {:button  true
                  :onClick #(r/route-to! :document {:id id})}
    (mui/list-item-text {:primary name})))

(def ui-document-list-item (c/computed-factory DocumentListItem {:keyfn :document/id}))

(defsc Project
  [this {:project/keys [id name documents] :ui/keys [add-document modal-open?] :as props}]
  {:query         [:project/id :project/name
                   {:project/documents (c/get-query DocumentListItem)}
                   :ui/modal-open?
                   {:ui/add-document (c/get-query AddDocument)}]
   :ident         :project/id
   :pre-merge     (fn [{:keys [data-tree]}]
                    (merge {:project/documents []
                            :ui/modal-open?    false}
                           data-tree))
   :route-segment (r/last-route-segment :project)
   :will-enter    (fn [app {:keys [id] :as route-params}]
                    (log/info "Entering: " (pr-str route-params))
                    (let [parsed-id (gcu/parse-id id)]
                      (when parsed-id
                        (dr/route-deferred
                          [:project/id parsed-id]
                          #(df/load! app [:project/id parsed-id] Project
                                     {:post-mutation        `dr/target-ready
                                      :post-mutation-params {:target [:project/id parsed-id]}})))))}


  (mui/container {:maxWidth "md"}
    (mui/dialog {:open    modal-open?
                 :onClose (fn []
                            (uism/trigger! this ::add-document :event/cancel))}
      (mui/dialog-title {} "Add Document Layer")
      (mui/dialog-content {}
        (when add-document
          (ui-add-document add-document))))

    (mui/page-title name)
    (mui/arrow-breadcrumbs {}
      (mui/link {:color "inherit" :href (r/route-for :projects) :key "projects"} "Projects")
      (mui/link {:color "textPrimary" :underline "none" :key "user"} name))

    (mui/button
      {:variant   "outlined"
       :color     "primary"
       :startIcon (muic/add)
       :style     {:marginTop "1em"}
       :onClick   (fn []
                    (let [tempid (tempid/tempid)]
                      (c/transact! this [(forms/prepare-for-create {:ident          [:document/id tempid]
                                                                    :modal-join-key :ui/add-document
                                                                    :form-class     AddDocument})])
                      (uism/begin! this forms/create-form-machine ::add-document
                                   {:actor/form       (uism/with-actor-class [:document/id tempid] AddDocument)
                                    :actor/modal-host (uism/with-actor-class [:project/id id] Project)})))}
      "Add Document")

    (if-not (empty? documents)
      (mui/padded-paper
        (mui/list {:subheader (mui/list-subheader {:color "primary"} "Documents") :dense true}
          (mapv ui-document-list-item (sort-by :document/name documents))))
      (mui/box {:my 4}
        (mui/typography
          {:variant   "subtitle1"
           :component "h3"}
          "No documents exist.")))))

(def ui-project-detail (c/factory Project))

