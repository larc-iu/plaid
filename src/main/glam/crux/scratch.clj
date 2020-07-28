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
  (gc/find-entities node {:user/name '_})

  (gc/deftx set-email node
    [ctx user-id new-email]
    (when-let [user (crux.api/entity (crux.api/db ctx) user-id)]
      [[:crux.tx/put (assoc user :user/email new-email)]]))

  (macroexpand-1 '(gc/deftx set-email node
                    [ctx user-id new-email]
                    (when-let [user (crux.api/entity (crux.api/db ctx) user-id)]
                      [[:crux.tx/put (assoc user :user/email new-email)]])))

  (let [user (first (user/get-all node))]
    (println (:user/id user))
    (crux/await-tx node (set-email (:user/id user) "success! uwuxx"))
    (user/get-all node)
    )

  (macroexpand-1 '(gc/defsetter set-email node :user/email))
  (gc/defsetter set-email node :user/email)

  )





