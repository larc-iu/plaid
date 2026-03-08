(ns user
  (:require [clojure.tools.namespace.repl :as tools-ns]
            [expound.alpha :as expound]
            [plaid.server.xtdb]
            [mount.core :as mount]
            [taoensso.timbre :as log]
            [plaid.xtdb2.user :as usr]
            [plaid.xtdb2.project :as prj]
            [plaid.xtdb2.document :as doc]
            [plaid.xtdb2.text-layer :as txtl]
            [plaid.xtdb2.text :as txt]
            [plaid.xtdb2.token-layer :as tokl]
            [plaid.xtdb2.token :as tok]
            [plaid.xtdb2.span-layer :as sl]
            [plaid.xtdb2.span :as s]
            [plaid.xtdb2.relation-layer :as rl]
            [plaid.xtdb2.relation :as r]
            [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.audit :as pxa]
            [xtdb.api :as xt]))

;; ==================== SERVER ====================
(tools-ns/set-refresh-dirs "src/main" "src/dev" "src/test")
(log/set-min-level! :debug)

;; Change the default output of spec to be more readable
;; (alter-var-root #'s/*explain-out* (constantly expound/printer))


(defn start-internal "Start the web server + services" []
  (let [result (mount/start)]
    (def node plaid.server.xtdb/xtdb-node)
    result))

(defn stop "Stop the web server + services" []
  (mount/stop))

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
  (def xt-map {:node node})

  ;; Find a project
  (def prj-id (:xt/id (first (pxc/find-entities node :projects {:project/name '_}))))
  prj-id

  ;; Browse audit log
  (mapv
    #(->> %
          :audit/ops
          first
          (pxc/entity node :operations))
    (pxc/find-entities node :audits {:audit/id '_}))

  (mapv
    #(-> % :audit/ops first :op/description)
    (pxa/get-project-audit-log node prj-id))

  ;; Create a full layer stack
  (do
    (def prj-id (:extra (prj/create xt-map {:project/name "temporary"})))
    (def txtl-id-1 (:extra (txtl/create xt-map {:text-layer/name "layer1"} prj-id nil)))
    (def txtl-id-2 (:extra (txtl/create xt-map {:text-layer/name "layer2"} prj-id nil)))

    (def tokl-id-1 (:extra (tokl/create xt-map {:token-layer/name "tokl1"} txtl-id-1 nil)))
    (def tokl-id-2 (:extra (tokl/create xt-map {:token-layer/name "tokl2"} txtl-id-1 nil)))

    (def sl-id-1 (:extra (sl/create xt-map {:span-layer/name "sl1"} tokl-id-1 nil)))
    (def rl-id-1 (:extra (rl/create xt-map {:relation-layer/name "rl1"} sl-id-1 nil)))

    (prj/get node prj-id))

  (txtl/get node txtl-id-1)
  (tokl/get node tokl-id-1)

  (txtl/shift-text-layer xt-map txtl-id-2 false nil)
  (txtl/delete xt-map txtl-id-1 nil)
  (tokl/delete xt-map tokl-id-1 nil)
  (prj/delete xt-map prj-id nil)
  (prj/get node prj-id)

  )
