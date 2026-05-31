(ns plaid.server.config
  (:require [clojure.edn :as edn]
            [clojure.java.io :as io]
            [mount.core :refer [defstate args]]
            [taoensso.timbre :as log]))

(defn- deep-merge [a b]
  (cond
    (nil? b) a
    (and (map? a) (map? b)) (merge-with deep-merge a b)
    :else b))

(defn- read-edn-resource
  "Read EDN from `path`, trying the classpath first (via `io/resource`) and
   falling back to the filesystem (via `io/file`). Returns the parsed EDN, or
   nil if `path` resolves to nothing on the classpath OR on disk."
  [path]
  (when path
    (if-let [r (io/resource path)]
      (edn/read-string (slurp r))
      (let [f (io/file path)]
        (when (.exists f)
          (edn/read-string (slurp f)))))))

(defn load-config!
  "Load config/defaults.edn from the classpath and deep-merge the env-specific
   file at `config-path` on top of it. `config-path` is resolved against the
   classpath first, then the filesystem (so operators can pass an absolute or
   relative filesystem path, e.g. --config /etc/plaid/prod.edn).

   When `explicit?` is true (the operator explicitly passed --config) and the
   path resolves to nothing, throws ex-info naming the path instead of silently
   degrading to defaults. When `explicit?` is false (the default path), a
   missing overlay is tolerated and defaults are used as-is."
  [{:keys [config-path explicit?]}]
  (let [defaults (read-edn-resource "config/defaults.edn")
        overlay (read-edn-resource config-path)]
    (when (and explicit? (nil? overlay))
      (throw (ex-info (str "Config file not found: " config-path
                           " (resolved neither on the classpath nor on the filesystem)")
                      {:config-path config-path})))
    (deep-merge defaults overlay)))

(defn configure-logging! [config]
  (let [{:keys [taoensso.timbre/logging-config]} config]
    (log/info "Configuring Timbre with " logging-config)
    (log/merge-config! logging-config)))

(defstate config
  :start (let [{:keys [config]} (args)
               explicit? (some? config)
               config-path (or config "config/dev.edn")
               configuration (load-config! {:config-path config-path
                                            :explicit? explicit?})]
           (configure-logging! configuration)
           (log/info "Loaded config" config-path)
           (log/info (pr-str configuration))
           configuration))
