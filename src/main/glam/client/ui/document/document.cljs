(ns glam.client.ui.document.document
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [glam.client.router :as r]
            [glam.client.util :as gcu]
            [glam.client.ui.material-ui :as mui]
            [glam.client.ui.document.text-editor :refer [TextEditor ui-text-editor]]
            [glam.client.ui.document.token-editor :refer [TokenEditor ui-token-editor]]
            [glam.client.ui.document.interlinear-editor :refer [InterlinearEditor ui-interlinear-editor]]
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

(def editors
  {"text" {:slug "text" :name "Text" :class TextEditor :join-key :>/text-editor}
   "token" {:slug "token" :name "Tokens" :class TokenEditor :join-key :>/token-editor}
   "interlinear" {:slug "interlinear" :name "Interlinear" :class InterlinearEditor :join-key :>/interlinear-editor}})
(def editor-joins (set (map (comp :join-key second) editors)))

(defsc Document
  [this {:document/keys [id name project] :ui/keys [active-tab busy?]
         :>/keys [text-editor token-editor interlinear-editor] :as props}]
  {:query         [:document/id :document/name
                   {:document/project (c/get-query ProjectNameQuery)}
                   {:>/text-editor (c/get-query TextEditor)}
                   {:>/token-editor (c/get-query TokenEditor)}
                   {:>/interlinear-editor (c/get-query InterlinearEditor)}
                   :ui/active-tab
                   :ui/busy?]
   :ident         :document/id
   :pre-merge     (fn [{:keys [data-tree]}]
                    (let [q-params (r/get-query-params)
                          tab (or (:tab q-params) "interlinear")]
                      (when (not= tab (:tab q-params))
                        (r/assoc-query-param! :tab "interlinear"))
                      (merge {:ui/active-tab tab
                              :ui/busy?      false}
                             data-tree)))
   :route-segment (r/last-route-segment :document)
   :will-enter    (fn [app {:keys [id] :as route-params}]
                    (let [parsed-id (gcu/parse-id id)
                          tab (or (:tab (r/get-query-params)) "interlinear")
                          editor-join-key (get-in editors [tab :join-key])]
                      (when parsed-id
                        (dr/route-deferred
                          [:document/id parsed-id]
                          (fn []
                            (df/load! app [:document/id parsed-id] Document
                                      {:post-mutation        `dr/target-ready
                                       :post-mutation-params {:target [:document/id parsed-id]}
                                       :without              (disj editor-joins editor-join-key)}))))))}

  (mui/container {:maxWidth "xl"}
    (mui/page-title name)
    (mui/arrow-breadcrumbs {}
      (mui/link {:color "inherit" :href (r/route-for :projects) :key "projects"} "Projects")
      (mui/link {:color "inherit" :href (r/route-for :project {:id (:project/id project)}) :key "project"} (:project/name project))
      (mui/link {:color "textPrimary" :underline "none" :key "document"} name))

    (mui/paper {}
      (mui/tab-context {:value active-tab}
        (mui/tabs {:value    active-tab
                   :onChange (fn [_ val]
                               (m/set-value! this :ui/active-tab val)
                               (m/set-value! this :ui/busy? true)
                               (r/assoc-query-param! :tab val)
                               (df/load! this [:document/id id] (get-in editors [val :class])
                                         {:target      [:document/id id (get-in editors [val :join-key])]
                                          :post-action #(m/set-value! this :ui/busy? false)}))}
          (mui/tab {:label (get-in editors ["text" :name]) :value "text"})
          (mui/tab {:label (get-in editors ["token" :name]) :value "token"})
          (mui/tab {:label (get-in editors ["interlinear" :name]) :value "interlinear"}))

        (if busy?
          (glam.client.ui.common.core/loader)
          (c/fragment
            (mui/tab-panel {:value "text"}
              (ui-text-editor text-editor))
            (mui/tab-panel {:value "token"}
              (ui-token-editor token-editor))
            (mui/tab-panel {:value "interlinear"}
              (ui-interlinear-editor interlinear-editor))))))))