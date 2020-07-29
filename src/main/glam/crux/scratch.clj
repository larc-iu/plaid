(ns glam.crux.scratch
  (:require [crux.api :as crux]
            [glam.crux.common :as gc]
            [glam.crux.user :as user]
            [taoensso.timbre :as log])
  )

(comment
  (def node
    (crux/start-node
      {:crux.node/topology                 :crux.standalone/topology
       :crux.node/kv-store                 "crux.kv.memdb/kv"
       :crux.standalone/event-log-dir      "data/eventlog-1"
       :crux.kv/db-dir                     "data/db-dir-1"
       :crux.standalone/event-log-kv-store "crux.kv.memdb/kv"}))

  (def node glam.server.crux/crux-node)

  (crux/listen node {:crux/event-type :crux/indexed-tx, :with-tx-ops? true}
               (fn [ev]
                 (println "event received!")
                 (clojure.pprint/pprint ev)))

  (crux/latest-completed-tx node)
  (crux/latest-submitted-tx node)

  ;; users
  (user/create node {:name "a" :email "foo" :password-hash "qwe"})
  (user/create node {:name "b" :email "foo" :password-hash "qwe"})

  (user/get-all node)
  (gc/find-entities node {:crux.db/id '_})

  (let [user (first (user/get-all node))]
    #_(crux/submit-tx node [[:crux.tx/delete (:user/id user)]])
    (user/set-email node (:user/id user) "qwe")
    user
    )

  (user/set-email node :foo "qweqwe")

  )





