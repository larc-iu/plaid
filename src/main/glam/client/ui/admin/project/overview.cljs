(ns glam.client.ui.admin.project.overview
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
            [com.fulcrologic.fulcro.ui-state-machines :as uism]
            [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [com.fulcrologic.fulcro.dom :as dom]
            [glam.client.application :refer [SPA]]
            [glam.models.project :as project :refer [validator]]
            [glam.client.ui.material-ui :as mui]
            [glam.client.ui.material-ui-icon :as muic]
            [glam.client.ui.common.forms :as forms]
            [glam.client.router :as r]
            [com.fulcrologic.fulcro.algorithms.tempid :as tempid]
            [com.fulcrologic.fulcro.algorithms.normalized-state :as fns]))

(def ident [:component/id :project-overview])

(defn add-project* [state-map id]
  (let [project-ident [:project/id id]
        project {:project/id id :project/name ""}]
    (assoc-in state-map project-ident project)))

(defmutation init-add-project [{:keys [id]}]
  (action [{:keys [state]}]
          (swap! state (fn [s]
                         (-> s
                             (add-project* id)
                             (assoc-in (conj ident :add-project) [:project/id id]))))))

(defmutation finish-add-project [{:keys [id]}]
  (action [{:keys [state]}]
          (swap! state (fn [s]
                         (fns/remove-entity s [:project/id id])))))

(defsc AddProject [this {:project/keys [id name] :ui/keys [busy?] :as props}]
  {:ident                   :project/id
   :query                   [fs/form-config-join :project/id :project/name :ui/busy?]
   :initial-state           {:ui/busy? false}
   :form-fields             #{:project/name}
   ::forms/validator        validator
   ::forms/create-mutation  'glam.models.project/create-project
   ::forms/create-message   "Project created"
   ::forms/create-append-to (conj ident :all-projects)}
  (let [close-cu-dialog (fn []
                          (uism/trigger! this ::add-project :event/cancel)
                          (c/transact! this [(finish-add-project {:id id})]))]
    (dom/form
      {:onSubmit (fn [e]
                   (.preventDefault e)
                   (uism/trigger! this ::add-project :event/create))}
      (mui/box {:width 400 :m 1 :p 1}
        (mui/vertical-grid
          (forms/text-input-with-label this :project/name "Name" "Must have 2 to 80 characters"
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
                                  (= :valid (validator props))
                                  (not busy?)))}
            "Create Project")
          (mui/button
            {:size      "large"
             :variant   "outlined"
             :onClick   close-cu-dialog
             :startIcon (muic/cancel)}
            "Cancel"))))))
(def ui-add-project (c/factory AddProject))

(defsc ProjectListItem [this {:project/keys [id name] :as props}]
  {:ident :project/id
   :query [:project/id :project/name]}
  (mui/list-item {:key     id
                  :button  true
                  :onClick #(r/route-to! :project-settings {:id id})}
    (mui/typography {:variant "h6"} name)))
(def ui-project-list-item (c/factory ProjectListItem))

(defsc ProjectOverview [this {:keys [all-projects add-project] :ui/keys [modal-open?] :as props}]
  {:ident         (fn [_] ident)
   :query         [{:all-projects (c/get-query ProjectListItem)}
                   {:add-project (c/get-query AddProject)}
                   :ui/modal-open?]
   :initial-state (fn [_]
                    {:all-projects   []
                     :add-project    (c/get-initial-state AddProject)
                     :ui/modal-open? false})
   :route-segment (r/last-route-segment :project-overview)
   :will-enter    (fn [app _]
                    (dr/route-deferred
                      ident
                      #(df/load! app :all-projects ProjectListItem
                                 {:target               (conj ident :all-projects)
                                  :post-mutation        `dr/target-ready
                                  :post-mutation-params {:target ident}})))}

  (mui/container {:maxWidth "lg" :style {:position "relative"}}
    (mui/page-title "Project Management")
    (mui/arrow-breadcrumbs {}
      (mui/link {:color "inherit" :href (r/route-for :admin-home) :key "admin"} "Admin Settings")
      (mui/link {:color "textPrimary" :href (r/route-for :project-overview) :key "project"} "Project Management"))

    ;; add project button
    (mui/dialog {:open modal-open? :onClose #(uism/trigger! this ::add-project :event/cancel)}
      (mui/dialog-title {} "Create Project")
      (mui/dialog-content {}
        (when add-project
          (ui-add-project add-project))))
    (mui/button
      {:variant   "contained"
       :color     "primary"
       :startIcon (muic/add)
       :onClick   (fn []
                    (let [id (tempid/tempid)]
                      (c/transact! this [(init-add-project {:id id})])
                      (uism/begin! this forms/create-form-machine ::add-project
                                   {:actor/form       (uism/with-actor-class [:project/id id] AddProject)
                                    :actor/modal-host (uism/with-actor-class ident ProjectOverview)})))
       :style     {:marginBottom "1em"}}
      "New Project")

    (mui/box {:width 600}
      (mui/paper {}
        (mui/list {}
          (map ui-project-list-item (sort-by :project/name all-projects)))))))

