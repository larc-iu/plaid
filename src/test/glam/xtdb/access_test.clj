(ns glam.xtdb.access-test
  (:require [clojure.test :refer :all]
            [glam.xtdb.access :as access]
            [glam.xtdb.user :as user]
            [glam.xtdb.project :as prj]
            [glam.xtdb.fixtures :refer [with-xtdb with-users with-projects xtdb-node with-layers-and-documents]]))

(use-fixtures :each with-xtdb with-users with-projects with-layers-and-documents)

(deftest project-access
  (testing "Admin can always access all projects regardless of rights"
    (is (access/ident-readable? xtdb-node :admin1 [:project/id :project1])))

  (prj/remove-reader xtdb-node :project1 :user1)
  (testing "Non-admin users have no read or write access by default"
    (is (empty? (access/get-accessible-ids xtdb-node :user3 :project/id)))
    (is (not (access/ident-readable? xtdb-node :user3 [:project/id :project1])))
    (is (not (access/ident-writeable? xtdb-node :user3 [:project/id :project1]))))

  (testing "Read privileges grant reading but not writing"
    (prj/add-reader xtdb-node :project1 :user1)
    (is (access/ident-readable? xtdb-node :user1 [:project/id :project1]))
    (is (not (access/ident-writeable? xtdb-node :user1 [:project/id :project1])))
    (prj/remove-reader xtdb-node :project1 :user1))

  (testing "Write privileges grant writing and reading"
    (prj/add-writer xtdb-node :project1 :user1)
    (is (access/ident-readable? xtdb-node :user1 [:project/id :project1]))
    (is (access/ident-writeable? xtdb-node :user1 [:project/id :project1])))

  (testing "Removing read privileges also removes write privileges"
    (prj/remove-reader xtdb-node :project1 :user1)
    (is (not (access/ident-readable? xtdb-node :user1 [:project/id :project1])))
    (is (not (access/ident-writeable? xtdb-node :user1 [:project/id :project1])))))

(deftest text-layer-access
  (testing "Admin can access layers with no permissions"
    (is (access/ident-readable? xtdb-node :admin1 [:text-layer/id :txtl1]))
    (is (access/ident-writeable? xtdb-node :admin1 [:text-layer/id :txtl1]))
    (is (access/ident-readable? xtdb-node :admin1 [:token-layer/id :tokl1]))
    (is (access/ident-writeable? xtdb-node :admin1 [:token-layer/id :tokl1]))
    (is (access/ident-readable? xtdb-node :admin1 [:token-layer/id :sl1]))
    (is (access/ident-writeable? xtdb-node :admin1 [:token-layer/id :sl1])))

  (testing "User can access readable and writeable layers appropriately"
    ;; user1 is a writer on :project1's layers
    (is (access/ident-readable? xtdb-node :user1 [:text-layer/id :txtl1]))
    (is (access/ident-writeable? xtdb-node :user1 [:text-layer/id :txtl1]))
    (is (access/ident-readable? xtdb-node :user1 [:token-layer/id :tokl1]))
    (is (access/ident-writeable? xtdb-node :user1 [:token-layer/id :tokl1]))
    (is (access/ident-readable? xtdb-node :user1 [:span-layer/id :sl1]))
    (is (access/ident-writeable? xtdb-node :user1 [:span-layer/id :sl1]))

    ;; user1 is a reader on :project1's layers
    (is (access/ident-readable? xtdb-node :user1 [:text-layer/id :txtl2]))
    (is (not (access/ident-writeable? xtdb-node :user1 [:text-layer/id :txtl2])))
    (is (access/ident-readable? xtdb-node :user1 [:token-layer/id :tokl2]))
    (is (not (access/ident-writeable? xtdb-node :user1 [:token-layer/id :tokl2])))
    (is (access/ident-readable? xtdb-node :user1 [:span-layer/id :sl2]))
    (is (not (access/ident-writeable? xtdb-node :user1 [:span-layer/id :sl2])))

    ;; user1 has no permissions on :project4's layers
    (is (not (access/ident-readable? xtdb-node :user1 [:text-layer/id :txtl4])))
    (is (not (access/ident-writeable? xtdb-node :user1 [:text-layer/id :txtl4])))
    (is (not (access/ident-readable? xtdb-node :user1 [:token-layer/id :tokl4])))
    (is (not (access/ident-writeable? xtdb-node :user1 [:token-layer/id :tokl4])))
    (is (not (access/ident-readable? xtdb-node :user1 [:span-layer/id :sl4])))
    (is (not (access/ident-writeable? xtdb-node :user1 [:span-layer/id :sl4])))))

(deftest document-access
  (testing "Admin can access all documents"
    (is (every? #(access/ident-writeable? xtdb-node :admin1 [:document/id %])
                [:doc1 :doc2 :doc3 :doc4 :doc22 :doc33 :doc44])))

  (testing "User accesses only documents they have permissions for"
    (is (access/ident-writeable? xtdb-node :user1 [:document/id :doc1]))
    (is (and (access/ident-readable? xtdb-node :user1 [:document/id :doc22])
             (not (access/ident-writeable? xtdb-node :user1 [:document/id :doc22]))))
    (is (not (access/ident-readable? xtdb-node :user1 [:document/id :doc44])))))
