(ns glam.client.ui.global-snackbar
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [glam.client.ui.material-ui :as mui]
            [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [taoensso.timbre :as log]
            ["@material-ui/core/Grow" :default Grow]))

(def ident [:component/id :global-snackbar])

(defmutation snackbar-update [{:keys [open severity message] :as args}]
  (action [{:keys [state]}]
    (swap! state (fn [s]
                   (-> s
                       (assoc-in (conj ident :open) open)
                       (assoc-in (conj ident :severity) severity)
                       (assoc-in (conj ident :message) message))))))

(defn close! [this]
  (c/transact! this [(snackbar-update {:open     false
                                       :severity "info"
                                       :message  ""})]))

(defn message! [this args]
  "Make a new snackbar notification. Arguments: :message and :severity,
  one of [error warning info success]"
  (c/transact! this [(snackbar-update (merge {:severity "info"} args {:open true}))]))

(defsc GlobalSnackbar [this {:keys [open severity message] :as props}]
  {:ident         (fn [_] ident)
   :query         [:open :severity :message]
   :initial-state (fn [_] {:open     false
                           :severity "success"
                           :message  ""})}
  (mui/snackbar {:anchorOrigin        {:vertical   "bottom"
                                       :horizontal "center"}
                 :open                open
                 :onClose             (fn [_ reason]
                                        (when-not (= reason "clickaway")
                                          ;; make sure we're closed before doing other things
                                          (m/set-value!! this :open false)
                                          (close! this)))
                 :autoHideDuration    5000
                 :TransitionComponent Grow}
    (mui/alert {:severity severity} message)))

(def ui-global-snackbar (c/factory GlobalSnackbar))
