(ns user
  (:require [clojure.tools.namespace.repl :as tools-ns]
            [expound.alpha :as expound]
            [nrepl.server :as nrepl]
            [plaid.server.sql]
            [mount.core :as mount]
            [taoensso.timbre :as log]
            [plaid.sql.user :as usr]
            [plaid.sql.project :as prj]
            [plaid.sql.document :as doc]
            [plaid.sql.text-layer :as txtl]
            [plaid.sql.text :as txt]
            [plaid.sql.token-layer :as tokl]
            [plaid.sql.token :as tok]
            [plaid.sql.span-layer :as sl]
            [plaid.sql.span :as s]
            [plaid.sql.relation-layer :as rl]
            [plaid.sql.relation :as r]
            [plaid.sql.common :as psc]
            [plaid.sql.audit :as pxa]))

;; ==================== SERVER ====================
(tools-ns/set-refresh-dirs "src/main" "src/dev" "src/test")
(log/set-min-level! :debug)

(defonce ^:private nrepl-server (atom nil))

(defn- start-nrepl!
  "Start an nREPL server on port 7888 (matches the :nrepl alias) and
  write its port to plaid-core/.nrepl-port for clj-nrepl-eval / editor
  integration. Idempotent: a second call is a no-op."
  []
  (when-not @nrepl-server
    (let [srv (nrepl/start-server :port 7888 :bind "127.0.0.1")]
      (spit ".nrepl-port" (str (:port srv)))
      (reset! nrepl-server srv)
      (log/info "nREPL listening on" (:port srv)))))

(defn- stop-nrepl! []
  (when-let [srv @nrepl-server]
    (nrepl/stop-server srv)
    (reset! nrepl-server nil)
    (try (.delete (java.io.File. ".nrepl-port")) (catch Exception _))))

(defn start-internal "Start the web server + services" []
  (start-nrepl!)
  ;; Dev loads the classpath overlay config.dev.toml (debug logging + history
  ;; on) on top of the bundled defaults; nothing is written to data/.
  (let [result (mount/start-with-args {:config "config.dev.toml"})]
    (def db plaid.server.sql/datasource)
    result))

(defn stop "Stop the web server + services" []
  (mount/stop)
  (stop-nrepl!))

(defn start
  "Stop, reload code, and restart the server. If there is a compile error, use:
  ```
  (tools-ns/refresh)
  ```
  to recompile, and then use `start` once things are good."
  ([]
   (stop)
   (tools-ns/refresh :after 'user/start-internal))
  ([_] (start)))

(comment
  ;; Browse audit log for the first project we can find
  (def prj-id (-> (psc/q1 db {:select [:id] :from [:projects] :limit 1}) :id))
  (mapv :op/description (pxa/get-project-audit-log db prj-id))

  ;; Create a full layer stack
  (do
    (def prj-id (:extra (prj/create db {:project/name "temporary"} nil)))
    (def txtl-id-1 (:extra (txtl/create db {:text-layer/name "layer1"} prj-id nil)))
    (def txtl-id-2 (:extra (txtl/create db {:text-layer/name "layer2"} prj-id nil)))

    (def tokl-id-1 (:extra (tokl/create db {:token-layer/name "tokl1"} txtl-id-1 nil)))
    (def tokl-id-2 (:extra (tokl/create db {:token-layer/name "tokl2"} txtl-id-1 nil)))

    (def sl-id-1 (:extra (sl/create db {:span-layer/name "sl1"} tokl-id-1 nil)))
    (def rl-id-1 (:extra (rl/create db {:relation-layer/name "rl1"} sl-id-1 nil)))

    (prj/get db prj-id))

  (txtl/get db txtl-id-1)
  (tokl/get db tokl-id-1)

  (txtl/shift-text-layer db txtl-id-2 false nil)
  (txtl/delete db txtl-id-1 nil)
  (tokl/delete db tokl-id-1 nil)
  (prj/delete db prj-id nil)
  (prj/get db prj-id))
