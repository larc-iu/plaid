(ns glam.client.ui.admin-settings.core
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [glam.models.session :as sn]
            [glam.client.router :as r]
            [glam.client.ui.material-ui :as mui]))

(def ident [:component/id :admin-settings])

(defmutation change-tab [{:keys [tab]}]
  (action [{:keys [state]}]
          (swap! state assoc-in (conj ident :tab) tab)))

(defsc AdminSettings [this {:keys [tab] :as props}]
  {:ident         (fn [_] ident)
   :query         [sn/session-join :tab]
   :initial-state {:tab "0"}
   :route-segment (r/route-segment :admin-settings)}
  (when (and (sn/valid-session? props) (sn/admin? props))
    (mui/page-container
      (mui/tab-context {:value tab}
        (mui/tabs {:value tab
                   :centered true
                   :onChange #(c/transact! this [(change-tab {:tab %2})])}
          (mui/tab {:label "Foo" :value "0"})
          (mui/tab {:label "Bar" :value "1"}))

        (mui/tab-panel {:value "0"}
          "Foo")
        (mui/tab-panel {:value "1"}
          "Bar")

        ))))
