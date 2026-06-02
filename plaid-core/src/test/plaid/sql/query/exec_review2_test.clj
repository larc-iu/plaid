(ns plaid.sql.query.exec-review2-test
  "Round-2 review fixes at the exec/SQL level: conjunctive constraint AND (a var
  in two entity clauses must satisfy both — no last-wins merge), an ambiguous
  scalar layer reference is a 400 (not a silent IN-list fan-out / implicit OR),
  and the query timeout (408)."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h]
            [plaid.sql.common :as psc]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [r] (-> r :body :id))
(defn- code-of [f] (try (f) :no-throw (catch clojure.lang.ExceptionInfo e (:code (ex-data e)))))

(defn- build!
  "Project `pname` with a words token-layer + pos span-layer, doc 'aa bb', a NOUN
  span over the first token and a VERB span over the second."
  [pname]
  (let [pid  (h/create-test-project admin-request pname)
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "pos"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa bb"))
        t0 (id (h/create-token admin-request tokl text 0 2))
        t1 (id (h/create-token admin-request tokl text 3 5))]
    (h/create-span admin-request sl [t0] "NOUN")
    (h/create-span admin-request sl [t1] "VERB")
    pid))

;; ---------------------------------------------------------------------------
;; Conjunctive AND across repeated vars (was: last-wins merge -> false positives)
;; ---------------------------------------------------------------------------

(deftest repeated-var-constraints-are-anded
  (build! "RP1")
  (testing "value NOUN in one clause AND value VERB in another is unsatisfiable (0), not VERB"
    (is (= 0 (:count (qe/run db "admin@example.com"
                             {"find" ["?s"]
                              "where" [["span" "?s" {"layer" "RP1/pos" "value" "NOUN"}]
                                       ["span" "?s" {"layer" "RP1/pos" "value" "VERB"}]]})))))
  (testing "compatible constraints split across clauses combine (AND), not drop"
    (is (= 1 (:count (qe/run db "admin@example.com"
                             {"find" ["?s"]
                              "where" [["span" "?s" {"layer" "RP1/pos"}]
                                       ["span" "?s" {"value" "NOUN"}]]}))))))

;; ---------------------------------------------------------------------------
;; Ambiguous scalar layer reference -> 400
;; ---------------------------------------------------------------------------

(deftest ambiguous-layer-name-is-400
  (build! "RP1")
  (build! "RP2")
  (testing "a bare layer name matching layers in two in-scope projects is a 400 (no silent fan-out)"
    (is (= 400 (code-of #(qe/run db "admin@example.com"
                                 {"find" ["?s"] "where" [["span" "?s" {"layer" "pos" "value" "NOUN"}]]})))))
  (testing "a unique path still resolves to exactly one layer"
    (is (= 1 (:count (qe/run db "admin@example.com"
                             {"find" ["?s"] "where" [["span" "?s" {"layer" "RP1/pos" "value" "NOUN"}]]}))))))

;; ---------------------------------------------------------------------------
;; Query timeout -> 408
;; ---------------------------------------------------------------------------

(deftest runaway-query-times-out-408
  (testing "a query past the time limit is interrupted (SQLite interrupt) and reported as 408"
    (binding [qe/*query-timeout-ms* 1000]
      (is (= 408 (code-of
                  #(#'qe/run-bounded
                    db
                    (fn [conn]
                      (psc/q conn ["WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM r) SELECT count(*) AS n FROM r"])))))))))
