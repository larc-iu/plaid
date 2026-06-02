(ns plaid.sql.query.exec-m2-test
  "Integration tests for M2 query clauses: :within / :first-in (token
  hierarchy via offset containment) and :vocab / :vocab-link. Builds real
  corpora through the REST helpers (as admin) and runs exec/run."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [resp] (-> resp :body :id))
(defn- tuples [r] (mapv (fn [t] (mapv str t)) (:results r)))

;; ---------------------------------------------------------------------------
;; Hierarchy: :within + :first-in
;; ---------------------------------------------------------------------------

(defn- build-hierarchy-corpus!
  "Text 'aa bb cc': one sentence [0,8], three words and three morphemes at
  [0,2] [3,5] [6,8]. Morphemes [0,2] and [3,5] are glossed PPTC. Layers are
  flat (offset containment is what :within uses), so token creation is
  unconstrained. Returns the morpheme ids by offset."
  []
  (let [pid  (h/create-test-project admin-request "HierProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        sent (id (h/create-token-layer admin-request txtl "sentences"))
        word (id (h/create-token-layer admin-request txtl "words"))
        morph (id (h/create-token-layer admin-request txtl "morphemes"))
        gl   (id (h/create-span-layer admin-request morph "gloss"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa bb cc"))
        _s   (h/create-token admin-request sent text 0 8)
        w0 (id (h/create-token admin-request word text 0 2))
        w1 (id (h/create-token admin-request word text 3 5))
        w2 (id (h/create-token admin-request word text 6 8))
        m0 (id (h/create-token admin-request morph text 0 2))
        m1 (id (h/create-token admin-request morph text 3 5))
        m2 (id (h/create-token admin-request morph text 6 8))]
    (h/create-span admin-request gl [m0] "PPTC")
    (h/create-span admin-request gl [m1] "PPTC")
    (h/create-span admin-request gl [m2] "OTHER")
    {:pid pid :m0 m0 :m1 m1 :m2 m2 :w0 w0 :w1 w1 :w2 w2}))

(deftest within-and-first-in
  (let [{:keys [m0]} (build-hierarchy-corpus!)]
    (testing "morpheme glossed PPTC inside a word that is sentence-initial"
      ;; m0 (word [0,2], the first word) qualifies; m1 (word [3,5], not
      ;; sentence-initial) is glossed PPTC but its word is not first-in.
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?m"]
                       "where" [["span" "?g" {"layer" "gloss" "value" "PPTC"}]
                                ["covers" "?g" "?m"]
                                ["token" "?m" {"layer" "morphemes"}]
                                ["within" "?m" "?w"] ["token" "?w" {"layer" "words"}]
                                ["within" "?w" "?s"] ["token" "?s" {"layer" "sentences"}]
                                ["first-in" "?w" "?s"]]})]
        (is (= 1 (:count r)))
        (is (= [[(str m0)]] (tuples r)))))))

(deftest within-without-first-in
  (let [{:keys [m0 m1]} (build-hierarchy-corpus!)]
    (testing "drop first-in: both PPTC morphemes (in words within the sentence) match"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?m"]
                       "where" [["span" "?g" {"layer" "gloss" "value" "PPTC"}]
                                ["covers" "?g" "?m"]
                                ["token" "?m" {"layer" "morphemes"}]
                                ["within" "?m" "?w"] ["token" "?w" {"layer" "words"}]
                                ["within" "?w" "?s"] ["token" "?s" {"layer" "sentences"}]]})]
        (is (= 2 (:count r)))
        (is (= #{(str m0) (str m1)} (set (map first (tuples r)))))))))

(deftest within-excludes-self-and-reverse
  (testing ":within over a single layer never matches a token with itself"
    (let [pid  (h/create-test-project admin-request "WithinSelf")
          txtl (id (h/create-text-layer admin-request pid "text"))
          tokl (id (h/create-token-layer admin-request txtl "toks" "any"))
          doc  (h/create-test-document admin-request pid "d1")
          text (id (h/create-text admin-request txtl doc "abcd"))
          outer (id (h/create-token admin-request tokl text 0 4))
          inner (id (h/create-token admin-request tokl text 1 3))
          r (qe/run db "admin@example.com"
                    {"find" ["?c" "?p"]
                     "where" [["token" "?c" {"layer" "toks"}]
                              ["token" "?p" {"layer" "toks"}]
                              ["within" "?c" "?p"]]})]
      ;; only inner-within-outer; NOT (outer,outer)/(inner,inner) self, NOT (outer,inner)
      (is (= 1 (:count r)))
      (is (= [[(str inner) (str outer)]] (tuples r))))))

;; ---------------------------------------------------------------------------
;; Vocab: :vocab + :vocab-link
;; ---------------------------------------------------------------------------

(defn- build-vocab-corpus!
  "Project with a words layer + a vocab layer 'lex' granted to it. Token
  'aa' is vocab-linked to item 'Kemal'; 'bb' to 'other'. Returns ids."
  [pname]
  (let [pid  (h/create-test-project admin-request pname)
        txtl (id (h/create-text-layer admin-request pid "text"))
        word (id (h/create-token-layer admin-request txtl "words"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa bb"))
        t0 (id (h/create-token admin-request word text 0 2))
        t1 (id (h/create-token admin-request word text 3 5))
        vl (id (h/create-vocab-layer admin-request (str pname "-lex")))
        _  (h/link-vocab-to-project admin-request pid vl)
        kemal (id (h/create-vocab-item admin-request vl "Kemal"))
        other (id (h/create-vocab-item admin-request vl "other"))]
    (h/create-vocab-link admin-request kemal [t0])
    (h/create-vocab-link admin-request other [t1])
    {:pid pid :t0 t0 :t1 t1 :vl vl :kemal kemal}))

(deftest tokens-linked-to-vocab-item
  (let [{:keys [t0]} (build-vocab-corpus! "VocabProj")]
    (testing "tokens linked to vocab item with form 'Kemal'"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?t"]
                       "where" [["vocab" "?v" {"form" "Kemal"}]
                                ["vocab-link" "?t" "?v"]]})]
        (is (= 1 (:count r)))
        (is (= [[(str t0)]] (tuples r)))))))

(deftest vocab-scoped-by-project-grant
  (testing "a reader of a project sees vocab granted to that project, but not another's"
    (let [c1 (build-vocab-corpus! "VP1")
          c2 (build-vocab-corpus! "VP2")]
      (h/add-project-reader admin-request (:pid c1) "user1@example.com")
      ;; user1 reads VP1 only. Both projects have a 'Kemal' item, but in
      ;; vocab layers granted to different projects.
      (let [r (qe/run db "user1@example.com"
                      {"find" ["?t"]
                       "where" [["vocab" "?v" {"form" "Kemal"}]
                                ["vocab-link" "?t" "?v"]]})]
        (is (= 1 (:count r)))
        (is (= [[(str (:t0 c1))]] (tuples r)))))))
