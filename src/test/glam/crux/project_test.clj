(ns glam.crux.project-test
  (:require [clojure.test :refer :all]
            [crux.api :as crux]
            [glam.crux.access :as access]
            [glam.crux.user :as user]
            [glam.crux.project :as prj]))

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
       :user/email         "tksk8s@hotmail.com"
       :user/admin?        false
       :user/password-hash phash})
    (f)
    (user/delete crux-node :user1)
    (user/delete crux-node :admin1)))

(defn with-project [f]
  (let [{project-id :id} (prj/create crux-node {:project/id :project1})]
    (f)
    (prj/delete crux-node project-id)))

(use-fixtures :each with-crux with-users with-project)

(deftest project-access
  (testing "Admin can always access all projects regardless of rights"
    (is (access/ident-readable? crux-node :admin1 [:project/id :project1])))

  (prj/remove-reader crux-node :project1 :user1)
  (testing "Non-admin users have no read or write access by default"
    (is (empty? (access/get-accessible-ids crux-node :user1 :project/id)))
    (is (not (access/ident-readable? crux-node :user1 [:project/id :project1])))
    (is (not (access/ident-writeable? crux-node :user1 [:project/id :project1]))))

  (testing "Read privileges grant reading but not writing"
    (prj/add-reader crux-node :project1 :user1)
    (is (access/ident-readable? crux-node :user1 [:project/id :project1]))
    (is (not (access/ident-writeable? crux-node :user1 [:project/id :project1])))
    (prj/remove-reader crux-node :project1 :user1))

  (testing "Write privileges grant writing and reading"
    (prj/add-writer crux-node :project1 :user1)
    (is (access/ident-readable? crux-node :user1 [:project/id :project1]))
    (is (access/ident-writeable? crux-node :user1 [:project/id :project1])))

  (testing "Removing read privileges also removes write privileges"
    (prj/remove-reader crux-node :project1 :user1)
    (is (not (access/ident-readable? crux-node :user1 [:project/id :project1])))
    (is (not (access/ident-writeable? crux-node :user1 [:project/id :project1]))))

  )