(ns glam.client.ui.document.common
  (:require [glam.client.ui.material-ui :as mui]))


(defn inline-span [body token?]
  (mui/box {:style      (cond-> {:display       "inline-block"
                                 :border-radius (if token? "3px" "0px")
                                 :white-space   "pre"}
                                token? (merge {:border "1px solid black"})
                                (not token?) (merge {:border-bottom "1px dotted black"}))
            :fontFamily "Monospace"}
           body))
