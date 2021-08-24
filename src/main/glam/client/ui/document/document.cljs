(ns glam.client.ui.document.document
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [glam.client.router :as r]
            [glam.client.util :as gcu]
            [glam.client.ui.material-ui :as mui]
            [glam.client.ui.document.text-editor :refer [TextEditor ui-text-editor]]
            [glam.client.ui.document.grid-editor :refer [GridEditor ui-grid-editor]]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.mutations :as m]))

(defsc ProjectNameQuery
  [this props]
  {:query [:project/id :project/name]
   :ident :project/id})

;; plan:
;; - seems like we need to make a component for each layer
;; - each layer should have the data points in addition to the layer's regular stuff.
;;   - how to do this? document has a :document/text-layers resolver
;;   - all layers gain a data point resolver


(defsc Document
  [this {:document/keys [id name project] :ui/keys [active-tab] :>/keys [text-editor grid-editor] :as props}]
  {:query         [:document/id :document/name
                   {:document/project (c/get-query ProjectNameQuery)}
                   {:>/text-editor (c/get-query TextEditor)}
                   {:>/grid-editor (c/get-query GridEditor)}
                   :ui/active-tab]
   :ident         :document/id
   :pre-merge     (fn [{:keys [data-tree]}]
                    (let [q-params (r/get-query-params)
                          tab (or (:tab q-params) "grid")]
                      (when (not= tab (:tab q-params))
                        (r/assoc-query-param! :tab "grid"))
                      (merge {:ui/active-tab tab}
                             data-tree)))
   :route-segment (r/last-route-segment :document)
   :will-enter    (fn [app {:keys [id] :as route-params}]
                    (let [parsed-id (gcu/parse-id id)]
                      (when parsed-id
                        (dr/route-deferred
                          [:document/id parsed-id]
                          (fn []
                            (df/load! app [:document/id parsed-id] Document
                                      {:post-mutation        `dr/target-ready
                                       :post-mutation-params {:target [:document/id parsed-id]}}))))))}

  (mui/container {:maxWidth "xl"}
    (mui/page-title name)
    (mui/arrow-breadcrumbs {}
      (mui/link {:color "inherit" :href (r/route-for :projects) :key "projects"} "Projects")
      (mui/link {:color "inherit" :href (r/route-for :project {:id (:project/id project)}) :key "project"} (:project/name project))
      (mui/link {:color "textPrimary" :underline "none" :key "document"} name))

    (mui/tab-context {:value active-tab}
      (mui/tabs {:value    active-tab
                 :onChange (fn [_ val]
                             (m/set-value! this :ui/active-tab val)
                             (r/assoc-query-param! :tab val))}
        (mui/tab {:label "Text" :value "text"})
        (mui/tab {:label "Annotation" :value "grid"}))

      (mui/tab-panel {:value "text"}
        (ui-text-editor text-editor))
      (mui/tab-panel {:value "grid"}
        (ui-grid-editor grid-editor)))))
