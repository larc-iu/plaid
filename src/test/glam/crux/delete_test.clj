(ns glam.crux.delete-test
  (:require [clojure.test :refer :all]
            [glam.crux.access :as access]
            [glam.crux.user :as user]
            [glam.crux.project :as prj]
            [glam.crux.text-layer :as txtl]
            [glam.crux.token-layer :as tokl]
            [glam.crux.span-layer :as sl]
            [glam.crux.document :as doc]
            [glam.crux.text :as txt]
            [glam.crux.token :as tok]
            [glam.crux.span :as s]
            [glam.crux.fixtures :refer [with-crux with-users with-projects crux-node with-layers-and-documents]]
            [glam.crux.easy :as gce]))

(use-fixtures :each with-crux with-users with-layers-and-documents)

(deftest span-layer-deletion
  (testing "Span layers can be deleted and delete their spans"
    (sl/delete crux-node :sl1)
    (is (nil? (gce/entity crux-node :sl1)))
    (is (empty? (gce/find-entities crux-node [[:span/id '_]])))))

(deftest token-layer-deletion
  (testing "Token layers delete dependent span layers, their tokens, and themselves"
    (tokl/delete crux-node :tokl1)
    (is (nil? (gce/entity crux-node :tokl1)))
    (is (nil? (gce/entity crux-node :sl1)))
    (is (empty? (gce/find-entities crux-node [[:span/id '_]])))
    (is (empty? (gce/find-entities crux-node [[:token/id '_]])))))

(deftest text-layer-deletion
  (testing "Text layers delete dependent text, token layers, span layers, their tokens, and themselves"
    (txtl/delete crux-node :txtl1)
    (is (nil? (gce/entity crux-node :txtl)))
    (is (nil? (gce/entity crux-node :tokl1)))
    (is (nil? (gce/entity crux-node :sl1)))
    (is (empty? (gce/find-entities crux-node [[:text/id '_]])))
    (is (empty? (gce/find-entities crux-node [[:span/id '_]])))
    (is (empty? (gce/find-entities crux-node [[:token/id '_]])))))

(deftest span-deletion
  (testing "Spans can be deleted"
    (s/delete crux-node :s1)
    (is (nil? (gce/entity crux-node :s1)))))

(deftest token-deletion
  (testing "Tokens can be deleted, and if this results in any span having 0 associated tokens, the token is also deleted"
    ;;set up a 2-token span
    (s/create crux-node {:span/id :s12 :span/tokens [:tok1 :tok2] :span/value "Foo" :span/layer :sl1})
    (tok/delete crux-node :tok1)
    (is (nil? (gce/entity crux-node :tok1)))
    (is (nil? (gce/entity crux-node :s1)))
    (is (some? (gce/entity crux-node :s12)))
    (is (= [:tok2] (-> crux-node (gce/entity :s12) :span/tokens)))))

(deftest text-deletion
  (testing "Texts can be deleted, which also deletes all tokens and spans under it"
    (txt/delete crux-node :txt1)
    (is (empty? (gce/find-entities crux-node [[:text/id '_]])))
    (is (empty? (gce/find-entities crux-node [[:span/id '_]])))
    (is (empty? (gce/find-entities crux-node [[:token/id '_]])))))

(deftest document-deletion
  (testing "Documents can be deleted, which deletes all annotations"
    (doc/delete crux-node :doc1)
    (is (empty? (gce/find-entities crux-node [[:text/id '_]])))
    (is (empty? (gce/find-entities crux-node [[:span/id '_]])))
    (is (empty? (gce/find-entities crux-node [[:token/id '_]])))))

(deftest project-deletion
  (testing "Projects can be deleted, which deletes everything!"
    (prj/delete crux-node :project1)
    (is (nil? (gce/entity crux-node :project1)))
    (is (nil? (gce/entity crux-node :txtl)))
    (is (nil? (gce/entity crux-node :tokl1)))
    (is (nil? (gce/entity crux-node :sl1)))
    (is (empty? (gce/find-entities crux-node [[:text/id '_]])))
    (is (empty? (gce/find-entities crux-node [[:span/id '_]])))
    (is (empty? (gce/find-entities crux-node [[:token/id '_]])))))