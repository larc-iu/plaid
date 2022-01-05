(ns glam.xtdb.delete-test
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

(deftest span-layer-deletion
  (testing "Span layers can be deleted and delete their spans"
    (sl/delete xtdb-node :sl1)
    (is (nil? (gxe/entity xtdb-node :sl1)))
    (is (empty? (gxe/find-entities xtdb-node [[:span/id '_]])))))

(deftest token-layer-deletion
  (testing "Token layers delete dependent span layers, their tokens, and themselves"
    (tokl/delete xtdb-node :tokl1)
    (is (nil? (gxe/entity xtdb-node :tokl1)))
    (is (nil? (gxe/entity xtdb-node :sl1)))
    (is (empty? (gxe/find-entities xtdb-node [[:span/id '_]])))
    (is (empty? (gxe/find-entities xtdb-node [[:token/id '_]])))))

(deftest text-layer-deletion
  (testing "Text layers delete dependent text, token layers, span layers, their tokens, and themselves"
    (txtl/delete xtdb-node :txtl1)
    (is (nil? (gxe/entity xtdb-node :txtl)))
    (is (nil? (gxe/entity xtdb-node :tokl1)))
    (is (nil? (gxe/entity xtdb-node :sl1)))
    (is (empty? (gxe/find-entities xtdb-node [[:text/id '_]])))
    (is (empty? (gxe/find-entities xtdb-node [[:span/id '_]])))
    (is (empty? (gxe/find-entities xtdb-node [[:token/id '_]])))))

(deftest span-deletion
  (testing "Spans can be deleted"
    (s/delete xtdb-node :s1)
    (is (nil? (gxe/entity xtdb-node :s1)))))

(deftest token-deletion
  (testing "Tokens can be deleted, and if this results in any span having 0 associated tokens, the token is also deleted"
    ;;set up a 2-token span
    (s/create xtdb-node {:span/id :s12 :span/tokens [:tok1 :tok2] :span/value "Foo" :span/layer :sl1})
    (tok/delete xtdb-node :tok1)
    (is (nil? (gxe/entity xtdb-node :tok1)))
    (is (nil? (gxe/entity xtdb-node :s1)))
    (is (some? (gxe/entity xtdb-node :s12)))
    (is (= [:tok2] (-> xtdb-node (gxe/entity :s12) :span/tokens)))))

(deftest text-deletion
  (testing "Texts can be deleted, which also deletes all tokens and spans under it"
    (txt/delete xtdb-node :txt1)
    (is (empty? (gxe/find-entities xtdb-node [[:text/id '_]])))
    (is (empty? (gxe/find-entities xtdb-node [[:span/id '_]])))
    (is (empty? (gxe/find-entities xtdb-node [[:token/id '_]])))))

(deftest document-deletion
  (testing "Documents can be deleted, which deletes all annotations"
    (doc/delete xtdb-node :doc1)
    (is (empty? (gxe/find-entities xtdb-node [[:text/id '_]])))
    (is (empty? (gxe/find-entities xtdb-node [[:span/id '_]])))
    (is (empty? (gxe/find-entities xtdb-node [[:token/id '_]])))))

(deftest project-deletion
  (testing "Projects can be deleted, which deletes everything!"
    (prj/delete xtdb-node :project1)
    (is (nil? (gxe/entity xtdb-node :project1)))
    (is (nil? (gxe/entity xtdb-node :txtl)))
    (is (nil? (gxe/entity xtdb-node :tokl1)))
    (is (nil? (gxe/entity xtdb-node :sl1)))
    (is (empty? (gxe/find-entities xtdb-node [[:text/id '_]])))
    (is (empty? (gxe/find-entities xtdb-node [[:span/id '_]])))
    (is (empty? (gxe/find-entities xtdb-node [[:token/id '_]])))))