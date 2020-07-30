(ns glam.server.crux
  (:require [crux.api :as crux]
            [mount.core :refer [defstate]]
            [glam.crux.common :refer [install-tx-fns]])
  (:import [crux.api ICruxAPI]))

(defn ^ICruxAPI start-jdbc-sqlite-node []
  (crux/start-node
    {:crux.node/topology '[crux.jdbc/topology]
     :crux.jdbc/dbtype   "sqlite"
     :crux.jdbc/dbname   "glam.db"}))

(defstate crux-node
  :start (let [node (start-jdbc-sqlite-node)]
           (install-tx-fns node '[glam.crux.user])
           node)
  :stop (.close crux-node))
