(ns glam.server.crux
  (:require [crux.api :as crux]
            [mount.core :refer [defstate]])
  (:import [crux.api ICruxAPI]))

(defn ^ICruxAPI start-jdbc-sqlite-node []
  (crux/start-node
    {:crux.node/topology '[crux.jdbc/topology]
     :crux.jdbc/dbtype   "sqlite"
     :crux.jdbc/dbname   "glam_db.sqlite"}))

(defstate crux-node
  :start (start-jdbc-sqlite-node)
  :stop (.close crux-node))
