(ns plaid.rest-api.v1.info
  "What a client has to know about this server before it acts.

  Every limit here is enforced somewhere else and, until now, was learnable
  only by exceeding it. That is fine for a script and bad for a person: a
  browser cannot tell someone their recording is too large until it has spent
  ten minutes uploading it. Clients read this once and can then say what will
  happen before it happens.

  Unauthenticated on purpose. These are the shape of the API, not secrets, and
  a client needs them before it has a session to ask with."
  (:require [plaid.rest-api.v1.batch :as batch]
            [plaid.rest-api.v1.metadata :as metadata]
            [plaid.server.config :refer [config]]
            [plaid.sql.user-data :as user-data]))

(defn- mb->bytes [mb]
  (when (number? mb) (* mb 1024 1024)))

(defn limits
  "Server-enforced limits, in the units a client would compare against.

  A limit that this server's configuration does not set is left OUT rather
  than reported as null: a client reads the absence as \"unknown\" and falls
  back to acting and being refused, which is what it did before this existed.
  Reporting the shape of the config is not worth failing the request over."
  []
  (into (sorted-map)
        (remove (comp nil? val))
        {:media-file-bytes       (mb->bytes (-> config :plaid.media/config :max-file-size-mb))
         :json-body-bytes        (mb->bytes (-> config :plaid.server.http-server :max-json-body-mb))
         :batch-operations       batch/max-batch-ops
         :metadata-depth         metadata/max-metadata-depth
         :metadata-key-count     metadata/max-metadata-key-count
         :metadata-string-length metadata/max-metadata-string-length
         :metadata-total-bytes   metadata/max-metadata-total-bytes
         :user-data-value-bytes  user-data/max-value-bytes}))

(def info-routes
  [["/info"
    {:get {:summary (str "Limits this server enforces, so a client can say what will happen "
                         "before it happens rather than after a request is refused. Sizes are "
                         "in bytes. No authentication: a client needs these before it has a "
                         "session to ask with.")
           :handler (fn [_]
                      {:status 200
                       :body   {:limits (limits)}})}}]])
