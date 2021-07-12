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
            [glam.client.router :as r]
            [glam.models.session :as sn]
            [glam.client.ui.material-ui :as mui]
            [glam.client.ui.material-ui-icon :as muic]
            [glam.client.ui.common.core :as uic]
            [glam.client.util :as gcu]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
            [com.fulcrologic.fulcro.components :as comp]))

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
    (nil? props) (dom/div "Select a layer")
    :else (dom/div "Unrecognized layer type!")))

(def ui-layer-union (comp/factory LayerUnion))

;; Top-level component --------------------------------------------------------------------------------
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

(defsc ProjectSettings [this {:project/keys [id name text-layers] :ui/keys [active-tab] :as props}]
  {:query         [:project/id
                   :project/name
                   {:project/text-layers (c/get-query TextLayerListItem)}
                   :ui/active-tab
                   {:ui/active-layer (c/get-query LayerUnion)}]
   :ident         :project/id
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
    (mui/container {:maxWidth "lg" :style {:position "relative"}}
      (mui/page-title name)
      (mui/arrow-breadcrumbs {}
        (mui/link {:color "inherit" :href (r/route-for :admin-home) :key "admin"} "Admin Settings")
        (mui/link {:color "inherit" :href (r/route-for :project-overview) :key "project"} "Project Management")
        (mui/link {:color "textPrimary" :href (r/route-for :project-settings {:id id}) :key id} name))

      (mui/tab-context {:value active-tab}
        (mui/tabs {:value    active-tab
                   :onChange #(m/set-value! this :ui/active-tab %2)}
          (mui/tab {:label "Layers" :value "layers"})
          (mui/tab {:label "Access" :value "access"}))

        (log/info (flatten (map all-ids text-layers)))
        (mui/tab-panel {:value "layers"}
          (mui/grid {:container true :spacing 1}
            (mui/grid {:item true :xs 12 :md 3}
              (mui/padded-paper {}
                (mui/tree-view {:expanded (reduce into [] (map all-ids text-layers))}
                  (doall
                    (map ui-text-layer-list-item
                         (map #(comp/computed % {:set-active-layer set-active-layer}) text-layers))))))
            (mui/grid {:item true :xs 12 :md 9}
              (mui/padded-paper {}
                (ui-layer-union (:ui/active-layer props))))))
        (mui/tab-panel {:value "access"}
          "Hi World w"
          )))))

;; TODO: user needs to
;; - configure name and other general info
;; - see user read/write perms
;; - see text-layers
;; should probably do all this by introducing tabs that are put in correspondence with the url
