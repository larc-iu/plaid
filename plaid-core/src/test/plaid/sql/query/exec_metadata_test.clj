(ns plaid.sql.query.exec-metadata-test
  "Integration tests for :metadata filtering — a correlated EXISTS over the
  entity_metadata wide-narrow table (indexed on its PK)."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h]
            [plaid.sql.query.exec :as qe]
            [plaid.query.ast :as ast]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [r] (-> r :body :id))
(defn- ids [r] (set (map (comp str first) (:results r))))

(defn- build!
  "pos spans A {translation dog, num sg}, B {translation cat}, C {} (none);
  document d1 {genre news}."
  []
  (let [pid  (h/create-test-project admin-request "MetaProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "pos"))
        d1   (h/create-test-document admin-request pid "doc-1")
        text (id (h/create-text admin-request txtl d1 "aa bb cc"))
        t0 (id (h/create-token admin-request tokl text 0 2))
        t1 (id (h/create-token admin-request tokl text 3 5))
        t2 (id (h/create-token admin-request tokl text 6 8))
        a (id (h/create-span admin-request sl [t0] "X" {"translation" "dog" "num" "sg"}))
        b (id (h/create-span admin-request sl [t1] "Y" {"translation" "cat"}))
        c (id (h/create-span admin-request sl [t2] "Z"))]
    (h/update-document-metadata admin-request d1 {"genre" "news"})
    {:d1 d1 :a a :b b :c c}))

(deftest metadata-exact
  (let [{:keys [a]} (build!)]
    (testing "spans whose metadata.translation = dog (C has no metadata; B is cat)"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?s"]
                       "where" [["span" "?s" {"layer" "MetaProj/pos" "metadata" {"translation" "dog"}}]]})]
        (is (= #{(str a)} (ids r)))))))

(deftest metadata-regex
  (let [{:keys [a]} (build!)]
    (testing "metadata value regex matches the decoded scalar"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?s"]
                       "where" [["span" "?s" {"layer" "MetaProj/pos" "metadata" {"translation" {"regex" "^d"}}}]]})]
        (is (= #{(str a)} (ids r)))))))

(deftest metadata-multiple-keys-and
  (let [{:keys [a]} (build!)]
    (testing "two metadata constraints AND together"
      (let [hit (qe/run db "admin@example.com"
                        {"find" ["?s"]
                         "where" [["span" "?s" {"layer" "MetaProj/pos"
                                                "metadata" {"translation" "dog" "num" "sg"}}]]})
            miss (qe/run db "admin@example.com"
                         {"find" ["?s"]
                          "where" [["span" "?s" {"layer" "MetaProj/pos"
                                                 "metadata" {"translation" "dog" "num" "pl"}}]]})]
        (is (= #{(str a)} (ids hit)))
        (is (empty? (ids miss)))))))

(deftest metadata-on-document
  (let [{:keys [d1]} (build!)]
    (testing "documents by metadata (entity_type = document)"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?d"] "where" [["document" "?d" {"metadata" {"genre" "news"}}]]})]
        (is (= #{(str d1)} (ids r)))))))

(deftest metadata-validation
  (testing "a bad regex inside metadata is a 400"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"invalid regex"
         (ast/expand {"find" ["?s"]
                      "where" [["span" "?s" {"layer" "MetaProj/pos"
                                             "metadata" {"k" {"regex" "(unclosed"}}}]]}))))
  (testing "a non-regex map metadata spec is a 400"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"must be a regex"
         (ast/expand {"find" ["?s"]
                      "where" [["span" "?s" {"layer" "MetaProj/pos"
                                             "metadata" {"k" {"oops" "1"}}}]]})))))
