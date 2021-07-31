(ns glam.crux.fixtures
  (:require [clojure.test :refer :all]
            [glam.crux.user :as user]
            [glam.crux.project :as prj]
            [crux.api :as crux]
            [glam.crux.document :as doc]
            [glam.crux.text-layer :as txtl]
            [glam.crux.token-layer :as tokl]
            [glam.crux.span-layer :as sl]
            [taoensso.timbre :as log]))

(log/set-level! :error)

(def crux-node nil)

(defn with-crux [f]
  (with-redefs [crux-node (crux/start-node {})]
    (f)))

(defn with-users [f]
  (let [phash "100$12$argon2id$v13$u6JYj16Ize35J1uuTN6KwQ$SblXBBHdyMZ5K52RwCcO41/SNL6XqoY1JBouP/V01uQ$$$"]
    (user/create
      crux-node
      {:user/id            :admin1
       :user/name          "Maude Argonne"
       :user/email         "macsh@aol.com"
       :user/admin?        true
       :user/password-hash phash})
    (user/create
      crux-node
      {:user/id            :user1
       :user/name          "Wadsworth Curry"
       :user/email         "tcsk8s@hotmail.com"
       :user/admin?        false
       :user/password-hash phash})
    (user/create
      crux-node
      {:user/id            :user2
       :user/name          "Helga Pataki"
       :user/email         "hna@aol.com"
       :user/admin?        false
       :user/password-hash phash})
    (user/create
      crux-node
      {:user/id            :user3
       :user/name          "Jet Black"
       :user/email         "jb121531@geocities.com"
       :user/admin?        false
       :user/password-hash phash})
    (f)
    (user/delete crux-node :user1)
    (user/delete crux-node :user2)
    (user/delete crux-node :user3)
    (user/delete crux-node :admin1)))

(defn with-projects [f]
  (let [{project1 :id} (prj/create crux-node {:project/id :project1})
        {project2 :id} (prj/create crux-node {:project/id :project2})
        {project3 :id} (prj/create crux-node {:project/id :project3})
        {project4 :id} (prj/create crux-node {:project/id :project4})]
    (f)
    (prj/delete crux-node project1)
    (prj/delete crux-node project2)
    (prj/delete crux-node project3)
    (prj/delete crux-node project4)))

(defn with-layers-and-documents [f]
  (let [admin-id :admin1
        user1 :user1
        user2 :user2
        project1 (:id (prj/create crux-node {:project/name "Project 1" :project/id :project1}))
        project2 (:id (prj/create crux-node {:project/name "Project 2" :project/id :project2}))
        project3 (:id (prj/create crux-node {:project/name "Project 3" :project/id :project3}))
        project4 (:id (prj/create crux-node {:project/name "Project 4" :project/id :project4}))

        txtl1 (:id (txtl/create crux-node {:text-layer/name "Layer 1" :text-layer/id :txtl1}))
        tokl1 (:id (tokl/create crux-node {:token-layer/name "Token Layer 1" :token-layer/id :tokl1}))
        sl1 (:id (sl/create crux-node {:span-layer/name "Span Layer 1" :span-layer/id :sl1}))
        txtl2 (:id (txtl/create crux-node {:text-layer/name "Layer 2" :text-layer/id :txtl2}))
        tokl2 (:id (tokl/create crux-node {:token-layer/name "Token Layer 2" :token-layer/id :tokl2}))
        sl2 (:id (sl/create crux-node {:span-layer/name "Span Layer 2" :span-layer/id :sl2}))
        txtl4 (:id (txtl/create crux-node {:text-layer/name "Layer 4" :text-layer/id :txtl4}))
        tokl4 (:id (tokl/create crux-node {:token-layer/name "Token Layer 4" :token-layer/id :tokl4}))
        sl4 (:id (sl/create crux-node {:span-layer/name "Span Layer 4" :span-layer/id :sl4}))

        doc1 (:id (doc/create crux-node {:document/name "Document 1" :document/id :doc1 :document/project :project1}))
        doc2 (:id (doc/create crux-node {:document/name "Document 2" :document/id :doc2 :document/project :project1}))
        doc3 (:id (doc/create crux-node {:document/name "Document 3" :document/id :doc3 :document/project :project1}))
        doc4 (:id (doc/create crux-node {:document/name "Document 4" :document/id :doc4 :document/project :project1}))

        doc22 (:id (doc/create crux-node {:document/name "Document 22" :document/id :doc22 :document/project :project2}))
        doc33 (:id (doc/create crux-node {:document/name "Document 33" :document/id :doc33 :document/project :project3}))
        doc44 (:id (doc/create crux-node {:document/name "Document 44" :document/id :doc44 :document/project :project4}))]
    (prj/add-writer crux-node project1 user1)
    (prj/add-reader crux-node project2 user1)

    (prj/add-reader crux-node project2 user2)
    (prj/add-writer crux-node project3 user2)

    (prj/add-text-layer crux-node project1 txtl1)
    (txtl/add-token-layer crux-node txtl1 tokl1)
    (tokl/add-span-layer crux-node tokl1 sl1)
    (prj/add-text-layer crux-node project2 txtl2)
    (txtl/add-token-layer crux-node txtl2 tokl2)
    (tokl/add-span-layer crux-node tokl2 sl2)
    (prj/add-text-layer crux-node project4 txtl4)
    (txtl/add-token-layer crux-node txtl4 tokl4)
    (tokl/add-span-layer crux-node tokl4 sl4)
    (f)
    (prj/delete crux-node project1)
    (prj/delete crux-node project2)
    (prj/delete crux-node project3)
    (prj/delete crux-node project4)))
