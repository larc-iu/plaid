(ns glam.xtdb.fixtures
  (:require [clojure.test :refer :all]
            [glam.xtdb.user :as user]
            [glam.xtdb.project :as prj]
            [xtdb.api :as xt]
            [glam.xtdb.document :as doc]
            [glam.xtdb.text-layer :as txtl]
            [glam.xtdb.token-layer :as tokl]
            [glam.xtdb.span-layer :as sl]
            [taoensso.timbre :as log]
            [glam.xtdb.text :as txt]
            [glam.xtdb.token :as tok]
            [glam.xtdb.span :as s]))

(log/set-level! :error)

(def xtdb-node nil)

(defn with-xtdb [f]
  (with-redefs [xtdb-node (xt/start-node {})]
    (f)))

(defn with-users [f]
  (let [phash "100$12$argon2id$v13$u6JYj16Ize35J1uuTN6KwQ$SblXBBHdyMZ5K52RwCcO41/SNL6XqoY1JBouP/V01uQ$$$"]
    (user/create
      xtdb-node
      {:user/id            :admin1
       :user/name          "Maude Argonne"
       :user/email         "macsh@aol.com"
       :user/admin?        true
       :user/password-hash phash})
    (user/create
      xtdb-node
      {:user/id            :user1
       :user/name          "Wadsworth Curry"
       :user/email         "tcsk8s@hotmail.com"
       :user/admin?        false
       :user/password-hash phash})
    (user/create
      xtdb-node
      {:user/id            :user2
       :user/name          "Helga Pataki"
       :user/email         "hna@aol.com"
       :user/admin?        false
       :user/password-hash phash})
    (user/create
      xtdb-node
      {:user/id            :user3
       :user/name          "Jet Black"
       :user/email         "jb121531@geocities.com"
       :user/admin?        false
       :user/password-hash phash})
    (f)
    (user/delete xtdb-node :user1)
    (user/delete xtdb-node :user2)
    (user/delete xtdb-node :user3)
    (user/delete xtdb-node :admin1)))

(defn with-projects [f]
  (let [{project1 :id} (prj/create xtdb-node {:project/id :project1})
        {project2 :id} (prj/create xtdb-node {:project/id :project2})
        {project3 :id} (prj/create xtdb-node {:project/id :project3})
        {project4 :id} (prj/create xtdb-node {:project/id :project4})]
    (f)
    (prj/delete xtdb-node project1)
    (prj/delete xtdb-node project2)
    (prj/delete xtdb-node project3)
    (prj/delete xtdb-node project4)))

(defn with-layers-and-documents [f]
  (let [admin-id :admin1
        user1 :user1
        user2 :user2
        project1 (:id (prj/create xtdb-node {:project/name "Project 1" :project/id :project1}))
        project2 (:id (prj/create xtdb-node {:project/name "Project 2" :project/id :project2}))
        project3 (:id (prj/create xtdb-node {:project/name "Project 3" :project/id :project3}))
        project4 (:id (prj/create xtdb-node {:project/name "Project 4" :project/id :project4}))

        txtl1 (:id (txtl/create xtdb-node {:text-layer/name "Layer 1" :text-layer/id :txtl1}))
        tokl1 (:id (tokl/create xtdb-node {:token-layer/name "Token Layer 1" :token-layer/id :tokl1}))
        sl1 (:id (sl/create xtdb-node {:span-layer/name "Span Layer 1" :span-layer/id :sl1}))
        txtl2 (:id (txtl/create xtdb-node {:text-layer/name "Layer 2" :text-layer/id :txtl2}))
        tokl2 (:id (tokl/create xtdb-node {:token-layer/name "Token Layer 2" :token-layer/id :tokl2}))
        sl2 (:id (sl/create xtdb-node {:span-layer/name "Span Layer 2" :span-layer/id :sl2}))
        txtl4 (:id (txtl/create xtdb-node {:text-layer/name "Layer 4" :text-layer/id :txtl4}))
        tokl4 (:id (tokl/create xtdb-node {:token-layer/name "Token Layer 4" :token-layer/id :tokl4}))
        sl4 (:id (sl/create xtdb-node {:span-layer/name "Span Layer 4" :span-layer/id :sl4}))

        doc1 (:id (doc/create xtdb-node {:document/name "Document 1" :document/id :doc1 :document/project :project1}))
        doc2 (:id (doc/create xtdb-node {:document/name "Document 2" :document/id :doc2 :document/project :project1}))
        doc3 (:id (doc/create xtdb-node {:document/name "Document 3" :document/id :doc3 :document/project :project1}))
        doc4 (:id (doc/create xtdb-node {:document/name "Document 4" :document/id :doc4 :document/project :project1}))

        doc22 (:id (doc/create xtdb-node {:document/name "Document 22" :document/id :doc22 :document/project :project2}))
        doc33 (:id (doc/create xtdb-node {:document/name "Document 33" :document/id :doc33 :document/project :project3}))
        doc44 (:id (doc/create xtdb-node {:document/name "Document 44" :document/id :doc44 :document/project :project4}))

        txt1 (:id (txt/create xtdb-node {:text/id       :txt1
                                         :text/document :doc1
                                         :text/layer    :txtl1
                                         :text/body     "This sentence is great, isn't it!"}))
        tok1 (:id (tok/create xtdb-node {:token/id :tok1 :token/text :txt1 :token/layer :tokl1 :token/begin 0 :token/end 4}))
        tok2 (:id (tok/create xtdb-node {:token/id :tok2 :token/text :txt1 :token/layer :tokl1 :token/begin 5 :token/end 13}))
        tok3 (:id (tok/create xtdb-node {:token/id :tok3 :token/text :txt1 :token/layer :tokl1 :token/begin 14 :token/end 16}))
        tok4 (:id (tok/create xtdb-node {:token/id :tok4 :token/text :txt1 :token/layer :tokl1 :token/begin 17 :token/end 22}))

        s1 (:id (s/create xtdb-node {:span/id :s1 :span/tokens [:tok1] :span/value "DT" :span/layer :sl1}))
        s2 (:id (s/create xtdb-node {:span/id :s2 :span/tokens [:tok2] :span/value "NN" :span/layer :sl1}))
        s3 (:id (s/create xtdb-node {:span/id :s3 :span/tokens [:tok3] :span/value "VBZ" :span/layer :sl1}))
        s4 (:id (s/create xtdb-node {:span/id :s4 :span/tokens [:tok4] :span/value "JJ" :span/layer :sl1}))]
    (prj/add-writer xtdb-node project1 user1)
    (prj/add-reader xtdb-node project2 user1)

    (prj/add-reader xtdb-node project2 user2)
    (prj/add-writer xtdb-node project3 user2)

    (prj/add-text-layer xtdb-node project1 txtl1)
    (txtl/add-token-layer xtdb-node txtl1 tokl1)
    (tokl/add-span-layer xtdb-node tokl1 sl1)
    (prj/add-text-layer xtdb-node project2 txtl2)
    (txtl/add-token-layer xtdb-node txtl2 tokl2)
    (tokl/add-span-layer xtdb-node tokl2 sl2)
    (prj/add-text-layer xtdb-node project4 txtl4)
    (txtl/add-token-layer xtdb-node txtl4 tokl4)
    (tokl/add-span-layer xtdb-node tokl4 sl4)
    (f)
    ;; don't need to delete--we use this only with :each, and the with-crux cleanup will take care of deletions
    ))
