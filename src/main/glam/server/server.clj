(ns glam.server.server
  (:require
    [clojure.pprint :refer [pprint]]
    [io.pedestal.http :as http]
    [mount.core :refer [defstate]]
    [com.fulcrologic.fulcro.server.api-middleware :refer [not-found-handler]]
    [com.fulcrologic.fulcro.networking.websockets :as fws]
    [glam.server.config :refer [config]]
    [glam.server.service :as service]
    [taoensso.timbre :as log]))

;; https://github.com/ptaoussanis/sente/blob/master/src/taoensso/sente/server_adapters/jetty9.clj
;; https://github.com/pedestal/pedestal/blob/master/jetty/src/io/pedestal/http/jetty/websockets.clj
;; https://github.com/pedestal/pedestal/blob/master/samples/jetty-web-sockets/src/jetty_web_sockets/service.clj
;; https://github.com/fulcrologic/fulcro-websockets/blob/develop/src/main/com/fulcrologic/fulcro/networking/websocket_remote.cljc

(defstate http-server
  :start
  (let [pedestal-config (::http/config config)
        service (merge (service/make-service-map) pedestal-config)
        port (::http/port pedestal-config)]
    (when (nil? port)
      (throw (Exception. "You must set a port as the environment variable PORT.")))
    (log/info "Final service config: ")
    (pprint service)
    (log/info "Starting server on port" port)
    (-> service http/create-server http/start))

  :stop
  (http/stop http-server))
