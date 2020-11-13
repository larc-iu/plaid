(ns glam.client.core
  (:require
    [com.fulcrologic.fulcro.application :as app]
    [com.fulcrologic.fulcro.components :as comp]
    [com.fulcrologic.fulcro.ui-state-machines :as uism]
    [clojure.edn :as edn]
    [glam.client.ui.root :as root]
    [glam.client.application :refer [SPA]]
    [glam.client.router :as router]
    [glam.client.ui.login :refer [Login]]
    [glam.models.session :refer [Session]]
    [glam.models.session :as session]
    [shadow.resource :as rc]
    [taoensso.timbre :as log]
    [com.fulcrologic.fulcro.data-fetch :as df]))

;; set logging lvl using goog-define, see shadow-cljs.edn
(goog-define LOG_LEVEL "warn")

(def fe-config (edn/read-string (rc/inline "/config/fe-config.edn")))
(log/info "Log level is: " LOG_LEVEL)

(def log-config
  (merge
    (-> fe-config ::config :logging)
    {:level (keyword LOG_LEVEL)}))

(defn ^:export refresh []
  (log/info "Hot code Remount")
  (log/merge-config! log-config)
  (comp/refresh-dynamic-queries! SPA)
  (app/mount! SPA root/Root "app"))

(defn ^:export init []
  (log/merge-config! log-config)
  (log/info "Application starting.")
  (app/set-root! SPA root/Root {:initialize-state? true})
  (log/info "Starting router.")
  (router/init! SPA)
  (log/info "Starting session machine.")
  (uism/begin! SPA session/session-machine ::session/session
               {:actor/login-form      Login
                :actor/current-session Session})
  (log/info "MOUNTING APP")
  (js/setTimeout #(app/mount! SPA root/Root "app" {:initialize-state? false}))

  )
