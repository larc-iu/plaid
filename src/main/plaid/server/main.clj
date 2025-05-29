(ns plaid.server.main
  (:require [mount.core :as mount]
            [plaid.server.http-server])
  (:gen-class))

(defn -main [& args]
  (println "args: " args)
  (mount/start-with-args {:config "config/prod.edn"}))
