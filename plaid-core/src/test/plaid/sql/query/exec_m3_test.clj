(ns plaid.sql.query.exec-m3-test
  "Integration tests for M3 :seq sugar: plain sequences (conjunctive desugar)
  and bounded quantifiers (UNION of unrolled branches). Builds real corpora
  through the REST helpers (as admin) and runs exec/run."
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
;; Plain seq (no quantifiers) = one branch, sugar for covers + precedes
;; ---------------------------------------------------------------------------

(defn- build-nvn-corpus!
  "words 'aa bb cc' with POS spans NOUN VERB NOUN. Returns span ids."
  []
  (let [pid (h/create-test-project admin-request "Seq1")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "pos"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa bb cc"))
        t0 (id (h/create-token admin-request tokl text 0 2))
        t1 (id (h/create-token admin-request tokl text 3 5))
        t2 (id (h/create-token admin-request tokl text 6 8))]
    {:noun0 (id (h/create-span admin-request sl [t0] "NOUN"))
     :verb1 (id (h/create-span admin-request sl [t1] "VERB"))
     :noun2 (id (h/create-span admin-request sl [t2] "NOUN"))}))

(deftest seq-plain-noun-verb
  (let [{:keys [noun0 verb1]} (build-nvn-corpus!)]
    (testing "[:seq {words} [NOUN :as ?s1] [VERB :as ?s2]] finds the adjacent pair"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?s1" "?s2"]
                       "where" [["seq" {"layer" "words"}
                                 ["span" {"layer" "pos" "value" "NOUN"} "as" "?s1"]
                                 ["span" {"layer" "pos" "value" "VERB"} "as" "?s2"]]]})]
        (is (= ["s1" "s2"] (:columns r)))
        (is (= 1 (:count r)))
        (is (= [[(str noun0) (str verb1)]] (tuples r)))))))

;; ---------------------------------------------------------------------------
;; Bounded quantifier: DET ADJ? NOUN -> UNION of the two unrolled lengths
;; ---------------------------------------------------------------------------

(defn- build-det-adj-noun-corpus!
  "words 'a dog a big cat' with POS: DET NOUN DET ADJ NOUN. So:
    - DET@t0 immediately precedes NOUN@t1  (the ADJ-absent branch)
    - DET@t2 -> ADJ@t3 -> NOUN@t4          (the ADJ-present branch)
  Returns the DET and NOUN span ids by position."
  []
  (let [pid (h/create-test-project admin-request "Seq2")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "pos"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "a dog a big cat"))
        t0 (id (h/create-token admin-request tokl text 0 1))
        t1 (id (h/create-token admin-request tokl text 2 5))
        t2 (id (h/create-token admin-request tokl text 6 7))
        t3 (id (h/create-token admin-request tokl text 8 11))
        t4 (id (h/create-token admin-request tokl text 12 15))]
    {:det0 (id (h/create-span admin-request sl [t0] "DET"))
     :noun1 (id (h/create-span admin-request sl [t1] "NOUN"))
     :det2 (id (h/create-span admin-request sl [t2] "DET"))
     :adj3 (id (h/create-span admin-request sl [t3] "ADJ"))
     :noun4 (id (h/create-span admin-request sl [t4] "NOUN"))}))

(def ^:private det-adj?-noun-query
  {"find" ["?d" "?n"]
   "where" [["seq" {"layer" "words"}
             ["span" {"layer" "pos" "value" "DET"} "as" "?d"]
             ["?" ["span" {"layer" "pos" "value" "ADJ"}]]
             ["span" {"layer" "pos" "value" "NOUN"} "as" "?n"]]]})

(deftest seq-optional-adjective-unions-both-lengths
  (let [{:keys [det0 noun1 det2 noun4]} (build-det-adj-noun-corpus!)]
    (testing "DET ADJ? NOUN catches both the adjacent and the ADJ-separated pair"
      (let [r (qe/run db "admin@example.com" det-adj?-noun-query)]
        (is (= ["d" "n"] (:columns r)))
        (is (= 2 (:count r)))
        (is (= #{[(str det0) (str noun1)] [(str det2) (str noun4)]}
               (set (tuples r))))))))

(deftest seq-rep-range-matches-each-length
  (let [{:keys [det0 noun1 det2 noun4]} (build-det-adj-noun-corpus!)]
    (testing ":rep 0 2 over ADJ subsumes both DET NOUN and DET ADJ NOUN"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?d" "?n"]
                       "where" [["seq" {"layer" "words"}
                                 ["span" {"layer" "pos" "value" "DET"} "as" "?d"]
                                 ["rep" 0 2 ["span" {"layer" "pos" "value" "ADJ"}]]
                                 ["span" {"layer" "pos" "value" "NOUN"} "as" "?n"]]]})]
        (is (= #{[(str det0) (str noun1)] [(str det2) (str noun4)]}
               (set (tuples r))))))))

(deftest seq-union-respects-limit
  (build-det-adj-noun-corpus!)
  (testing "a :limit applies once around the whole UNION"
    (let [r (qe/run db "admin@example.com" (assoc det-adj?-noun-query "limit" 1))]
      (is (= 1 (:count r))))))
