(ns glam.devcards
  (:require
    [com.fulcrologic.fulcro.components :as c]
    [com.fulcrologic.fulcro.mutations :as fm]
    [devcards.core :as dc :refer (defcard)]))

(c/defsc FulcroDemo
  [this {:keys [counter]}]
  {:initial-state (fn [_] {:counter 0})
   :ident         (fn [] [::id "singleton"])
   :query         [:counter]}
  [:div
   (str "Fulcro counter demo [" counter "]")
   [:button {:on-click #(fm/set-value! this :counter (inc counter))} "+"]])

(f3/make-card FulcroDemo)

(defn ^:export main [] (dc/start-devcard-ui!))
