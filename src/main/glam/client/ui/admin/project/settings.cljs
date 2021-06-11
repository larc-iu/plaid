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
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
            [com.fulcrologic.fulcro.components :as comp]))

(defn layers
  [this props]
  (mui/grid {:container true :spacing 1}
    (mui/grid {:item true :xs 3}
      (mui/paper {:style {:minHeight "600px"}} "Foo"))
    (mui/grid {:item true :xs 9}
      (mui/paper {} "Bar"))))


(defsc ProjectSettings [this {:project/keys [id name] :ui/keys [active-tab] :as props}]
  {:query         [:project/id :project/name :ui/active-tab]
   :ident         :project/id
   :pre-merge     (fn [{:keys [data-tree] :as m}]
                    (merge {:ui/active-tab "0"}
                           data-tree))
   :route-segment (r/last-route-segment :project-settings)
   :will-enter    (fn [app {:keys [id]}]
                    (dr/route-deferred
                      [:project/id (uuid id)]
                      #(df/load! app [:project/id (uuid id)] ProjectSettings
                                 {:post-mutation        `dr/target-ready
                                  :post-mutation-params {:target [:project/id (uuid id)]}})))}
  (mui/container {:maxWidth "lg" :style {:position "relative"}}
    (mui/page-title name)
    (mui/arrow-breadcrumbs {}
      (mui/link {:color "inherit" :href (r/route-for :admin-home) :key "admin"} "Admin Settings")
      (mui/link {:color "inherit" :href (r/route-for :project-overview) :key "project"} "Project Management")
      (mui/link {:color "textPrimary" :href (r/route-for :project-settings {:id id}) :key id} name))

    (mui/tab-context {:value active-tab}
      (mui/tabs {:value    active-tab
                 :onChange #(m/set-value! this :ui/active-tab %2)}
        (mui/tab {:label "Tab 1" :value "0"})
        (mui/tab {:label "Tab 2" :value "1"}))

      (mui/tab-panel {:index "0"}
        "Hi World"
        (layers this props))
      (mui/tab-panel {:index "1"}
        "Hi World w"
        ))))

;; TODO: user needs to
;; - configure name and other general info
;; - see user read/write perms
;; - see text-layers
;; should probably do all this by introducing tabs that are put in correspondence with the url
