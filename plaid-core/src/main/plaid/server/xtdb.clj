(ns plaid.server.xtdb
  (:require [taoensso.timbre :as log]
            [xtdb.api :as xt]
            [xtdb.node :as xtdb]
            [mount.core :refer [defstate]]
            [plaid.server.config :refer [config]]
            [plaid.xtdb2.operation-coordinator :as op-coord]
            [plaid.xtdb2.user :as pxu]))

(defn start-node [cfg]
  (let [db-dir (get-in cfg [::config :main-db-dir])
        pgwire-port (get-in cfg [::config :pgwire-port])
        base-opts (cond-> {}
                    pgwire-port (assoc :server {:port pgwire-port}))]
    (if db-dir
      (do (log/info "Starting XTDB node with local storage at" db-dir)
          (xtdb/start-node (merge base-opts
                                  {:log     [:local {:path (str db-dir "/log")}]
                                   :storage [:local {:path (str db-dir "/storage")}]})))
      (do (log/info "Starting XTDB node in-memory (no :main-db-dir configured)")
          (xtdb/start-node base-opts)))))

(defn make-admin-user [node]
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
        (do (log/error "Error creating first user!")
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
        (do (log/error "Error creating first user!")
            (System/exit 1))))))

(defn- await-ready
  "Block until the node has finished replaying its transaction log.
   A simple query with no snapshot-time waits for all committed txs to be indexed."
  [node]
  (log/info "Waiting for XTDB to finish indexing...")
  (xt/q node "SELECT 1")
  (log/info "XTDB ready."))

(defstate xtdb-node
  :start (let [node (start-node config)]
           (await-ready node)
           (op-coord/recover-crashed-batches! node)
           (when (and (empty? (pxu/get-all node))
                      (not (System/getenv "SKIP_ACCOUNT_CREATION_PROMPT")))
             (make-admin-user node))
           node)
  :stop (.close xtdb-node))
