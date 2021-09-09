(ns user
  (:require
    [clojure.tools.namespace.repl :as tools-ns]
    [expound.alpha :as expound]
    [mount.core :as mount]
    [xtdb.api :as xt]
    [shadow.cljs.devtools.api :as shadow]
    ;; this is the top-level dependent component...mount will find the rest via ns requires
    [glam.server.http-server :refer [http-server]]
    [glam.xtdb.easy :as gxe]
    [glam.xtdb.user :as usr]
    [glam.xtdb.project :as prj]
    [glam.xtdb.text :as txt]
    [glam.xtdb.token :as tok]
    [glam.xtdb.text-layer :as txtl]
    [glam.xtdb.token-layer :as tokl]
    [glam.xtdb.span-layer :as sl]
    [glam.xtdb.span :as s]
    [glam.xtdb.document :as doc]
    [taoensso.timbre :as log]))

;; ==================== SERVER ====================
(tools-ns/set-refresh-dirs "src/main" "src/dev" "src/test")

;; Change the default output of spec to be more readable
;; (alter-var-root #'s/*explain-out* (constantly expound/printer))

(comment
  ;; For shadow: start the shadow-cljs server using ./scripts/start-dev.sh
  ;; start a cljs repl once shadow is listening (port 9000, default)
  ;; then you can start the watch processes here (ensure the cljs repl has focus in cursive):
  ;;
  (shadow/repl :main)
  (shadow/help)

  ;; You have to start the node server first.
  ;; in terminal, run: node target/node-server.js
  (shadow/repl :node-server)
  ;; now you can send cljs forms to the repl but you'll need to open another cljs repl
  ;; as the server has captured output.
  )

(defn start "Start the web server + services" []
  (let [result (mount/start)]
    (def node glam.server.xtdb/xtdb-node)
    (def parser glam.server.pathom-parser/parser)
    result))

(defn stop "Stop the web server + services" []
  (mount/stop))

(defn restart
  "Stop, reload code, and restart the server. If there is a compile error, use:
  ```
  (tools-ns/refresh)
  ```
  to recompile, and then use `start` once things are good."
  []
  (stop)
  (tools-ns/refresh :after 'user/start))

(comment
  (tools-ns/refresh :after 'user/start)
  (shadow/repl :main)
  (stop)
  (restart))

;; xtdb stuff
(defn init-db [xtdb-node]
  (let [node (or xtdb-node glam.server.xtdb/xtdb-node)]
    (let [admin-id (:id (usr/create
                          node
                          {:user/password-hash "100$12$argon2id$v13$u6JYj16Ize35J1uuTN6KwQ$SblXBBHdyMZ5K52RwCcO41/SNL6XqoY1JBouP/V01uQ$$$"
                           :user/name          "admin"
                           :user/email         "a@b.com"
                           :user/admin?        true
                           :user/id            :admin}))
          user1 (:id (usr/create
                       node
                       {:user/password-hash "100$12$argon2id$v13$u6JYj16Ize35J1uuTN6KwQ$SblXBBHdyMZ5K52RwCcO41/SNL6XqoY1JBouP/V01uQ$$$"
                        :user/name          "user"
                        :user/email         "b@b.com"
                        :user/id            :user1}))
          user2 (:id (usr/create
                       node
                       {:user/password-hash "100$12$argon2id$v13$u6JYj16Ize35J1uuTN6KwQ$SblXBBHdyMZ5K52RwCcO41/SNL6XqoY1JBouP/V01uQ$$$"
                        :user/name          "user2"
                        :user/email         "c@c.com"
                        :user/id            :user2}))

          project1 (:id (prj/create node {:project/name "Project 1" :project/id :project1}))
          project2 (:id (prj/create node {:project/name "Project 2" :project/id :project2}))
          project3 (:id (prj/create node {:project/name "Project 3" :project/id :project3}))
          project4 (:id (prj/create node {:project/name "Project 4" :project/id :project4}))

          txtl1 (:id (txtl/create node {:text-layer/name "Layer 1" :text-layer/id :txtl1}))
          tokl1 (:id (tokl/create node {:token-layer/name "Token Layer 1" :token-layer/id :tokl1}))
          sl1 (:id (sl/create node {:span-layer/name "Span Layer 1" :span-layer/id :sl1}))

          doc1 (:id (doc/create node {:document/name "Document 1" :document/id :doc1 :document/project :project1}))
          doc2 (:id (doc/create node {:document/name "Document 2" :document/id :doc2 :document/project :project1}))
          doc3 (:id (doc/create node {:document/name "Document 3" :document/id :doc3 :document/project :project1}))
          doc4 (:id (doc/create node {:document/name "Document 4" :document/id :doc4 :document/project :project1}))

          doc22 (:id (doc/create node {:document/name "Document 22" :document/id :doc22 :document/project :project2}))
          doc33 (:id (doc/create node {:document/name "Document 33" :document/id :doc33 :document/project :project3}))
          doc44 (:id (doc/create node {:document/name "Document 44" :document/id :doc44 :document/project :project4}))

          txt1 (:id (txt/create node {:text/id       :txt1
                                      :text/document :doc1
                                      :text/layer    :txtl1
                                      :text/body     "This sentence is great, isn't it!"}))
          tok1 (:id (tok/create node {:token/id :tok1 :token/text :txt1 :token/layer :tokl1 :token/begin 0 :token/end 4}))
          tok2 (:id (tok/create node {:token/id :tok2 :token/text :txt1 :token/layer :tokl1 :token/begin 5 :token/end 13}))
          tok3 (:id (tok/create node {:token/id :tok3 :token/text :txt1 :token/layer :tokl1 :token/begin 14 :token/end 16}))
          tok4 (:id (tok/create node {:token/id :tok4 :token/text :txt1 :token/layer :tokl1 :token/begin 17 :token/end 22}))

          s1 (:id (s/create node {:span/id :s1 :span/tokens [:tok1] :span/value "DT" :span/layer :sl1}))
          s2 (:id (s/create node {:span/id :s2 :span/tokens [:tok2] :span/value "NN" :span/layer :sl1}))
          s3 (:id (s/create node {:span/id :s3 :span/tokens [:tok3] :span/value "VBZ" :span/layer :sl1}))
          s4 (:id (s/create node {:span/id :s4 :span/tokens [:tok4] :span/value "JJ" :span/layer :sl1}))
          ]

      (prj/add-writer node project1 admin-id)
      (prj/add-writer node project2 admin-id)

      (prj/add-writer node project1 user1)
      (prj/add-reader node project2 user1)
      (prj/add-reader node project1 user1)

      (prj/add-writer node project2 user2)
      (prj/add-writer node project3 user2)

      (prj/add-text-layer node project1 txtl1)
      (txtl/add-token-layer node txtl1 tokl1)
      (tokl/add-span-layer node tokl1 sl1)
      )))
