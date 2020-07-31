(ns glam.crux.scratch
  (:require [crux.api :as crux]
            [glam.crux.common :as gc]
            [glam.crux.user :as user]
            [taoensso.timbre :as log])
  )

(defn init [node]
  (let [admin-id
        (user/create
          node
          {:password-hash "100$12$argon2id$v13$u6JYj16Ize35J1uuTN6KwQ$SblXBBHdyMZ5K52RwCcO41/SNL6XqoY1JBouP/V01uQ$$$"
           :name          "admin"
           :email         "a@b.com"
           })]
    (user/set-admin? node admin-id true))
  (user/create
    node
    {:password-hash "100$12$argon2id$v13$u6JYj16Ize35J1uuTN6KwQ$SblXBBHdyMZ5K52RwCcO41/SNL6XqoY1JBouP/V01uQ$$$"
     :name          "user"
     :email         "b@b.com"})
  )

(comment
  (def node glam.server.crux/crux-node)
  (let [node glam.server.crux/crux-node]
    (glam.crux.scratch/init node))

  (user/get-by-email node "a@a.com")
  (user/get-by-email node "a@b.com")
  (user/get-by-email node "b@b.com")

  (user/create node {:name "a" :email "a@a.com" :password-hash "qwe"})
  (user/create node {:name "b" :email "b@b.com" :password-hash "qwe"})

  (user/get-all node)
  (gc/find-entities node {:user/id '_})
  (crux/await-tx node (user/set-admin? node (:user/id (user/get-by-email node "a@b.com")) true))

  (def node
    (crux/start-node
      {:crux.node/topology                 :crux.standalone/topology
       :crux.node/kv-store                 "crux.kv.memdb/kv"
       :crux.standalone/event-log-dir      "data/eventlog-1"
       :crux.kv/db-dir                     "data/db-dir-1"
       :crux.standalone/event-log-kv-store "crux.kv.memdb/kv"}))
  (gc/install-tx-fns node '[glam.crux.user])

  (crux/listen node {:crux/event-type :crux/indexed-tx, :with-tx-ops? true}
               (fn [ev]
                 (println "event received!")
                 (clojure.pprint/pprint ev)))

  (crux/latest-completed-tx node)
  (crux/latest-submitted-tx node)

  ;; ivan example
  (def node
    (crux/start-node
      {:crux.node/topology                 :crux.standalone/topology
       :crux.node/kv-store                 "crux.kv.memdb/kv"
       :crux.standalone/event-log-dir      "data/eventlog-1"
       :crux.kv/db-dir                     "data/db-dir-1"
       :crux.standalone/event-log-kv-store "crux.kv.memdb/kv"}))
  (crux/submit-tx node [[:crux.tx/put {:crux.db/id :ivan, :age 40}]])
  (gc/find-entity node {:crux.db/id :ivan})
  (gc/find-entity node {:crux.db/id '_})

  (gc/deftx cinc [node eid]
    (let [entity (crux.api/entity (crux.api/db node) eid)]
      [[:crux.tx/put (update entity :age inc)]]))

  (-> cinc var meta :crux-tx-fn)
  ((-> cinc var meta :crux-tx-fn) node)
  (cinc node :ivan)
  (gc/find-entity node {:crux.db/id :ivan})

  (user/set-email node :foo "qweqwe")

  (install-tx-fns node '[glam.crux.scratch])

  )





