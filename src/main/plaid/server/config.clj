(ns plaid.server.config
  (:require [mount.core :refer [defstate args]]
            [com.fulcrologic.fulcro.server.config :refer [load-config!]]
            [taoensso.timbre :as log]))

(defn configure-logging! [config]
  (let [{:keys [taoensso.timbre/logging-config]} config]
    (log/info "Configuring Timbre with " logging-config)
    (log/merge-config! logging-config)))

(defstate config
  :start (let [{:keys [config] :or {config "config/dev.edn"}} (args)
               configuration (load-config! {:config-path config})]
           (configure-logging! configuration)
           (log/info "Loaded config" config)
           (log/info (pr-str configuration))
           configuration))
