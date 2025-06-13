(ns user
  (:require [clojure.tools.namespace.repl :as tools-ns]
            [expound.alpha :as expound]
            [plaid.server.xtdb]
            [mount.core :as mount]
            [taoensso.timbre :as log]
            [plaid.xtdb.user :as usr]
            [plaid.xtdb.project :as prj]
            [plaid.xtdb.document :as doc]
            [plaid.xtdb.text-layer :as txtl]
            [plaid.xtdb.text :as txt]
            [plaid.xtdb.token-layer :as tokl]
            [plaid.xtdb.token :as tok]
            [plaid.xtdb.span-layer :as sl]
            [plaid.xtdb.span :as s]
            [plaid.xtdb.relation-layer :as rl]
            [plaid.xtdb.relation :as r]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.audit :as pxa]
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
  (def prj-id (:project/id (pxc/find-entity (xt/db node) {:project/name '_})))
  prj-id

  (mapv
    #(->> %
          :audit/ops
          first
          (xt/entity (xt/db node))
          #_:op/description)
    (pxc/find-entities (xt/db node) {:audit/id '_}))

  (mapv
    #(-> % :audit/ops first :op/description)
    (pxa/get-project-audit-log (xt/db node) prj-id))

  )


(comment

  (do
    (prn (pxc/find-entities (xt/db node) {:project/name "temporary"}))
    (prn (pxc/find-entities (xt/db node) {:text-layer/id '_}))
    (prn (pxc/find-entities (xt/db node) {:token-layer/id '_}))
    (prn (pxc/find-entities (xt/db node) {:span-layer/id '_}))
    (prn (pxc/find-entities (xt/db node) {:relation-layer/id '_})))

  (def x
    (reduce into [(pxc/find-entities (xt/db node) {:project/name "temporary"})
                  (pxc/find-entities (xt/db node) {:text-layer/id '_})
                  (pxc/find-entities (xt/db node) {:token-layer/id '_})
                  (pxc/find-entities (xt/db node) {:span-layer/id '_})
                  (pxc/find-entities (xt/db node) {:relation-layer/id '_})]))

  (->> x
       (mapv :xt/id x)
       (mapv (fn [x] [::xt/delete x]))
       (pxc/submit! node))

  (do
    (def xt-map {:node node})
    (def prj-id (:extra (prj/create xt-map {:project/name "temporary"})))
    (def txtl-id-1 (:extra (txtl/create xt-map {:text-layer/name "layer1"} prj-id)))
    (def txtl-id-2 (:extra (txtl/create xt-map {:text-layer/name "layer2"} prj-id)))

    (def tokl-id-1 (:extra (tokl/create xt-map {:token-layer/name "tokl1"} txtl-id-1)))
    (def tokl-id-2 (:extra (tokl/create xt-map {:token-layer/name "tokl2"} txtl-id-1)))

    (def sl-id-1 (:extra (sl/create xt-map {:span-layer/name "sl1"} tokl-id-1)))
    (def rl-id-1 (:extra (rl/create xt-map {:relation-layer/name "rl1"} sl-id-1)))

    (prj/get node prj-id))

  (txtl/get node txtl-id-1)
  (tokl/get node tokl-id-1)

  (txtl/shift-text-layer xt-map prj-id txtl-id-2 false)

  (txtl/delete xt-map txtl-id-1)

  (tokl/delete xt-map tokl-id-1)
  (tokl/delete xt-map tokl-id-2)

  (prj/delete xt-map prj-id)

  (prj/get node prj-id)


  (let [x (-> node
              xt/db
              (xt/with-tx [[::xt/put {:xt/id "foo"}]])
              (xt/with-tx [[::xt/put {:xt/id "bar"}]]))]
    (pxc/entity x "foo"))

  )



(comment
  (def user-id (pxc/find-entity (xt/db node) {:user/id "a@b.com"}))

  (defn -print-all- []
    (prn (pxc/find-entities (xt/db node) {:project/name '_}))
    (prn (pxc/find-entities (xt/db node) {:document/id '_}))
    (prn (pxc/find-entities (xt/db node) {:text-layer/id '_}))
    (prn (pxc/find-entities (xt/db node) {:text/id '_}))
    (prn (pxc/find-entities (xt/db node) {:token-layer/id '_}))
    (prn (pxc/find-entities (xt/db node) {:token/id '_}))
    (prn (pxc/find-entities (xt/db node) {:span-layer/id '_}))
    (prn (pxc/find-entities (xt/db node) {:span/id '_}))
    (prn (pxc/find-entities (xt/db node) {:relation-layer/id '_}))
    (prn (pxc/find-entities (xt/db node) {:relation/id '_})))

  (defn -delete-all- []
    (->> (reduce into [(pxc/find-entities (xt/db node) {:project/name "temporary"})
                       (pxc/find-entities (xt/db node) {:document/id '_})
                       (pxc/find-entities (xt/db node) {:text-layer/id '_})
                       (pxc/find-entities (xt/db node) {:text/id '_})
                       (pxc/find-entities (xt/db node) {:token-layer/id '_})
                       (pxc/find-entities (xt/db node) {:token/id '_})
                       (pxc/find-entities (xt/db node) {:span-layer/id '_})
                       (pxc/find-entities (xt/db node) {:span/id '_})
                       (pxc/find-entities (xt/db node) {:relation-layer/id '_})
                       (pxc/find-entities (xt/db node) {:relation/id '_})])
         (mapv :xt/id)
         (mapv (fn [x] [::xt/delete x]))
         (pxc/submit! node)))

  (do
    (def xt-map {:node node})
    (def prj-id (:extra (prj/create xt-map {:project/name "temporary"})))
    (def txtl-id-1 (:extra (txtl/create xt-map {:text-layer/name "layer1"} prj-id) user-id))
    (def txtl-id-2 (:extra (txtl/create xt-map {:text-layer/name "layer2"} prj-id) user-id))

    (def tokl-id-1 (:extra (tokl/create xt-map {:token-layer/name "tokl1"} txtl-id-1) user-id))
    (def tokl-id-2 (:extra (tokl/create xt-map {:token-layer/name "tokl2"} txtl-id-1) user-id))

    (def sl-id-1 (:extra (sl/create xt-map {:span-layer/name "sl1"} tokl-id-1) user-id))
    (def rl-id-1 (:extra (rl/create xt-map {:relation-layer/name "rl1"} sl-id-1) user-id))

    (def doc-id (:extra (doc/create xt-map {:document/name "doc1" :document/project prj-id}) user-id))

    (def text-id (:extra (txt/create xt-map {:text/body     "foo bar baz"
                                             :text/document doc-id
                                             :text/layer    txtl-id-1}) user-id))

    (def tok1-id (:extra (tok/create xt-map {:token/begin 0
                                             :token/end   3
                                             :token/text  text-id
                                             :token/layer tokl-id-1}) user-id))
    (def tok2-id (:extra (tok/create xt-map {:token/begin 0
                                             :token/end   7
                                             :token/text  text-id
                                             :token/layer tokl-id-1}) user-id))
    (def tok3-id (:extra (tok/create xt-map {:token/begin 4
                                             :token/end   7
                                             :token/text  text-id
                                             :token/layer tokl-id-1}) user-id))

    (def s1-id (:extra (s/create xt-map {:span/tokens [tok1-id tok2-id]
                                         :span/value  "span 1"
                                         :span/layer  sl-id-1}) user-id))
    (def s2-id (:extra (s/create xt-map {:span/tokens [tok3-id]
                                         :span/value  "span 2"
                                         :span/layer  sl-id-1}) user-id))

    (def r1-id (:extra (r/create xt-map {:relation/value  "relation1"
                                         :relation/source s1-id
                                         :relation/target s2-id
                                         :relation/layer  rl-id-1})) user-id))

  (doc/get-with-layer-data xt-map doc-id)

  (s/set-tokens xt-map s1-id [tok3-id])
  (s/get node s1-id)

  (prj/delete xt-map prj-id)

  (-delete-all-)

  (-print-all-)

  (tok/merge xt-map tok1-id {:token/end 2 :token/begin 0 :token/precedence nil})

  (tok/get node tok1-id)


  (let [token-ids (txt/get-token-ids (xt/db node) text-id)
        span-ids (mapcat #(tok/get-span-ids (xt/db node) %) token-ids)
        relation-ids (mapcat #(s/get-relation-ids (xt/db node) %) span-ids)]
    (reduce into [token-ids span-ids relation-ids]))


  (let [x (-> node
              xt/db
              (xt/with-tx [[::xt/put {:xt/id "foo"}]])
              (xt/with-tx [[::xt/put {:xt/id "bar"}]]))]
    (pxc/entity x "foo"))

  )