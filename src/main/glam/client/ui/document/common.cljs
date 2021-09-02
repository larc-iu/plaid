(ns glam.client.ui.document.common
  (:require [glam.client.ui.material-ui :as mui]
            [com.fulcrologic.fulcro.dom :as dom]))


(defn inline-span [key body token?]
  (dom/div {:style (cond-> {:display      "inline-block"
                            :borderRadius (if token? "3px" "0px")
                            :whiteSpace   "pre"
                            :fontFamily   "monospace"}
                           token? (merge {:border "1px solid black"})
                           (not token?) (merge {:borderBottom "1px dotted black"}))
            :key   key}
    body))
