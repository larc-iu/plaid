(ns plaid.sql.query.exec-aggregate-test
  "Integration tests for aggregate :return — {group [...] aggregates [[op src?]...]}
  → GROUP BY over the distinct-match set. count/min/max/avg/sum."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h :refer [id]]
            [plaid.sql.query.exec :as qe]
            [plaid.sql.query.compile]
            [plaid.sql.query.resolve]
            [plaid.query.ast :as ast]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- build!
  "doc d1: 3 word tokens (begin 0/3/6); doc d2: 2 word tokens (begin 0/3).
  pos spans on d1 with numeric values 10, 20, 30."
  []
  (let [pid  (h/create-test-project admin-request "AggProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "pos"))
        d1   (h/create-test-document admin-request pid "d1")
        d2   (h/create-test-document admin-request pid "d2")
        tx1  (id (h/create-text admin-request txtl d1 "aa bb cc"))
        tx2  (id (h/create-text admin-request txtl d2 "aa bb"))
        t10 (id (h/create-token admin-request tokl tx1 0 2))
        t11 (id (h/create-token admin-request tokl tx1 3 5))
        t12 (id (h/create-token admin-request tokl tx1 6 8))
        _t20 (id (h/create-token admin-request tokl tx2 0 2))
        _t21 (id (h/create-token admin-request tokl tx2 3 5))]
    (h/create-span admin-request sl [t10] 10)
    (h/create-span admin-request sl [t11] 20)
    (h/create-span admin-request sl [t12] 30)
    {:d1 d1 :d2 d2 :words tokl :pos sl}))

(defn- by-key [r]
  "Map the first result column -> the rest of the row."
  (into {} (map (fn [row] [(str (first row)) (vec (rest row))]) (:results r))))

(deftest grouped-count-per-document
  (let [{:keys [d1 d2 words]} (build!)]
    (testing "word count per document in ONE query"
      (let [r (qe/run db "admin@example.com"
                      {"where" [["token" "?t" {"layer" words "doc" {"var" "?d"}}]]
                       "return" {"group" ["?d"] "aggregates" [["count"]]}})]
        (is (= :aggregate (:return r)))
        (is (= ["d" "count"] (:columns r)))
        (is (= {(str d1) [3] (str d2) [2]} (by-key r)))))))

(deftest overall-count-no-group
  (let [{:keys [words]} (build!)]
    (testing "no group keys -> a single overall row (generalizes return:count)"
      (let [r (qe/run db "admin@example.com"
                      {"where" [["token" "?t" {"layer" words}]]
                       "return" {"group" [] "aggregates" [["count"]]}})]
        (is (= [[5]] (:results r)))))))

(deftest min-max-avg-over-begin
  (let [{:keys [d1 d2 words]} (build!)]
    (testing "min/max/avg of a numeric scalar (token begin) per document"
      (let [r (qe/run db "admin@example.com"
                      {"where" [["token" "?t" {"layer" words "doc" {"var" "?d"} "begin" {"var" "?b"}}]]
                       "return" {"group" ["?d"]
                                 "aggregates" [["min" "?b"] ["max" "?b"] ["avg" "?b"]]}})
            m (by-key r)]
        (is (= ["d" "min_b" "max_b" "avg_b"] (:columns r)))
        (is (= [0 6 3.0] (get m (str d1))))
        (is (= [0 3] (subvec (get m (str d2)) 0 2)))
        (is (= 1.5 (double (nth (get m (str d2)) 2))))))))

(deftest sum-avg-over-numeric-value
  (let [{:keys [pos]} (build!)]
    (testing "sum/avg over a JSON-encoded numeric :value (json_extract-decoded)"
      (let [r (qe/run db "admin@example.com"
                      {"where" [["span" "?s" {"layer" pos "value" {"var" "?v"}}]]
                       "return" {"group" [] "aggregates" [["sum" "?v"] ["avg" "?v"]]}})]
        (is (= [[60 20.0]] (:results r)))))))

(deftest aggregate-over-or
  (let [{:keys [pos]} (build!)]
    (testing "count over an :or whose branches bind the SAME vars (UNION-safe)"
      (let [r (qe/run db "admin@example.com"
                      {"where" [["or"
                                 [["span" "?s" {"layer" pos "value" 10}]]
                                 [["span" "?s" {"layer" pos "value" 20}]]]]
                       "return" {"group" [] "aggregates" [["count"]]}})]
        ;; the value-10 span OR the value-20 span -> 2 distinct matches
        (is (= [[2]] (:results r)))))))

(deftest aggregate-asymmetric-branches
  ;; One alternative binds a variable the other does not. Both branches project
  ;; only the vars EVERY branch binds, so the count is the distinct bindings of
  ;; those — here of ?s, one span per alternative. It used to be refused with a
  ;; 400, because the projections had different shapes.
  (let [{:keys [pos words]} (build!)]
    (testing "an alternative may bind a variable another does not"
      (let [r (qe/run db "admin@example.com"
                      {"where" [["or"
                                 [["span" "?s" {"layer" pos "value" 10}]
                                  ["token" "?t" {"layer" words}]
                                  ["covers" "?s" "?t"]]
                                 [["span" "?s" {"layer" pos "value" 20}]]]]
                       "return" {"group" [] "aggregates" [["count"]]}})]
        (is (= [[2]] (:results r)) "the value-10 span and the value-20 span")))))

(deftest aggregate-over-or-counts-only-the-shared-variables
  ;; Ruling, 2026-09-21: an aggregate over `or` alternatives counts only the
  ;; variables EVERY alternative binds. A span that satisfies both
  ;; alternatives is one match, however many tokens the alternative that binds
  ;; ?t fans it out over. Before the ruling this query counted 3: two
  ;; (span, token) rows from the first alternative and one (span, NULL) from
  ;; the second.
  (let [pid (h/create-test-project admin-request "SharedVarProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl (id (h/create-span-layer admin-request tokl "pos"))
        doc (h/create-test-document admin-request pid "d1")
        tx (id (h/create-text admin-request txtl doc "aa bb cc"))
        t0 (id (h/create-token admin-request tokl tx 0 2))
        t1 (id (h/create-token admin-request tokl tx 3 5))
        _t2 (id (h/create-token admin-request tokl tx 6 8))
        _ (h/create-span admin-request sl [t0 t1] 10)
        count-of (fn [where]
                   (ffirst (:results (qe/run db "admin@example.com"
                                             {"where" where
                                              "return" {"group" [] "aggregates" [["count"]]}}))))]
    (testing "the span satisfying both alternatives counts once"
      (is (= 1 (count-of [["or"
                           [["span" "?s" {"layer" sl "value" 10}]
                            ["token" "?t" {"layer" tokl}]
                            ["covers" "?s" "?t"]]
                           [["span" "?s" {"layer" sl "value" 10}]]]]))))
    (testing "and the same alternative alone still counts every binding of ?t"
      (is (= 2 (count-of [["span" "?s" {"layer" sl "value" 10}]
                          ["token" "?t" {"layer" tokl}]
                          ["covers" "?s" "?t"]]))))))

(deftest aggregate-over-or-whose-alternatives-share-no-variable
  ;; The ruling's edge: alternatives binding DISJOINT entity variables, so the
  ;; set every alternative binds is empty. An aggregate counts only that set,
  ;; and every match here has the same (empty) key — one match where anything
  ;; matches at all. The projection had no columns, so the SQL was
  ;; `SELECT DISTINCT FROM …`, SQLite refused it and the endpoint answered
  ;; "Internal query error" (500).
  (let [{:keys [pos words]} (build!)
        empty-sl (id (h/create-span-layer admin-request words "unused"))]
    (testing "a bare count answers, and answers 1"
      (let [r (qe/run db "admin@example.com"
                      {"where" [["or"
                                 [["span" "?s" {"layer" pos}]]
                                 [["token" "?t" {"layer" words}]]]]
                       "return" {"group" [] "aggregates" [["count"]]}})]
        (is (= :aggregate (:return r)))
        (is (= ["count"] (:columns r)))
        (is (= [[1]] (:results r)))))
    (testing "and 0 when neither alternative matches anything"
      (let [r (qe/run db "admin@example.com"
                      {"where" [["or"
                                 [["span" "?s" {"layer" empty-sl}]]
                                 [["span" "?s2" {"layer" empty-sl}]]]]
                       "return" {"group" [] "aggregates" [["count"]]}})]
        (is (= [[0]] (:results r)))))
    (testing "a group key each alternative binds still gives the union of its values"
      (let [r (qe/run db "admin@example.com"
                      {"where" [["or"
                                 [["span" "?s" {"layer" pos "value" {"var" "?v"}}]]
                                 [["token" "?t" {"layer" words "begin" {"var" "?v"}}]]]]
                       "return" {"group" ["?v"] "aggregates" [["count"]]}})]
        (is (= ["v" "count"] (:columns r)))
        (is (= {"0" [1] "3" [1] "6" [1] "10" [1] "20" [1] "30" [1]} (by-key r)))))))

(deftest count-vs-find-tuple-divergence-under-fanout
  ;; Pins the documented subtlety: return:"count" counts distinct FIND tuples,
  ;; while an aggregate count over a one-to-many join counts MATCHES (all bound
  ;; vars). They diverge as soon as a covers/fan-out is present.
  (let [pid  (h/create-test-project admin-request "FanProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "pos"))
        doc  (h/create-test-document admin-request pid "d1")
        tx   (id (h/create-text admin-request txtl doc "aa bb cc"))
        t0 (id (h/create-token admin-request tokl tx 0 2))
        t1 (id (h/create-token admin-request tokl tx 3 5))
        t2 (id (h/create-token admin-request tokl tx 6 8))]
    (h/create-span admin-request sl [t0 t1] "X")  ; covers TWO tokens
    (h/create-span admin-request sl [t2] "Y")     ; covers one
    (let [where [["span" "?s" {"layer" sl}]
                 ["token" "?t" {"layer" tokl}]
                 ["covers" "?s" "?t"]]
          tuple-count (:count (qe/run db "admin@example.com"
                                      {"find" ["?s"] "where" where "return" "count"}))
          match-count (ffirst (:results (qe/run db "admin@example.com"
                                                {"where" where "return" {"group" [] "aggregates" [["count"]]}})))]
      (testing "return:count = distinct spans (2); group:[] count = span×token matches (3)"
        (is (= 2 tuple-count))
        (is (= 3 match-count))
        (is (not= tuple-count match-count))))))

(deftest aggregate-validation
  (testing ":find is rejected alongside an aggregate :return"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #":find is not used with an aggregate"
         (ast/expand {"find" ["?t"]
                      "where" [["token" "?t" {"layer" "AggProj/words"}]]
                      "return" {"group" [] "aggregates" [["count"]]}}))))
  (testing "an aggregate source must be a value variable, not an entity"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"must be a value variable"
         (ast/expand {"where" [["token" "?t" {"layer" "AggProj/words"}]]
                      "return" {"group" [] "aggregates" [["avg" "?t"]]}}))))
  (testing "count takes no source"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"takes no source"
         (ast/expand {"where" [["token" "?t" {"layer" "AggProj/words" "begin" {"var" "?b"}}]]
                      "return" {"group" [] "aggregates" [["count" "?b"]]}}))))
  (testing "an unknown aggregate op is a 400"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"is not supported"
         (ast/expand {"where" [["token" "?t" {"layer" "AggProj/words" "begin" {"var" "?b"}}]]
                      "return" {"group" [] "aggregates" [["median" "?b"]]}})))))

;; A group key that is a metadata field of an entity var which is itself a group
;; key is read once per group, after the grouping, instead of once per match
;; (igt's project-wide link count reads an entry's morph type 94k times rather
;; than 346k). The results must be exactly what reading it per match gives.
(deftest a-metadata-key-of-a-grouped-var-is-read-once-per-group
  (let [{:keys [d1 d2 words pos]} (build!)
        _ (h/update-document-metadata admin-request d1 {"genre" "news" "meta" {"n" 2}})
        run (fn [body] (qe/run db "admin@example.com" body))
        per-match (fn [body] (with-redefs [plaid.sql.query.compile/deferred-group-keys (fn [& _] {})]
                               (run body)))
        shapes {"key after its var"
                {"where" [["token" "?t" {"layer" words}] ["document" "?d" {}] ["=" "?t.doc" "?d"]]
                 "return" {"group" ["?d" "?d.metadata.genre"] "aggregates" [["count"]]}}
                "key before its var, and a nested path"
                {"where" [["token" "?t" {"layer" words}] ["document" "?d" {}] ["=" "?t.doc" "?d"]]
                 "return" {"group" ["?d.metadata.meta.n" "?t.value" "?d"] "aggregates" [["count"]]}}
                "under or"
                {"where" [["token" "?t" {"layer" words}] ["document" "?d" {}] ["=" "?t.doc" "?d"]
                          ["or"
                           [["span" "?s" {"layer" pos "value" 10}] ["covers" "?s" "?t"]]
                           [["span" "?s" {"layer" pos "value" 30}] ["covers" "?s" "?t"]]]]
                 "return" {"group" ["?d" "?d.metadata.genre"] "aggregates" [["count"]]}}}]
    (doseq [[label body] shapes]
      (testing label
        (is (= 1 (count (:deferred-group (plaid.sql.query.compile/aggregate-plan
                                          (plaid.sql.query.compile/compile-query
                                           (plaid.sql.query.resolve/resolve-query
                                            db "admin@example.com" (first (ast/expand body))))))))
            "the key is read after the grouping")
        (is (= (set (:results (per-match body))) (set (:results (run body))))
            "the same groups and counts as reading the key for every match")))
    (testing "the key is read after the grouping and does not split a group"
      (let [r (run (shapes "key after its var"))]
        (is (= {(str d1) ["news" 3] (str d2) [nil 2]} (by-key r)))
        (is (= ["d" "d_metadata_genre" "count"] (:columns r)))))
    (testing "a metadata key of a var that is NOT grouped is still read per match"
      (let [r (run {"where" [["token" "?t" {"layer" words}] ["document" "?d" {}] ["=" "?t.doc" "?d"]]
                    "return" {"group" ["?d.metadata.genre"] "aggregates" [["count"]]}})]
        (is (= #{["news" 3] [nil 2]} (set (:results r))))))))

(deftest aggregate-group-key-of-one-alternative-is-null-in-the-others
  ;; A group key may name a variable that only some `or` alternatives bind:
  ;; where an alternative does not bind it, the key reads null. So two
  ;; alternatives can each group by a field of their own variable (igt's link
  ;; precedent groups a word by its value and a morpheme by its form). Before
  ;; 2026-11-18 such a key was refused with a 400.
  (let [{:keys [words pos]} (build!)
        where [["span" "?s" {"layer" pos}]
               ["or"
                [["covers" "?s" "?t"] ["token" "?t" {"layer" words}] ["<" "?t.begin" 4]]
                [["covers" "?s" "?u"] ["token" "?u" {"layer" words}] [">=" "?u.begin" 4]]]]
        run (fn [ret] (qe/run db "admin@example.com" {"where" where "return" ret}))]
    (testing "each alternative's key, null in the other's rows"
      (let [r (run {"group" ["?t.begin" "?u.end"] "aggregates" [["count"]]})]
        (is (= ["t_begin" "u_end" "count"] (:columns r)))
        (is (= #{[0 nil 1] [3 nil 1] [nil 8 1]} (set (:results r))))))
    (testing "with a value both alternatives share"
      (let [r (run {"group" ["?s.value" "?t.begin"] "aggregates" [["count"]]})]
        (is (= #{[10 0 1] [20 3 1] [30 nil 1]} (set (:results r))))))
    (testing "the variable itself, and a metadata key of it, are keys too"
      (let [r (run {"group" ["?t" "?t.metadata.k" "?u.end"] "aggregates" [["count"]]})]
        (is (= 3 (count (:results r))))
        (is (= 1 (count (filter (fn [[t _ u]] (and (nil? t) (= 8 u))) (:results r)))))))
    (testing "an aggregate's source must still be bound in every alternative"
      (is (= 400 (try (run {"group" [] "aggregates" [["sum" "?t.begin"]]}) nil
                      (catch clojure.lang.ExceptionInfo e (:code (ex-data e)))))))))

(deftest padded-count-counts-what
  ;; REV-CQ2-1: alternatives that share no variable, grouped as query.adoc's
  ;; example under `or` groups them. A `count` counts the matches of each
  ;; alternative's own variable, as the same count on one layer does. It
  ;; used to answer 1 for every group, because the union merged rows that
  ;; differ only in the token.
  (let [pid   (h/create-test-project admin-request "PaddedCount")
        txtl  (id (h/create-text-layer admin-request pid "text"))
        words (id (h/create-token-layer admin-request txtl "words"))
        morph (id (h/create-token-layer admin-request txtl "morphemes"))
        mk (fn [dname body toks]
             (let [doc (h/create-test-document admin-request pid dname)
                   tx (id (h/create-text admin-request txtl doc body))]
               (doseq [[layer b e form] toks]
                 (h/create-token admin-request ({:w words :m morph} layer) tx b e nil
                                 (when form {"form" form})))))
        _ (mk "d1" "ab ab cd" [[:w 0 2] [:w 3 5] [:w 6 8] [:m 0 1 "a"] [:m 1 2 "b"] [:m 6 8 "cd"]])
        _ (mk "d2" "cd ab" [[:w 0 2] [:w 3 5] [:m 3 5 "ab"]])
        _ (mk "d3" "ab 😀ab" [[:w 0 2] [:w 3 6] [:m 3 4 "😀"] [:m 4 6]])
        run (fn [where group] (set (:results (qe/run db "admin@example.com"
                                                     {"scope" {"project-ids" [pid]} "where" where
                                                      "return" {"group" group "aggregates" [["count"]]}}))))
        either [["or" [["token" "?w" {"layer" words}]] [["token" "?m" {"layer" morph}]]]]
        alone-w (run [["token" "?t" {"layer" words}]] ["?t.value"])
        alone-m (run [["token" "?t" {"layer" morph}]] ["?t.metadata.form"])]
    (is (= #{["ab" 4] ["cd" 2] ["😀ab" 1]} alone-w))
    (is (= #{["a" 1] ["b" 1] ["cd" 1] ["ab" 1] ["😀" 1] [nil 1]} alone-m))
    (testing "each group counts its own tokens"
      (is (= (into (set (map (fn [[v n]] [v nil n]) alone-w))
                   (map (fn [[v n]] [nil v n]) alone-m))
             (run either ["?w.value" "?m.metadata.form"]))))
    (testing "a padded null and a real null of the other alternative's key are one group (REV-CQ2-2)"
      ;; no word has metadata x, and one morpheme has no form
      (is (= #{[nil nil 8] [nil "a" 1] [nil "b" 1] [nil "cd" 1] [nil "ab" 1] [nil "😀" 1]}
             (run either ["?w.metadata.x" "?m.metadata.form"]))))))
