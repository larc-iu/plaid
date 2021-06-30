(ns glam.crux.scratch
  (:require [crux.api :as crux]
            [glam.crux.easy :as gce]
            [glam.crux.user :as user]
            [glam.crux.project :as prj]
            [glam.crux.text-layer :as tl]
            [user :refer [init-db]]
            [taoensso.timbre :as log])
  )

(comment

  (def node
    (let [node (crux/start-node {})]
      (gce/install-tx-fns! node)
      (init-db node)
      node))


  (prj/get-accessible-ids node :user1)


  (prj/remove-reader node :project1 :user1)

  (prj/add-reader node :project1 :user1)

  (gce/find-entities node [[:project/id :project1]])

  (prj/remove-writer node :project1 :admin)




  (crux/pull (crux/db node) [:project/name {:project/writers [:user/id :user/email]}] :project1)


  (prj/get-all node)
  (user/get-all node)
  (prj/get-accessible-ids node :user1)
  (prj/get-accessible-ids node :admin)

  (def node glam.server.crux/crux-node)
  (user/get-by-email node "a@a.com")
  (user/get-by-email node "a@b.com")
  (user/get-by-email node "b@b.com")

  (glam.crux.user/create node {:user/name "a" :user/email "a@a.com" :user/password-hash "qwe"})
  (glam.crux.user/create node {:user/name "placeholder1" :user/email "placeholder1@placeholder.com" :user/password-hash "qwe"})
  (glam.crux.user/create node {:user/name "placeholder2" :user/email "placeholder2@placeholder.com" :user/password-hash "qwe"})
  (glam.crux.user/create node {:user/name "placeholder3" :user/email "placeholder3@placeholder.com" :user/password-hash "qwe"})
  (glam.crux.user/create node {:user/name "placeholder4" :user/email "placeholder4@placeholder.com" :user/password-hash "qwe"})
  (glam.crux.user/create node {:user/name "placeholder5" :user/email "placeholder5@placeholder.com" :user/password-hash "qwe"})
  (glam.crux.user/create node {:user/name "placeholder6" :user/email "placeholder6@placeholder.com" :user/password-hash "qwe"})

  (user/get-all node)
  (gce/find-entities node {:user/id '_})
  (crux/await-tx node (user/set-admin? node (:user/id (user/get-by-email node "a@b.com")) true))

  (def node
    (crux/start-node
      {:crux.node/topology                 :crux.standalone/topology
       :crux.node/kv-store                 "crux.kv.memdb/kv"
       :crux.standalone/event-log-dir      "data/eventlog-1"
       :crux.kv/db-dir                     "data/db-dir-1"
       :crux.standalone/event-log-kv-store "crux.kv.memdb/kv"}))
  (gce/install-tx-fns node '[glam.crux.user])

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
  (gce/find-entity node {:crux.db/id :ivan})
  (gce/find-entity node {:crux.db/id '_})

  (crux/q (crux/db node)
          {:find  '[?e]
           :where ['[?e :age ?age]
                   ['(glam.crux.scratch/my< 30 ?age)]]})

  (gce/deftx cinc [node eid]
             (let [entity (crux.api/entity (crux.api/db node) eid)]
               [[:crux.tx/put (update entity :age inc)]]))

  (-> cinc var meta :crux-tx-fn)
  ((-> cinc var meta :crux-tx-fn) node)
  (cinc node :ivan)
  (gce/find-entity node {:crux.db/id :ivan})

  (user/set-email node :foo "qweqwe")

  (install-tx-fns node '[glam.crux.scratch])







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

    (gce/put node {:crux.db/id :foo :a 0})

    (gce/entity node :foo)

    (dothreads! (fn [c]
                  (println "Updating")
                  (locking :foo
                    (gce/unsafe-update
                      node
                      :foo
                      (fn [doc]
                        (update doc :a inc)))))
                :threads 5
                :times 5)

    )

  (comment

    (user/create
      node
      {:user/password-hash "100$12$argon2id$v13$u6JYj16Ize35J1uuTN6KwQ$SblXBBHdyMZ5K52RwCcO41/SNL6XqoY1JBouP/V01uQ$$$"
       :user/name          "admin"
       :user/email         "a@b.com"})

    (defn init-db []
      (let [node glam.server.crux/crux-node]
        (let [admin-id (user/create
                         node
                         {:user/password-hash "100$12$argon2id$v13$u6JYj16Ize35J1uuTN6KwQ$SblXBBHdyMZ5K52RwCcO41/SNL6XqoY1JBouP/V01uQ$$$"
                          :user/name          "admin"
                          :user/email         "a@b.com"})

              user1 (user/create
                      node
                      {:user/password-hash "100$12$argon2id$v13$u6JYj16Ize35J1uuTN6KwQ$SblXBBHdyMZ5K52RwCcO41/SNL6XqoY1JBouP/V01uQ$$$"
                       :user/name          "user"
                       :user/email         "b@b.com"})
              user2 (user/create
                      node
                      {:user/password-hash "100$12$argon2id$v13$u6JYj16Ize35J1uuTN6KwQ$SblXBBHdyMZ5K52RwCcO41/SNL6XqoY1JBouP/V01uQ$$$"
                       :user/name          "user2"
                       :user/email         "c@c.com"})

              project1 (prj/create node {:project/name "Project 1"})
              project2 (prj/create node {:project/name "Project 2"})
              project3 (prj/create node {:project/name "Project 3"})
              project4 (prj/create node {:project/name "Project 4"})
              ])))

    ))