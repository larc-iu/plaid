(ns plaid.server.config
  (:require [clojure.edn :as edn]
            [clojure.java.io :as io]
            [mount.core :refer [defstate args]]
            [taoensso.timbre :as log]))

(defn- deep-merge [a b]
  (if (and (map? a) (map? b))
    (merge-with deep-merge a b)
    b))

(defn- read-edn-resource [path]
  (when-let [r (io/resource path)]
    (edn/read-string (slurp r))))

(defn load-config!
  "Load config/defaults.edn from the classpath and deep-merge the env-specific
   file at `config-path` (also classpath-relative) on top of it."
  [{:keys [config-path]}]
  (deep-merge (read-edn-resource "config/defaults.edn")
              (read-edn-resource config-path)))

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
