(ns plaid.server.xtdb
  (:require [taoensso.timbre :as log]
            [xtdb.api :as xt]
            [mount.core :refer [defstate]]
            [plaid.xtdb.common :as pxc]
            [plaid.server.config :refer [config]]
            [plaid.xtdb.user :as pxu])
  (:import [xtdb.api IXtdb]))

(defn ^IXtdb start-lmdb-node [{:keys [db-dir use-inspector]}]
  (let [dirf #(str db-dir "/" %)]
    (xt/start-node
     (-> {:xtdb/tx-log {:kv-store {:xtdb/module `xtdb.lmdb/->kv-store, :db-dir (dirf "tx-log")}}
          :xtdb/document-store {:kv-store {:xtdb/module `xtdb.lmdb/->kv-store, :db-dir (dirf "docs")}}
          :xtdb/index-store {:kv-store {:xtdb/module `xtdb.lmdb/->kv-store, :db-dir (dirf "indexes")}}}
         (cond-> use-inspector (assoc :xtdb-inspector.metrics/reporter {}))))))

(defn start-main-lmdb-node []
  (start-lmdb-node {:db-dir (-> config ::config :main-db-dir)
                    :http-server-port (-> config ::config :http-server-port)}))

(defstate xtdb-node
  :start (let [node (start-main-lmdb-node)]
           (when (and (empty? (pxc/find-entities (xt/db node) [[:user/id '_]]))
                      (not (System/getenv "SKIP_ACCOUNT_CREATION_PROMPT")))
             (log/warn "No users detected! Prompting you for credentials...")
             (if-let [console (System/console)]
               (let [_ (do (print "Enter email: ") (flush))
                     email (String. (.readLine console))
                     _ (do (print "Enter password: ") (flush))
                     password (String. (.readPassword console))
                     {:keys [success]} (pxu/create {:node node} email true password)]
                 (if success
                   (log/info (str "Admin user created with email " email ". To reset the server "
                                  "AND LOSE ALL DATA, you can remove all files at `"
                                  (-> config ::config :main-db-dir) "`."))
                   (do (log/error (str "Error creating first user!"))
                       (System/exit 1))))
               (let [_ (do (print "Enter email: ") (flush))
                     email (read-line)
                     _ (do (print "Enter password: ") (flush))
                     password (read-line)
                     {:keys [success]} (pxu/create {:node node} email true password)]
                 (if success
                   (log/info (str "Admin user created with email " email ". To reset the server "
                                  "AND LOSE ALL DATA, you can remove all files at `"
                                  (-> config ::config :main-db-dir) "`."))
                   (do (log/error (str "Error creating first user!"))
                       (System/exit 1))))))
           node)
  :stop (.close xtdb-node))
