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


(def load-fns
  "Every tab-level component for admin settings must have a :load-fn component option.
  It is used to load that tab's data every time the tab is opened."
  (let [load-fn #(-> % c/component-options :load-fn)]
    {"0" (load-fn UserManagement)}))

(defsc AdminSettings [this {:keys [tab] :as props}]
  {:ident             (fn [_] ident)
   :query             [sn/session-join :tab
                       {:admin/user-management (c/get-query UserManagement)}]
   :initial-state     {:tab                   "0"
                       :admin/user-management {}}
   ;; mui/tabs's onChange seems not to fire on mount, so we have to manually do the load
   ;; for the first tab (i know i know...)
   :componentDidMount (get load-fns "0")
   :route-segment     (r/route-segment :admin-settings)
   }
  (when (and (sn/valid-session? props) (sn/admin? props))
    (mui/tab-context {:value tab}
      (mui/tabs {:value    tab
                 :centered true
                 :onChange (fn [_ tab]
                             (c/transact! this [(change-tab {:tab tab})])
                             (if-let [load-fn (get load-fns tab)]
                               (load-fn)))}
        (mui/tab {:label "Users" :value "0"})
        (mui/tab {:label "Bar" :value "1"}))

      (mui/tab-panel {:value "0"}
        (ui-user-management (:admin/user-management props)))
      (mui/tab-panel {:value "1"}
        "Bar")

      )))
