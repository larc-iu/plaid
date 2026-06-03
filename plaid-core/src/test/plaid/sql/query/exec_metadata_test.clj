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

(defn- build-kinds!
  "One of each metadatable entity carrying `tag=keep` (plus an untagged sibling),
  to exercise every kind->meta-type mapping (token/relation/vocab-item/text), not
  just span/document."
  []
  (let [pid  (h/create-test-project admin-request "MetaKinds")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "pos"))
        rl   (id (h/create-relation-layer admin-request sl "dep"))
        vl   (id (h/create-vocab-layer admin-request "lex"))
        _    (h/link-vocab-to-project admin-request pid vl)
        d1   (h/create-test-document admin-request pid "doc-1")
        text (id (h/create-text admin-request txtl d1 "aa bb"))
        t0 (id (h/create-token admin-request tokl text 0 2 nil {"tag" "keep"}))
        t1 (id (h/create-token admin-request tokl text 3 5))
        sa (id (h/create-span admin-request sl [t0] "A"))
        sb (id (h/create-span admin-request sl [t1] "B"))
        r0 (id (h/create-relation admin-request rl sa sb "nsubj" {"tag" "keep"}))
        vi (id (h/create-vocab-item admin-request vl "dog" {"tag" "keep"}))]
    (h/update-text-metadata admin-request text {"tag" "keep"})
    {:t0 t0 :r0 r0 :vi vi :text text}))

(deftest metadata-on-all-kinds
  (let [{:keys [t0 r0 vi text]} (build-kinds!)]
    (testing "token metadata (entity_type = token)"
      (is (= #{(str t0)}
             (ids (qe/run db "admin@example.com"
                          {"find" ["?t"] "where" [["token" "?t" {"layer" "MetaKinds/words"
                                                                 "metadata" {"tag" "keep"}}]]})))))
    (testing "relation metadata (entity_type = relation)"
      (is (= #{(str r0)}
             (ids (qe/run db "admin@example.com"
                          {"find" ["?r"] "where" [["relation" "?r" {"layer" "MetaKinds/dep"
                                                                    "metadata" {"tag" "keep"}}]]})))))
    (testing "vocab-item metadata (entity_type = vocab-item)"
      (is (= #{(str vi)}
             (ids (qe/run db "admin@example.com"
                          {"find" ["?v"] "where" [["vocab" "?v" {"layer" "lex"
                                                                 "metadata" {"tag" "keep"}}]]})))))
    (testing "text metadata (entity_type = text)"
      (is (= #{(str text)}
             (ids (qe/run db "admin@example.com"
                          {"find" ["?x"] "where" [["text" "?x" {"metadata" {"tag" "keep"}}]]})))))))

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
