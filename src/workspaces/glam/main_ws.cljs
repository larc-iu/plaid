(ns glam.main-ws
  (:require
    [com.fulcrologic.fulcro.components :as c]
    [com.fulcrologic.fulcro.dom :as dom]
    [com.fulcrologic.fulcro.mutations :as fm]
    [nubank.workspaces.card-types.fulcro3 :as f3]
    [nubank.workspaces.core :as ws]))

(c/defsc FulcroDemo
  [this {:keys [counter]}]
  {:initial-state (fn [_] {:counter 0})
   :ident         (fn [] [::id :demo])
   :query         [:counter]}
  (dom/div
    (str "Fulcro counter demo [" counter "]")
    (dom/button
      {:onClick #(fm/set-value! this :counter (inc counter))}
      "+")))

(ws/defcard fulcro-demo-card
  (f3/fulcro-card
    {::f3/root       FulcroDemo
     ::f3/app        {}
     ::f3/wrap-root? true}))

(defn main [] (ws/mount))
