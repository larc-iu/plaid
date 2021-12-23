(ns glam.algos.subs
  (:require [taoensso.timbre :as log]))

(def ^:private subscriptions (atom {}))
(defn push-handler [{:keys [topic msg]}]
  (log/info topic msg)
  (when (= topic :glam/document-changed)
    (log/info "Executing subscription load")
    (doseq [[_ load-fn] (get @subscriptions msg)]
      (load-fn))))

(defn register-subscription! [ident load-fn]
  (let [sub-id (random-uuid)]
    (log/info "Registering subscription on" ident)
    (swap! subscriptions assoc-in [ident sub-id] load-fn)
    (fn unregister []
      (log/info "Unregistering subscription on" ident)
      (swap! subscriptions update ident dissoc sub-id))))
