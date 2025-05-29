(ns plaid.server.xtdb
  (:require [plaid.xtdb.common :as pxc]
            [taoensso.timbre :as log]
            [xtdb.api :as xt]
            [mount.core :refer [defstate]]
            [plaid.server.config :refer [config]]
            [plaid.xtdb.user :as pxu]
            [plaid.xtdb.common :as pxc])
  (:import [xtdb.api IXtdb]))

(defn ^IXtdb start-lmdb-node [{:keys [db-dir use-inspector]}]
  (let [dirf #(str db-dir "/" %)]
    (xt/start-node
      (-> {:xtdb/tx-log         {:kv-store {:xtdb/module `xtdb.lmdb/->kv-store, :db-dir (dirf "tx-log")}}
           :xtdb/document-store {:kv-store {:xtdb/module `xtdb.lmdb/->kv-store, :db-dir (dirf "docs")}}
           :xtdb/index-store    {:kv-store {:xtdb/module `xtdb.lmdb/->kv-store, :db-dir (dirf "indexes")}}}
          (cond-> use-inspector (assoc :xtdb-inspector.metrics/reporter {}))))))

(defn start-main-lmdb-node []
  (start-lmdb-node {:db-dir           (-> config ::config :main-db-dir)
                    :http-server-port (-> config ::config :http-server-port)}))

(defstate xtdb-node
  :start (let [node (start-main-lmdb-node)]
           (when (empty? (pxc/find-entities (xt/db node) [[:user/id '_]]))
             (log/warn "No users detected! Prompting you for credentials...")
             (println "Enter email:")
             (let [email (read-line)]
               (println "Enter password:")
               (let [password (read-line)
                     {:keys [success]} (pxu/create {:node node} email true password)]
                 (if success
                   (log/info (str "Admin user created with email " email ". To reset the server "
                                  "AND LOSE ALL DATA, you can remove all files at "
                                  (-> config ::config :main-db-dir) "."))
                   (do (log/error (str "Error creating first user!"))
                       (System/exit 1))))))
           node)
  :stop (.close xtdb-node))
