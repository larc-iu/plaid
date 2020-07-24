(ns glam.client.ui.admin-settings.core
  (:require [com.fulcrologic.fulcro.components :refer [defsc]]
            [com.fulcrologic.fulcro.components :as c]
            [glam.models.session :as sn]
            [glam.client.router :as r]
            [glam.client.ui.material-ui :as mui]))

(defsc AdminSettings [this {:keys [] :as props}]
  {:ident         (fn [_] [:component/id :admin-settings])
   :query         [sn/session-join]
   :initial-state {}
   :route-segment (r/route-segment :admin-settings)}
  (when (and (sn/valid-session? props) (sn/admin? props))
    (mui/page-container
      "foo")))
