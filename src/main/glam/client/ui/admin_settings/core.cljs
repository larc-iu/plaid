(ns glam.client.ui.admin-settings.core
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [glam.models.session :as sn]
            [glam.client.router :as r]
            [glam.client.ui.material-ui :as mui]
            [glam.client.ui.admin-settings.user-management :refer [ui-user-management UserManagement]]
            [com.fulcrologic.fulcro.data-fetch :as df]))

(def ident [:component/id :admin-settings])

(defmutation change-tab [{:keys [tab]}]
  (action [{:keys [state]}]
          (swap! state assoc-in (conj ident :tab) tab)))


(def component-map
  {"0" UserManagement})

(defsc AdminSettings [this {:keys [tab] :as props}]
  {:ident             (fn [_] ident)
   :query             [sn/session-join :tab
                       {:admin/user-management (c/get-query UserManagement)}]
   :initial-state     {:tab                   "0"
                       :admin/user-management {}}
   :componentDidMount #((-> (get component-map "0") c/component-options :load-fn))
   :route-segment     (r/route-segment :admin-settings)
   }
  (when (and (sn/valid-session? props) (sn/admin? props))
    (mui/page-container
      (mui/tab-context {:value tab}
        (mui/tabs {:value    tab
                   :centered true
                   :onChange (fn [_ tab]
                               (c/transact! this [(change-tab {:tab tab})])
                               (if-let [do-loads (-> component-map
                                                     (get tab)
                                                     c/component-options
                                                     :load-fn)]
                                 (do-loads)))}
          (mui/tab {:label "Users" :value "0"})
          (mui/tab {:label "Bar" :value "1"}))

        (mui/tab-panel {:value "0"}
          (ui-user-management (:admin/user-management props)))
        (mui/tab-panel {:value "1"}
          "Bar")

        ))))
