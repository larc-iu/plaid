(ns glam.xtdb.span-test
  (:require [clojure.test :refer :all]
            [glam.xtdb.access :as access]
            [glam.xtdb.user :as user]
            [glam.xtdb.project :as prj]
            [glam.xtdb.text-layer :as txtl]
            [glam.xtdb.token-layer :as tokl]
            [glam.xtdb.span-layer :as sl]
            [glam.xtdb.document :as doc]
            [glam.xtdb.text :as txt]
            [glam.xtdb.token :as tok]
            [glam.xtdb.span :as s]
            [glam.fixtures :refer [with-xtdb with-users with-projects xtdb-node with-layers-and-documents]]
            [glam.xtdb.easy :as gxe]))

(use-fixtures :each with-xtdb with-users with-layers-and-documents)

(def ^:private span-snapshots [{:span/id :s1 :span/tokens [:tok1] :span/value "DT"}
                               {:span/id :s2 :span/tokens [:tok2] :span/value "NN"}
                               {:span/id :s3 :span/tokens [:tok3] :span/value "VBZ"}
                               {:span/id :s4 :span/tokens [:tok4] :span/value "JJ"}])

(deftest span-batched-update-single-delete
  (testing "Batch update can be used for deletion"
    (s/batched-update xtdb-node :doc1 :sl1 span-snapshots [[:delete :s1]])
    (is (nil? (gxe/entity xtdb-node :s1)))
    (is (not (nil? (gxe/entity xtdb-node :s2))))))

(deftest span-batched-update-single-merge
  (testing "Batch update can be used for merging changes"
    (s/batched-update xtdb-node :doc1 :sl1 span-snapshots [[:merge {:span/id :s1 :span/value "changed"}]])
    (is (= "changed" (:span/value (gxe/entity xtdb-node :s1))))))

(deftest span-batched-update-merge-into-nil
  (testing "Merging into nil throws"
    ;; note: throwing happens inside the tx function, which then returns falsy.
    ;; The stack trace will appear in the logger--don't worry, that's intended.
    (is (not (s/batched-update xtdb-node :doc1 :sl1 span-snapshots
                               [[:merge {:span/id :noexist :span/value "changed"}]])))))

(deftest span-batched-update-single-create
  (testing "Batch update can be used for creating new spans"
    (is (nil? (gxe/entity xtdb-node :s5)))
    (s/batched-update xtdb-node :doc1 :sl1 span-snapshots [[:create {:span/id     :s5
                                                                     :span/tokens [:tok1]
                                                                     :span/value  "changed"}]])
    (is (some? (gxe/entity xtdb-node :s5)))))

(deftest span-batched-update-one-of-each
  (testing "Delete, merge, and create at the same time"
    (s/batched-update xtdb-node :doc1 :sl1 span-snapshots [[:merge {:span/id :s1 :span/value "changed"}]
                                                           [:delete :s1]
                                                           [:create {:span/id     :s5
                                                                     :span/tokens [:tok1]
                                                                     :span/value  "changed"}]])
    (is (some? (gxe/entity xtdb-node :s5)))
    (is (nil? (gxe/entity xtdb-node :s1)))))

;; This is actually not true--the put will succeed. Unclear if this is a problem.
;; if it is, can change impl of batched update.
;;
;;(deftest span-batched-update-merge-after-delete
;;  (testing "Delete then merge into s1--should fail the entire tx"
;;    (s/batched-update xtdb-node :doc1 :sl1 span-snapshots [[:delete :s1]
;;                                                           [:merge {:span/id :s1 :span/value "changed"}]
;;                                                           [:put {:span/id     :s5
;;                                                                  :span/tokens [:tok1]
;;                                                                  :span/value  "changed"}]])
;;    (is (nil? (gxe/entity xtdb-node :s5)))
;;    (is (some? (gxe/entity xtdb-node :s1)))))