(ns plaid.server.media-maintenance
  "Lifecycle-bound orphan cleanup for on-disk document media."
  (:require [mount.core :refer [defstate]]
            [plaid.media.storage :as media]
            [plaid.server.sql :refer [datasource]]))

(defstate media-maintenance
  :start (do
           (media/sweep-orphaned-media! datasource :startup)
           true)
  :stop (when datasource
          (media/sweep-orphaned-media! datasource :shutdown)))
