(ns glam.server.crux
  (:require [crux.api :as crux]
            [mount.core :refer [defstate]]
            [glam.crux.easy :refer [install-tx-fns!]]
            [glam.server.config :refer [config]]
            [clojure.java.io :as io])
  (:import [crux.api ICruxAPI]))

(defn ^ICruxAPI start-lmdb-node [{:keys [db-dir http-server-port]}]
  (let [dirf #(.getPath (io/file db-dir %))]
    (crux/start-node
      (-> {:crux/tx-log         {:kv-store {:crux/module `crux.lmdb/->kv-store, :db-dir (dirf "tx-log")}}
           :crux/document-store {:kv-store {:crux/module `crux.lmdb/->kv-store, :db-dir (dirf "docs")}}
           :crux/index-store    {:kv-store {:crux/module `crux.lmdb/->kv-store, :db-dir (dirf "indexes")}}}
          (cond-> http-server-port (assoc :crux.http-server/server {:port http-server-port}))))))

(defn start-main-lmdb-node []
  (start-lmdb-node {:db-dir (-> config ::config :main-db-dir)}))

(defn start-session-lmdb-node []
  (start-lmdb-node {:db-dir           (-> config ::config :session-db-dir)
                    :http-server-port (-> config ::config :http-server-port)}))

(defstate crux-node
  :start (let [node (start-main-lmdb-node)]
           (install-tx-fns! node)
           node)
  :stop (.close crux-node))

(defstate crux-session-node
  :start (let [node (start-session-lmdb-node)]
           (install-tx-fns! node)
           node)
  :stop (.close crux-session-node))