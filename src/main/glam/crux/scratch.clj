(ns glam.crux.scratch
  (:require [crux.api :as crux]
            [glam.crux.common.easy :as cce]
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
  (cce/find-entities node {:user/id '_})
  (crux/await-tx node (user/set-admin? node (:user/id (user/get-by-email node "a@b.com")) true))

  (def node
    (crux/start-node
      {:crux.node/topology                 :crux.standalone/topology
       :crux.node/kv-store                 "crux.kv.memdb/kv"
       :crux.standalone/event-log-dir      "data/eventlog-1"
       :crux.kv/db-dir                     "data/db-dir-1"
       :crux.standalone/event-log-kv-store "crux.kv.memdb/kv"}))
  (cce/install-tx-fns node '[glam.crux.user])

  (crux/listen node {:crux/event-type :crux/indexed-tx, :with-tx-ops? true}
               (fn [ev]
                 (println "event received!")
                 (clojure.pprint/pprint ev)))

  (crux/latest-completed-tx node)
  (crux/latest-submitted-tx node)

  ;; users
  (user/create node {:name "user1" :email "a@b.com" :password-hash "placeholder"})
  (let [uid (:user/id (first (user/get-all node)))]
    (user/remove-reader node uid :foo)
    )


  (user/get-all node)


  ;; ivan example
  (def node
    (crux/start-node
      {:crux.node/topology                 :crux.standalone/topology
       :crux.node/kv-store                 "crux.kv.memdb/kv"
       :crux.standalone/event-log-dir      "data/eventlog-1"
       :crux.kv/db-dir                     "data/db-dir-1"
       :crux.standalone/event-log-kv-store "crux.kv.memdb/kv"}))

  (crux/submit-tx node [[:crux.tx/put {:crux.db/id :ivan, :age 40}]])
  (cce/find-entity node {:crux.db/id :ivan})
  (cce/find-entity node {:crux.db/id '_})

  (cce/deftx cinc [node eid]
    (let [entity (crux.api/entity (crux.api/db node) eid)]
      [[:crux.tx/put (update entity :age inc)]]))

  (-> cinc var meta :crux-tx-fn)
  ((-> cinc var meta :crux-tx-fn) node)
  (cinc node :ivan)
  (cce/find-entity node {:crux.db/id :ivan})

  (user/set-email node :foo "qweqwe")

  (install-tx-fns node '[glam.crux.scratch])

  )





(comment
  ;; concurrency concerns
  (do
    (import 'java.util.concurrent.Executors)
    (def ^:dynamic *pool* (Executors/newFixedThreadPool (+ 2 (.availableProcessors (Runtime/getRuntime)))))
    (defn dothreads! [f & {thread-count :threads
                           exec-count   :times
                           :or          {thread-count 1 exec-count 1}}]
      (dotimes [t thread-count]
        (.submit *pool* #(dotimes [c exec-count] (f c))))))

  (def node
    (crux/start-node
      {:crux.node/topology                 :crux.standalone/topology
       :crux.node/kv-store                 "crux.kv.memdb/kv"
       :crux.standalone/event-log-dir      "data/eventlog-1"
       :crux.kv/db-dir                     "data/db-dir-1"
       :crux.standalone/event-log-kv-store "crux.kv.memdb/kv"}))

  (cce/put node {:crux.db/id :foo :a 0})

  (cce/entity node :foo)
  (cce/update node :foo update :a inc)

  (dothreads! (fn [c]
                (println "Updating")
                (locking :foo
                  (cce/unsafe-update
                    node
                    :foo
                    (fn [doc]
                      (update doc :a inc)))))
              :threads 5
              :times 5)


  )