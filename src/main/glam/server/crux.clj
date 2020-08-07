(ns glam.server.crux
  (:require [crux.api :as crux]
            [mount.core :refer [defstate]]
            [glam.crux.easy :refer [install-tx-fns]]
            [glam.server.config :refer [config]]
            [clojure.java.io :as io])
  (:import [crux.api ICruxAPI]))


(defn ^ICruxAPI start-lmdb-node [{:keys [event-log-dir db-dir]}]
  (crux/start-node
    {:crux.node/topology                 '[crux.standalone/topology
                                           crux.kv.lmdb/kv-store]
     :crux.standalone/event-log-kv-store 'crux.kv.lmdb/kv
     :crux.standalone/event-log-dir      (io/file event-log-dir)
     :crux.kv/db-dir                     (io/file db-dir)}))

(defn start-main-lmdb-node []
  (start-lmdb-node {:event-log-dir (-> config ::config :event-log-dir)
                    :db-dir        (-> config ::config :db-dir)}))

(defn start-session-lmdb-node []
  (start-lmdb-node {:event-log-dir (-> config ::config :session :event-log-dir)
                    :db-dir        (-> config ::config :session :db-dir)}))

(defstate crux-node
  :start (let [node (start-main-lmdb-node)]
           ;;(install-tx-fns node '[glam.crux.user])
           node)
  :stop (.close crux-node))

(defstate crux-session-node
  :start (start-session-lmdb-node)
  :stop (.close crux-session-node))