(ns glam.client.ui.document.common
  (:require [glam.client.ui.material-ui :as mui]
            [com.fulcrologic.fulcro.dom :as dom]
            [taoensso.timbre :as log]))


(defn base-inline-span [extra-attrs extra-style body]
  (dom/div
    (merge
      {:style (merge {:display      "inline-block"
                      :borderRadius "0px"
                      :whiteSpace   "pre"
                      :fontFamily   "monospace"}
                     extra-style)}
      extra-attrs)
    body))

(defn inline-span [key body token?]
  (base-inline-span
    {:key key}
    (if token? {:borderRadius "3px"
                :border       "1px solid black"}
               {:borderBottom "1px dotted black"})
    body))
