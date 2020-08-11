(ns glam.client.ui.home
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.ui-state-machines :as sm]
            [glam.models.session :as sn]
            [glam.client.router :as r]
            [glam.client.ui.login :refer [Login ui-login]]
            [glam.client.ui.signup :refer [Signup ui-signup]]
            [glam.client.ui.material-ui :as mui]))

(defsc Home [this props]
  {:query              [{:home/signup (c/get-query Signup)}
                        {:home/login (c/get-query Login)}
                        sn/session-join]
   :ident              (fn [_] [:component/id :home])
   :componentDidUpdate (fn [this]
                         (let [props (c/props this)]
                           (when (sn/valid-session? props)
                             (r/redirect-to! :projects))))
   :initial-state      (fn [_] {:home/signup (c/get-initial-state Signup)
                                :home/login  (c/get-initial-state Login)})
   :route-segment      (r/last-route-segment :home)}
  (mui/box {:width 400 :p 1 :m 1 :mx "auto"}
    (mui/paper {}
      (mui/box {:p 2}
        (mui/grid {:container true :direction "column" :spacing 5}
          (mui/grid {:item true} (ui-login (:home/login props)))
          (mui/grid {:item true} (ui-signup (:home/signup props))))))))
