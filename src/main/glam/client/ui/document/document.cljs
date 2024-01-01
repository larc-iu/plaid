(ns glam.client.ui.document.document
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [glam.client.router :as r]
            [glam.client.util :as gcu]
            [glam.client.ui.material-ui :as mui]
            [glam.client.ui.document.text-editor :refer [TextEditor ui-text-editor]]
            [glam.client.ui.document.token-editor :refer [TokenEditor ui-token-editor]]
            [glam.client.ui.document.interlinear-editor :as ied :refer [InterlinearEditor ui-interlinear-editor]]
            [glam.client.ui.document.settings :as settings :refer [Settings ui-settings]]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.mutations :as m]
            [com.fulcrologic.fulcro.application :as app]
            [com.fulcrologic.fulcro.algorithms.normalize :as fnorm]
            [com.fulcrologic.fulcro.ui-state-machines :as uism]
            [glam.client.ui.common.forms :as forms]
            [glam.models.session :as sn]))

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
                  :schema-mutation ied/apply-schema}
   "settings"    {:slug     "settings"
                  :name     "Settings"
                  :join-key :>/settings}})
(def editor-joins (set (map (comp :join-key second) editors)))

(declare Document)
(defn do-load!
  ([app-or-comp doc-id tab load-opts]
   (do-load! app-or-comp doc-id tab load-opts false))
  ([app-or-comp doc-id tab load-opts mark-ready?]
   (let [editor-join-key (get-in editors [tab :join-key])
         schema-mutation (get-in editors [tab :schema-mutation])
         ident [:document/id doc-id]]
     (when doc-id
       (if (nil? schema-mutation)
         (df/load! app-or-comp ident Document
                   (merge {:without (disj editor-joins editor-join-key)}
                          load-opts
                          (when mark-ready?
                            {:post-mutation        `dr/target-ready
                             :post-mutation-params {:target ident}})))

         (df/load! app-or-comp [:document/id doc-id] Document
                   (merge (dissoc load-opts :post-mutation :post-mutation-params)
                          {:without (disj editor-joins editor-join-key)
                           :post-action
                           (fn [env]
                             (let [data-tree (-> env :result :body (get ident))]
                               (log/info "Triggering schema mutation: " schema-mutation)
                               (c/transact! app-or-comp
                                            [(schema-mutation {:data-tree      (editor-join-key data-tree)
                                                               :document/id    doc-id
                                                               :ui/mark-ready? mark-ready?})]))
                             (when-let [f (:post-action load-opts)]
                               (f)))})))))))

(m/defmutation change-tab [{:keys [tab]}]
  (action [{:keys [state ref component]}]
          (swap! state (fn [s]
                         (-> s
                             (assoc-in (conj ref :ui/busy?) true)
                             (assoc-in (conj ref :ui/active-tab) tab)
                             (assoc-in sn/session-ident (sn/session-assoc (get-in s sn/session-ident) (conj ref ::tab) tab)))))
          (do-load! component (last ref) tab {:post-action #(m/set-value! component :ui/busy? false)})))

(defsc Document
  [this {:document/keys [id name project] :ui/keys [active-tab busy?]
         :>/keys        [text-editor token-editor interlinear-editor settings] :as props}]
  {:query                [:document/id :document/name
                          {:document/project (c/get-query ProjectNameQuery)}
                          {:>/text-editor (c/get-query TextEditor)}
                          {:>/token-editor (c/get-query TokenEditor)}
                          {:>/interlinear-editor (c/get-query InterlinearEditor)}
                          {:>/settings (c/get-query Settings)}
                          :ui/active-tab
                          :ui/busy?
                          sn/session-join]
   :ident                :document/id
   :pre-merge            (fn [{:keys [data-tree state-map]}]
                           (let [q-params (r/get-query-params)
                                 session (get-in state-map sn/session-ident)
                                 ident [:document/id (:document/id data-tree)]
                                 tab-session-key (conj ident ::tab)
                                 tab (or (sn/session-get session tab-session-key)
                                         (:tab q-params)
                                         "text")]
                             (when (not= tab (:tab q-params))
                               (r/assoc-query-param! :tab tab))
                             (merge {:ui/active-tab tab
                                     :ui/busy?      false}
                                    data-tree
                                    {sn/session-ident (sn/session-assoc session tab-session-key tab)})))
   :route-segment        (r/last-route-segment :document)
   :will-enter           (fn [app {:keys [id] :as route-params}]
                           (let [parsed-id (gcu/parse-id id)
                                 session (get-in (app/current-state app) sn/session-ident)
                                 ident [:document/id parsed-id]
                                 tab-session-key (conj ident ::tab)
                                 tab (or (sn/session-get session tab-session-key)
                                         (:tab (r/get-query-params))
                                         "text")]
                             (when parsed-id
                               (dr/route-deferred
                                 [:document/id parsed-id]
                                 (fn []
                                   (do-load! app parsed-id tab {} true)
                                   ;; TODO: here (and in tab onclick, and in refresh lambda) is where I should
                                   ;; call a function defined in interlinear  which scans the state that was just
                                   ;; loaded and triggers any maintenance that might need to happen, e.g. realigning
                                   ;; spans with sentences. The route shouldn't be completed until all of this is over.
                                   ;; Pass a lambda that will call target ready, perhaps?
                                   ;; (c/transact! this [(do-corrections {:target-ready-fn ...})])
                                   )))))}

  (mui/container {:maxWidth "xl"}
    (mui/page-title name)
    (mui/arrow-breadcrumbs {}
      (mui/link {:variant "subtitle1" :underline "none" :color "inherit" :href (r/route-for :projects) :key "projects"} "Projects")
      (mui/link {:variant "subtitle1" :underline "none" :color "inherit" :href (r/route-for :project {:id (:project/id project)}) :key "project"} (:project/name project))
      (mui/link {:variant "subtitle1" :color "textPrimary" :underline "none" :key "document"} name))

    (mui/paper {}
      (if busy?
        (glam.client.ui.common.core/loader)
        (mui/tab-context {:value active-tab}
          (mui/tabs {:value    active-tab
                     :onChange (fn [_ val]
                                 (c/transact! this [(change-tab {:tab val})])
                                 (when (= val "settings")
                                   (uism/begin! this forms/edit-form-machine ::settings/settings
                                                {:actor/form (uism/with-actor-class [:document/id id] Settings)})))}
            (mui/tab {:label (get-in editors ["text" :name]) :value "text"})
            (mui/tab {:label (get-in editors ["token" :name]) :value "token"})
            (mui/tab {:label (get-in editors ["interlinear" :name]) :value "interlinear"})
            (mui/tab {:label (get-in editors ["settings" :name]) :value "settings"}))

          (c/fragment
            (mui/tab-panel {:value "text"}
              (ui-text-editor text-editor))
            (mui/tab-panel {:value "token"}
              (ui-token-editor token-editor))
            (mui/tab-panel {:value "interlinear"}
              (ui-interlinear-editor interlinear-editor))
            (mui/tab-panel {:value "settings"}
              (ui-settings settings))))))))
