(ns glam.client.ui.common.core
  (:require [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.components :as c]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [com.fulcrologic.fulcro.mutations :as m]
            [com.fulcrologic.fulcro.ui-state-machines :as uism]
            [glam.client.ui.material-ui :as mui]
            [com.fulcrologic.fulcro.mutations :as m]))

(defn loader []
  (mui/box {:alignItems     "center"
            :justifyContent "center"
            :display        "flex"
            :minHeight      400}
    (mui/circular-progress {:size "6em"})))
