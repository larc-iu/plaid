(ns glam.server.crux
  (:require [crux.api :as crux]
            [mount.core :refer [defstate]]
            [glam.crux.easy :refer [install-tx-fns!]]
            [glam.server.config :refer [config]]
            [clojure.java.io :as io])
  (:import [crux.api ICruxAPI]
           (java.io StringWriter)))

(defn ^ICruxAPI start-lmdb-node [{:keys [db-dir http-server-port]}]
  (let [dirf #(.getPath (io/file db-dir %))]
    (crux/start-node
      (-> {:crux/tx-log         {:kv-store {:crux/module `crux.lmdb/->kv-store, :db-dir (dirf "tx-log")}}
           :crux/document-store {:kv-store {:crux/module `crux.lmdb/->kv-store, :db-dir (dirf "docs")}}
           :crux/index-store    {:kv-store {:crux/module `crux.lmdb/->kv-store, :db-dir (dirf "indexes")}}}
          (cond-> http-server-port (assoc :crux.http-server/server {:port http-server-port}))))))

(defn start-main-lmdb-node []
  (start-lmdb-node {:db-dir           (-> config ::config :main-db-dir)
                    :http-server-port (-> config ::config :http-server-port)}))

(defn start-session-lmdb-node []
  (start-lmdb-node {:db-dir (-> config ::config :session-db-dir)}))

;; (defn setup-listener! [node]
;;   (crux/listen
;;     node
;;     {:crux/event-type :crux/indexed-tx, :with-tx-ops? true}
;;     (fn [ev]
;;       (let [out (StringWriter.)]
;;         (clojure.pprint/pprint ev out)
;;         (println
;;           (str
;;             "\nevent received!\n\n"
;;             (.toString out)
;;             "\n\n\n")))
;;       (when (:committed? ev)
;;         (println (-> ev :crux/tx-ops first second type))
;;         (println (-> ev :crux/tx-ops first second))
;;        ))))

(defstate crux-node
  :start (let [node (start-main-lmdb-node)]
           (install-tx-fns! node)
           ;; TODO: keep going with this for websocket sync
           ;; (setup-listener! node)
           node)
  :stop (.close crux-node))

(defstate crux-session-node
  :start (let [node (start-session-lmdb-node)]
           node)
  :stop (.close crux-session-node))
