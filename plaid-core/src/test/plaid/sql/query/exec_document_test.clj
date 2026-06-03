(ns plaid.sql.query.exec-document-test
  "Integration tests for :document and :text entity clauses, and the
  annotation<->document join (a scalar :doc var equated to a :document var)."
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
  "two docs: interview-1 (text 'hello world', span A) and interview-2
  (text 'goodbye now', span B)."
  []
  (let [pid  (h/create-test-project admin-request "DocProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "pos"))
        d1   (h/create-test-document admin-request pid "interview-1")
        d2   (h/create-test-document admin-request pid "interview-2")
        tx1  (id (h/create-text admin-request txtl d1 "hello world"))
        tx2  (id (h/create-text admin-request txtl d2 "goodbye now"))
        t1   (id (h/create-token admin-request tokl tx1 0 5))
        t2   (id (h/create-token admin-request tokl tx2 0 7))
        a    (id (h/create-span admin-request sl [t1] "A"))
        b    (id (h/create-span admin-request sl [t2] "B"))]
    {:d1 d1 :d2 d2 :tx1 tx1 :tx2 tx2 :a a :b b}))

(deftest document-standalone
  (let [{:keys [d1 d2]} (build!)]
    (testing "list documents by exact name"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?d"] "where" [["document" "?d" {"name" "interview-2"}]]})]
        (is (= #{(str d2)} (ids r)))))
    (testing "list documents by name regex"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?d"] "where" [["document" "?d" {"name" {"regex" "^interview-"}}]]})]
        (is (= #{(str d1) (str d2)} (ids r)))))))

(deftest spans-in-named-document
  (let [{:keys [a]} (build!)]
    (testing "spans whose document is named interview-1 (scalar :doc var = :document var)"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?s"]
                       "where" [["span" "?s" {"layer" "DocProj/pos" "doc" {"var" "?dv"}}]
                                ["document" "?d" {"name" "interview-1"}]
                                ["=" "?dv" "?d"]]})]
        (is (= #{(str a)} (ids r)))))))

(deftest text-body-search
  (let [{:keys [tx1]} (build!)]
    (testing "texts whose body matches a regex"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?t"] "where" [["text" "?t" {"body" {"regex" "hello"}}]]})]
        (is (= #{(str tx1)} (ids r)))))
    (testing "no text matches an absent term"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?t"] "where" [["text" "?t" {"body" {"regex" "zzz"}}]]})]
        (is (empty? (ids r)))))))

(deftest document-entities-hydrate
  (let [{:keys [d1]} (build!)]
    (testing ":return entities hydrates a document to its REST shape"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?d"] "where" [["document" "?d" {"name" "interview-1"}]]
                       "return" "entities"})
            doc (ffirst (:results r))]
        (is (= (str d1) (str (:document/id doc))))
        (is (= "interview-1" (:document/name doc)))))))
