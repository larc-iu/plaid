(ns glam.client.ui.document.document
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [glam.client.router :as r]
            [glam.client.util :as gcu]
            [glam.client.ui.material-ui :as mui]
            [glam.client.application :as gca]
            [glam.client.ui.document.text-editor :refer [TextEditor ui-text-editor]]
            [glam.client.ui.document.token-editor :refer [TokenEditor ui-token-editor]]
            [glam.client.ui.document.interlinear-editor :as ied :refer [InterlinearEditor ui-interlinear-editor]]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.mutations :as m]
            [com.fulcrologic.fulcro.application :as app]
            [com.fulcrologic.fulcro.algorithms.normalize :as fnorm]))

(defsc ProjectNameQuery
  [this props]
  {:query [:project/id :project/name]
   :ident :project/id})

(def editors
  {"text"        {:slug "text" :name "Text" :join-key :>/text-editor}
   "token"       {:slug "token" :name "Tokens" :join-key :>/token-editor}
   "interlinear" {:slug            "interlinear"
                  :name            "Interlinear"
                  :join-key        :>/interlinear-editor
                  :schema-mutation ied/apply-schema}})
(def editor-joins (set (map (comp :join-key second) editors)))

(declare Document)
(defn do-load!
  ([app-or-comp doc-id tab]
   (do-load! app-or-comp doc-id tab {}))
  ([app-or-comp doc-id tab load-opts]
   (let [editor-join-key (get-in editors [tab :join-key])
         schema-mutation (get-in editors [tab :schema-mutation])]
     (when doc-id
       (df/load! app-or-comp [:document/id doc-id] Document
                 (merge load-opts
                        {:without
                         (disj editor-joins editor-join-key)
                         :post-action
                         (fn [env]
                           (let [data-tree (-> env :result :body (get [:document/id doc-id]))]
                             (when schema-mutation
                               (c/transact! app-or-comp
                                            [(schema-mutation {:data-tree (editor-join-key data-tree)})]))))}))))))

(defsc Document
  [this {:document/keys [id name project] :ui/keys [active-tab busy?]
         :>/keys        [text-editor token-editor interlinear-editor] :as props}]
  {:query                [:document/id :document/name
                          {:document/project (c/get-query ProjectNameQuery)}
                          {:>/text-editor (c/get-query TextEditor)}
                          {:>/token-editor (c/get-query TokenEditor)}
                          {:>/interlinear-editor (c/get-query InterlinearEditor)}
                          :ui/active-tab
                          :ui/busy?]
   :ident                :document/id
   :pre-merge            (fn [{:keys [data-tree]}]
                           (let [q-params (r/get-query-params)
                                 tab (or (:tab q-params) "interlinear")]
                             (when (not= tab (:tab q-params))
                               (r/assoc-query-param! :tab "interlinear"))
                             (merge {:ui/active-tab tab
                                     :ui/busy?      false}
                                    data-tree)))
   :route-segment        (r/last-route-segment :document)
   :will-enter           (fn [app {:keys [id] :as route-params}]
                           (let [parsed-id (gcu/parse-id id)
                                 tab (or (:tab (r/get-query-params)) "interlinear")]
                             (when parsed-id
                               (dr/route-deferred
                                 [:document/id parsed-id]
                                 (fn []
                                   ;; TODO: target-ready should actually be called once the apply-schema mutation is done
                                   (m/raw-set-value! app {:document/id parsed-id} :ui/checking-schema? true)
                                   (do-load! app parsed-id tab
                                             {:post-mutation        `dr/target-ready
                                              :post-mutation-params {:target [:document/id parsed-id]}})
                                   ;; TODO: here (and in tab onclick, and in refresh lambda) is where I should
                                   ;; call a function defined in interlinear  which scans the state that was just
                                   ;; loaded and triggers any maintenance that might need to happen, e.g. realigning
                                   ;; spans with sentences. The route shouldn't be completed until all of this is over.
                                   ;; Pass a lambda that will call target ready, perhaps?
                                   ;; (c/transact! this [(do-corrections {:target-ready-fn ...})])
                                   )))))
   :componentDidMount    (fn [this]
                           (let [props (c/props this)
                                 doc-id (:document/id props)
                                 tab (:ui/active-tab props)]
                             (let [unregister! (gca/register-subscription!
                                                 [:document/id doc-id]
                                                 #(do-load! this doc-id tab))]
                               (c/set-state! this {:unregister-fn unregister!}))))
   :componentWillUnmount (fn [this]
                           (when-let [unregister! (:unregister-fn (c/get-state this))]
                             (unregister!)))}

  (mui/container {:maxWidth "xl"}
    (mui/page-title name)
    (mui/arrow-breadcrumbs {}
      (mui/link {:color "inherit" :href (r/route-for :projects) :key "projects"} "Projects")
      (mui/link {:color "inherit" :href (r/route-for :project {:id (:project/id project)}) :key "project"} (:project/name project))
      (mui/link {:color "textPrimary" :underline "none" :key "document"} name))

    (mui/paper {}
      (if busy?
        (glam.client.ui.common.core/loader)
        (mui/tab-context {:value active-tab}
          (mui/tabs {:value    active-tab
                     :onChange (fn [_ val]
                                 (m/set-value! this :ui/active-tab val)
                                 (m/set-value! this :ui/busy? true)
                                 (r/assoc-query-param! :tab val)
                                 (do-load! this id val {:post-action #(m/set-value! this :ui/busy? false)}))}
            (mui/tab {:label (get-in editors ["text" :name]) :value "text"})
            (mui/tab {:label (get-in editors ["token" :name]) :value "token"})
            (mui/tab {:label (get-in editors ["interlinear" :name]) :value "interlinear"}))

          (c/fragment
            (mui/tab-panel {:value "text"}
              (ui-text-editor text-editor))
            (mui/tab-panel {:value "token"}
              (ui-token-editor token-editor))
            (mui/tab-panel {:value "interlinear"}
              (ui-interlinear-editor interlinear-editor))))))))
