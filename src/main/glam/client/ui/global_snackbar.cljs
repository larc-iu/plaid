(ns glam.client.ui.global-snackbar
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [glam.client.ui.material-ui :as mui]
            [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [taoensso.timbre :as log]
            ["@material-ui/core/Grow" :default Grow]))

(def ident [:component/id :global-snackbar])

;; TODO: if another message comes in while a previous message is still displayed the
;; counter doesn't get reset
(defmutation snackbar-update [{:keys [open severity message] :as args}]
  (action [{:keys [state]}]
    (if open
      (swap! state (fn [s]
                     (-> s
                         (assoc-in (conj ident :open) true)
                         (assoc-in (conj ident :severity) severity)
                         (assoc-in (conj ident :message) message))))
      (swap! state (fn [s]
                     (-> s
                         (assoc-in (conj ident :open) false)))))))

(defn close! [this]
  (c/transact! this [(snackbar-update {:open     false
                                       :severity "info"
                                       :message  ""})]))

(def snackbar-ref (atom nil))
(defn message!
  "Make a new snackbar notification. Arguments: :message and :severity,
  one of [error warning info success]"
  ([args]
   (message! @snackbar-ref args))
  ([this args]
   (c/transact! this [(snackbar-update (merge {:severity "info"} args {:open true}))])))

(defsc GlobalSnackbar [this {:keys [open severity message] :as props}]
  {:ident         (fn [_] ident)
   :query         [:open :severity :message]
   :initial-state (fn [_] {:open     false
                           :severity "success"
                           :message  ""})
   :componentDidMount #(reset! snackbar-ref %)}
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
