(ns plaid.server.http-server
  (:require [clojure.pprint :refer [pprint]]
            [mount.core :refer [defstate]]
            [org.httpkit.server :as http-kit]
            [plaid.server.config :refer [config]]
            [plaid.server.middleware :refer [middleware]]
            [plaid.server.events] ; Start the events system
            [taoensso.timbre :as log]))

;; https://github.com/ptaoussanis/sente/blob/master/src/taoensso/sente/server_adapters/jetty9.clj
;; https://github.com/pedestal/pedestal/blob/master/jetty/src/io/pedestal/http/jetty/websockets.clj
;; https://github.com/pedestal/pedestal/blob/master/samples/jetty-web-sockets/src/jetty_web_sockets/service.clj
;; https://github.com/fulcrologic/fulcro-websockets/blob/develop/src/main/com/fulcrologic/fulcro/networking/websocket_remote.cljc

(defstate http-server
  :start
  (let [http-kit-config (::http-kit/config config)
        media-config (:plaid.media/config config)
        max-file-size-mb (:max-file-size-mb media-config)
        max-body-bytes (* max-file-size-mb 1024 1024)
        http-kit-config-with-max-body (assoc http-kit-config :max-body max-body-bytes)
        port (:port http-kit-config-with-max-body)]
    (when (nil? port)
      (throw (Exception. "You must set a port as the environment variable PORT.")))
    (log/info "Starting server on port" port "with max body size" max-body-bytes "bytes")
    (let [stop-server (http-kit/run-server middleware http-kit-config-with-max-body)]
      (fn []
        (stop-server))))

  :stop
  (http-server))

