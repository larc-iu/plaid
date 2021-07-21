(ns glam.client.ui.admin.project.settings
  "The UI for admin settings on a single project."
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [com.fulcrologic.fulcro.algorithms.denormalize :as fdn]
            [com.fulcrologic.fulcro.algorithms.merge :as fm]
            [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
            [com.fulcrologic.fulcro.components :as comp]
            [com.fulcrologic.fulcro.algorithms.tempid :as tempid]
            [com.fulcrologic.fulcro.ui-state-machines :as uism]
            [glam.client.router :as r]
            [glam.models.session :as sn]
            [glam.models.text-layer :as txtl]
            [glam.client.ui.material-ui :as mui]
            [glam.client.ui.material-ui-icon :as muic]
            [glam.client.ui.common.core :as uic]
            [glam.client.util :as gcu]
            [glam.client.ui.common.forms :as forms]
            [com.fulcrologic.fulcro.algorithms.normalized-state :as fns]))

;; Side panel components --------------------------------------------------------------------------------
(defsc SpanLayerListItem
  [this {:span-layer/keys [id name]} {:keys [set-active-layer]}]
  {:query [:span-layer/name :span-layer/id]
   :ident :span-layer/id}
  (mui/tree-item {:label   name
                  :nodeId  id
                  :icon    (muic/settings-ethernet)
                  :onClick #(set-active-layer [:span-layer/id id])}))

(def ui-span-list-layer-item (comp/computed-factory SpanLayerListItem {:keyfn :span-layer/id}))

(defsc TokenLayerListItem
  [this {:token-layer/keys [id name span-layers]} {:keys [set-active-layer]}]
  {:query [:token-layer/id :token-layer/name
           {:token-layer/span-layers (comp/get-query SpanLayerListItem)}]
   :ident :token-layer/id}
  (mui/tree-item {:label   name
                  :nodeId  id
                  :icon    (muic/more-horiz)
                  :onClick #(set-active-layer [:token-layer/id id])}
    (when span-layers
      (doall
        (map ui-span-list-layer-item
             (map #(comp/computed % {:set-active-layer set-active-layer}) span-layers))))))

(def ui-token-list-layer-item (comp/computed-factory TokenLayerListItem {:keyfn :token-layer/id}))

(defsc TextLayerListItem
  [this {:text-layer/keys [id name token-layers]} {:keys [set-active-layer]}]
  {:query [:text-layer/id :text-layer/name {:text-layer/token-layers (comp/get-query TokenLayerListItem)}]
   :ident :text-layer/id}
  (mui/tree-item {:label   name
                  :nodeId  id
                  :icon    (muic/description-outlined)
                  :onClick #(set-active-layer [:text-layer/id id])}
    (when token-layers
      (doall
        (map ui-token-list-layer-item
             (map #(comp/computed % {:set-active-layer set-active-layer}) token-layers))))))

(def ui-text-layer-list-item (comp/computed-factory TextLayerListItem {:keyfn :text-layer/id}))

;; Main panel components --------------------------------------------------------------------------------
(defsc SpanLayerForm
  [this {:span-layer/keys [id name]}]
  {:query [:span-layer/name :span-layer/id]
   :ident :span-layer/id}
  name)

(def ui-span-layer-form (comp/factory SpanLayerForm))

(defsc TokenLayerForm
  [this {:token-layer/keys [id name]}]
  {:query [:token-layer/id :token-layer/name]
   :ident :token-layer/id}
  name)

(def ui-token-layer-form (comp/factory TokenLayerForm))

(defsc TextLayerForm
  [this {:text-layer/keys [id name]}]
  {:query [:text-layer/id :text-layer/name]
   :ident :text-layer/id}
  name)

(def ui-text-layer-form (comp/factory TextLayerForm))

(defsc LayerUnion [this props]
  {:ident (fn [] (cond (:text-layer/id props) [:text-layer/id (:text-layer/id props)]
                       (:token-layer/id props) [:token-layer/id (:token-layer/id props)]
                       (:span-layer/id props) [:span-layer/id (:span-layer/id props)]
                       :else (log/error "Unrecognized layer type!" props)))
   :query (fn [] {:text-layer/id  (comp/get-query TextLayerForm)
                  :token-layer/id (comp/get-query TokenLayerForm)
                  :span-layer/id  (comp/get-query SpanLayerForm)})}
  (cond
    (:text-layer/id props) (ui-text-layer-form props)
    (:token-layer/id props) (ui-token-layer-form props)
    (:span-layer/id props) (ui-span-layer-form props)
    (nil? props) (mui/typography {:variant "body1"} "Select a layer")
    :else (dom/div "Unrecognized layer type!")))

(def ui-layer-union (comp/factory LayerUnion))

;; Top-level component --------------------------------------------------------------------------------

;; create new text layer form
(defn add-text-layer* [state-map id]
  (let [text-layer-ident [:text-layer/id id]
        text-layer {:text-layer/id id :text-layer/name ""}]
    (assoc-in state-map text-layer-ident text-layer)))

(defmutation init-add-text-layer [{:keys [id]}]
  (action [{:keys [state ref]}]
          (swap! state (fn [s]
                         (-> s
                             (add-text-layer* id)
                             (assoc-in (conj ref :ui/add-text-layer) [:text-layer/id id]))))))

(defmutation finish-add-text-layer [{:keys [id]}]
  (action [{:keys [state ref]}]
          (swap! state (fn [s]
                         (fns/remove-entity s [:text-layer/id id])))))

(defsc AddTextLayer [this {:text-layer/keys [id name] :ui/keys [busy?] :as props} {:keys [parent-id]}]
  {:ident                   :text-layer/id
   :query                   [fs/form-config-join :text-layer/id :text-layer/name :ui/busy?]
   :intitial-state          {:ui/busy? false}
   :form-fields             #{:text-layer/name}
   ::forms/validator        txtl/validator
   ::forms/create-mutation  'glam.models.text-layer/create-text-layer
   ::forms/create-message   "Text layer added"
   ::forms/create-append-to :project/text-layers}
  (let [close-ctl-dialog (fn []
                           (uism/trigger! this ::add-text-layer :event/cancel)
                           (c/transact! this [(finish-add-text-layer {:id id})]))]
    (dom/form
      {:onSubmit (fn [e]
                   (.preventDefault e)
                   (uism/trigger! this ::add-text-layer :event/create))}
      (mui/box {:width 400 :m 1 :p 1}
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

(def ui-add-text-layer (c/computed-factory AddTextLayer))

(defn- all-ids
  "Helper function: we want all items to be expanded by default in the tree-view, and to do this we need to
  hand the tree-view all the IDs of our nodes."
  [{txtid :text-layer/id
    tokid :token-layer/id
    slid  :span-layer/id :as props}]
  (cond (some? txtid) (conj (flatten (map all-ids (:text-layer/token-layers props))) txtid)
        (some? tokid) (conj (flatten (map all-ids (:token-layer/span-layers props))) tokid)
        (some? slid) [slid]
        :else (log/error "Unknown layer type!" props)))

(defsc ProjectSettings [this {:project/keys [id name text-layers]
                              :ui/keys      [active-tab add-text-layer modal-open?] :as props}]
  {:query         [:project/id
                   :project/name
                   {:project/text-layers (c/get-query TextLayerListItem)}
                   {:ui/active-layer (c/get-query LayerUnion)}
                   {:ui/add-text-layer (c/get-query AddTextLayer)}
                   :ui/active-tab
                   :ui/modal-open?]
   :ident         :project/id
   :initial-state (fn [_]
                    {:ui/modal-open?    false
                     :ui/add-text-layer (c/get-initial-state AddTextLayer)})
   :pre-merge     (fn [{:keys [data-tree] :as m}]
                    ;; initial-state doesn't work for some reason
                    (merge {:ui/active-tab "layers"}
                           data-tree))
   :route-segment (r/last-route-segment :project-settings)
   :will-enter    (fn [app {:keys [id]}]
                    (let [parsed-id (gcu/parse-id id)]
                      (dr/route-deferred
                        [:project/id parsed-id]
                        #(df/load! app [:project/id parsed-id] ProjectSettings
                                   {:post-mutation        `dr/target-ready
                                    :post-mutation-params {:target [:project/id parsed-id]}}))))}
  (let [set-active-layer (fn set-active-layer [ident] (m/set-value! this :ui/active-layer ident))]
    (log/info add-text-layer)
    (mui/container {:maxWidth "lg" :style {:position "relative"}}
      (mui/page-title name)
      (mui/arrow-breadcrumbs {}
        (mui/link {:color "inherit" :href (r/route-for :admin-home) :key "admin"} "Admin Settings")
        (mui/link {:color "inherit" :href (r/route-for :project-overview) :key "project"} "Project Management")
        (mui/link {:color "textPrimary" :href (r/route-for :project-settings {:id id}) :key id} name))

      ;; add text layer modal
      (mui/dialog {:open modal-open? :onClose #(uism/trigger! this ::add-text-layer :event/cancel)}
        (mui/dialog-title {} "Add Text Layer")
        (mui/dialog-content {}
          (when add-text-layer
            (ui-add-text-layer (c/computed add-text-layer {:parent-id id})))))

      ;; Tab 1: layer configuration
      (mui/tab-context {:value active-tab}
        (mui/tabs {:value    active-tab
                   :onChange #(m/set-value! this :ui/active-tab %2)}
          (mui/tab {:label "Layers" :value "layers"})
          (mui/tab {:label "Access" :value "access"}))

        (mui/tab-panel {:value "layers"}
          (mui/grid {:container true :spacing 1}
            ;; Layer list
            (mui/grid {:item true :xs 12 :md 3}
              (mui/padded-paper {}
                (comp/fragment
                  (if (empty? text-layers)
                    (mui/typography {:variant "subtitle1"
                                     :color   "textSecondary"} "No layers configured.")
                    (mui/tree-view {:expanded (reduce into [] (map all-ids text-layers))}
                      (mapv ui-text-layer-list-item
                            (map #(comp/computed % {:set-active-layer set-active-layer}) text-layers))))
                  (mui/button
                    {:variant   "contained"
                     :color     "primary"
                     :startIcon (muic/add)
                     :style     {:marginTop "1em"}
                     :onClick   (fn []
                                  (let [tempid (tempid/tempid)]
                                    (c/transact! this [(init-add-text-layer {:id tempid})])
                                    (uism/begin! this forms/create-form-machine ::add-text-layer
                                                 {:actor/form       (uism/with-actor-class [:text-layer/id tempid] AddTextLayer)
                                                  :actor/modal-host (uism/with-actor-class [:project/id id] ProjectSettings)})))}
                    "New Text Layer"))))
            ;; Layer configuration
            (mui/grid {:item true :xs 12 :md 9}
              (mui/padded-paper {}
                (if (empty? text-layers)
                  (mui/typography {:variant "body1"
                                   :color   "textSecondary"} "No layers configured.")
                  (ui-layer-union (:ui/active-layer props)))))))

        ;; Tab 2: user permissions
        (mui/tab-panel {:value "access"}
          "Hi World w"
          )))))

;; TODO: user needs to
;; - configure name and other general info
;; - see user read/write perms
;; - see text-layers
;; should probably do all this by introducing tabs that are put in correspondence with the url
