(ns glam.server.xtdb
  (:require [xtdb.api :as xt]
            [mount.core :refer [defstate]]
            [glam.xtdb.easy :refer [install-tx-fns!]]
            [glam.server.config :refer [config]]
            [clojure.java.io :as io])
  (:import [xtdb.api IXtdb]
           (java.io StringWriter)))

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

(defn start-session-lmdb-node []
  (start-lmdb-node {:db-dir (-> config ::config :session-db-dir)}))

;; (defn setup-listener! [node]
;;   (xt/listen
;;     node
;;     {:xt/event-type :xt/indexed-tx, :with-tx-ops? true}
;;     (fn [ev]
;;       (let [out (StringWriter.)]
;;         (clojure.pprint/pprint ev out)
;;         (println
;;           (str
;;             "\nevent received!\n\n"
;;             (.toString out)
;;             "\n\n\n")))
;;       (when (:committed? ev)
;;         (println (-> ev :xt/tx-ops first second type))
;;         (println (-> ev :xt/tx-ops first second))
;;        ))))

(defstate xtdb-node
  :start (let [node (start-main-lmdb-node)]
           (install-tx-fns! node)
           ;; TODO: keep going with this for websocket sync
           ;; (setup-listener! node)
           node)
  :stop (.close xtdb-node))

(defstate xtdb-session-node
  :start (let [node (start-session-lmdb-node)]
           node)
  :stop (.close xtdb-session-node))
