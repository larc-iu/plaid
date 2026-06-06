(ns plaid.sql.query.exec-attrpred-test
  "Integration tests for the Datalog-style attribute-predicate clauses — the `~`
  (regex) and `in` (membership) ops, plus the reference dot-paths `?s.layer` /
  `?r.source` / `?r.target`. The contract is EQUIVALENCE: each triple form must
  return the IDENTICAL rows to its constraint-map form (same compile path, no
  fork). Plus the new-op validation 400s, a ReDoS 408, and cross-project ACL
  parity (the centerpiece)."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [r] (-> r :body :id))
(defn- ids [r] (set (map (comp str first) (:results r))))
(defn- run [q] (qe/run db "admin@example.com" q))

(defn- build!
  "Project AP: words tokens aa@0 bb@3 cc@6 dd@9; pos spans A=NOUN@t0 {genre news},
  B=PROPN@t1 {genre naval}, C=VERB@t2, D=NOUN@t3; a dep relation R: A->B (nsubj)."
  []
  (let [pid  (h/create-test-project admin-request "AP")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        pos  (id (h/create-span-layer admin-request tokl "pos"))
        dep  (id (h/create-relation-layer admin-request pos "dep"))
        doc  (h/create-test-document admin-request pid "d1")
        tx   (id (h/create-text admin-request txtl doc "aa bb cc dd"))
        t0 (id (h/create-token admin-request tokl tx 0 2))
        t1 (id (h/create-token admin-request tokl tx 3 5))
        t2 (id (h/create-token admin-request tokl tx 6 8))
        t3 (id (h/create-token admin-request tokl tx 9 11))
        a  (id (h/create-span admin-request pos [t0] "NOUN" {"genre" "news"}))
        b  (id (h/create-span admin-request pos [t1] "PROPN" {"genre" "naval"}))
        c  (id (h/create-span admin-request pos [t2] "VERB"))
        d  (id (h/create-span admin-request pos [t3] "NOUN"))
        r  (id (h/create-relation admin-request dep a b "nsubj"))]
    {:pid pid :pos pos :dep dep
     :t0 t0 :t1 t1 :t2 t2 :t3 t3 :a a :b b :c c :d d :r r}))

;; ---------------------------------------------------------------------------
;; G2 `in` — equivalence with the {value [..]} alternation constraint
;; ---------------------------------------------------------------------------

(deftest in-value-equivalence
  (let [{:keys [a b d]} (build!)]
    (testing "[in ?s.value [NOUN PROPN]] == {value [NOUN PROPN]}"
      (let [triple (run {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos"}]
                                                ["in" "?s.value" ["NOUN" "PROPN"]]]})
            cmap   (run {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos" "value" ["NOUN" "PROPN"]}]]})]
        (is (= #{(str a) (str b) (str d)} (ids triple)))
        (is (= (ids cmap) (ids triple)))))))

(deftest in-token-surface-equivalence
  (let [{:keys [t0 t2]} (build!)]
    (testing "[in ?t.value [aa cc]] (surface substrings) == token {value [aa cc]}"
      (let [triple (run {"find" ["?t"] "where" [["token" "?t" {"layer" "AP/words"}]
                                                ["in" "?t.value" ["aa" "cc"]]]})
            cmap   (run {"find" ["?t"] "where" [["token" "?t" {"layer" "AP/words" "value" ["aa" "cc"]}]]})]
        (is (= #{(str t0) (str t2)} (ids triple)))
        (is (= (ids cmap) (ids triple)))))))

(deftest in-metadata-equivalence
  (let [{:keys [a]} (build!)]
    (testing "[in ?s.metadata.genre [news]] == {metadata {genre [news]}}"
      (let [triple (run {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos"}]
                                                ["in" "?s.metadata.genre" ["news"]]]})
            cmap   (run {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos" "metadata" {"genre" ["news"]}}]]})]
        (is (= #{(str a)} (ids triple)))
        (is (= (ids cmap) (ids triple)))))))

;; ---------------------------------------------------------------------------
;; G1 `~` — equivalence with the {value {regex}} constraint
;; ---------------------------------------------------------------------------

(deftest regex-value-equivalence
  (let [{:keys [a d]} (build!)]
    (testing "[~ ?s.value ^N] (and the bare-string form) == {value {regex ^N}}"
      (let [spec  (run {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos"}]
                                               ["~" "?s.value" {"regex" "^N"}]]})
            bare  (run {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos"}]
                                               ["~" "?s.value" "^N"]]})
            cmap  (run {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos" "value" {"regex" "^N"}}]]})]
        (is (= #{(str a) (str d)} (ids spec)))   ; NOUN matches ^N; PROPN/VERB don't
        (is (= (ids spec) (ids bare)))
        (is (= (ids cmap) (ids spec)))))
    (testing "anchors run on the DECODED value (not the JSON \"NOUN\")"
      (is (= #{(str a) (str d)}
             (ids (run {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos"}]
                                               ["~" "?s.value" "^NOUN$"]]})))))))

(deftest regex-flags-equivalence
  (let [{:keys [a b d]} (build!)]
    (testing "flags i folds case, matching {value {regex flags}}"
      (let [triple (run {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos"}]
                                                ["~" "?s.value" {"regex" "n" "flags" "i"}]]})
            cmap   (run {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos" "value" {"regex" "n" "flags" "i"}}]]})]
        ;; NOUN, PROPN, NOUN all contain an n/N case-insensitively; VERB does not
        (is (= #{(str a) (str b) (str d)} (ids triple)))
        (is (= (ids cmap) (ids triple)))))))

(deftest regex-token-surface-and-metadata
  (let [{:keys [t0 b]} (build!)]
    (testing "~ on a token surface == token {value {regex}}"
      (is (= #{(str t0)}
             (ids (run {"find" ["?t"] "where" [["token" "?t" {"layer" "AP/words"}]
                                               ["~" "?t.value" "^a"]]})))))
    (testing "~ on metadata == {metadata {k {regex}}}"
      (let [triple (run {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos"}]
                                                ["~" "?s.metadata.genre" "^na"]]})
            cmap   (run {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos" "metadata" {"genre" {"regex" "^na"}}}]]})]
        (is (= #{(str b)} (ids triple)))   ; "naval" starts na; "news" does not
        (is (= (ids cmap) (ids triple)))))))

;; ---------------------------------------------------------------------------
;; G3 — reference dot-paths join exactly like their constraint-map / clause forms
;; ---------------------------------------------------------------------------

(deftest layer-ref-equivalence
  (let [{:keys [pos a b c d]} (build!)]
    (testing "[= ?s.layer ?sl] + a span-layer binder == {layer ?sl}"
      (let [triple (run {"find" ["?s"] "where" [["span" "?s" {"layer" "?sl"}]
                                                ["span-layer" "?sl" {"name" "pos"}]
                                                ["=" "?s.layer" "?sl"]]})
            cmap   (run {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos"}]]})]
        (is (= #{(str a) (str b) (str c) (str d)} (ids triple)))
        (is (= (ids cmap) (ids triple)))))
    (testing "[= ?s.layer <pos-uuid>] == {layer <pos-uuid>} (ids are strings on the wire)"
      (let [triple (run {"find" ["?s"] "where" [["span" "?s"] ["=" "?s.layer" (str pos)]]})
            cmap   (run {"find" ["?s"] "where" [["span" "?s" {"layer" (str pos)}]]})]
        (is (= #{(str a) (str b) (str c) (str d)} (ids triple)))
        (is (= (ids cmap) (ids triple)))))))

(deftest relation-endpoint-ref-equivalence
  (let [{:keys [a b]} (build!)]
    (testing "[= ?r.source ?sp] == [source ?r ?sp] == inline {source ?sp}"
      (let [via-eq     (run {"find" ["?sp"] "where" [["relation" "?r" {"layer" "AP/dep"}]
                                                     ["span" "?sp"] ["=" "?r.source" "?sp"]]})
            via-clause (run {"find" ["?sp"] "where" [["relation" "?r" {"layer" "AP/dep"}]
                                                     ["span" "?sp"] ["source" "?r" "?sp"]]})
            via-inline (run {"find" ["?sp"] "where" [["relation" "?r" {"layer" "AP/dep" "source" "?sp"}]
                                                     ["span" "?sp"]]})]
        (is (= #{(str a)} (ids via-eq)))
        (is (= (ids via-clause) (ids via-eq)))
        (is (= (ids via-inline) (ids via-eq)))))
    (testing "[= ?r.target ?sp] picks the target span"
      (is (= #{(str b)}
             (ids (run {"find" ["?sp"] "where" [["relation" "?r" {"layer" "AP/dep"}]
                                                ["span" "?sp"] ["=" "?r.target" "?sp"]]})))))))

(deftest in-on-bound-entity-var
  (let [{:keys [a c]} (build!)]
    (testing "in over a bare entity var's id == an id membership filter"
      (is (= #{(str a) (str c)}
             (ids (run {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos"}]
                                               ["in" "?s" [(str a) (str c)]]]})))))))

;; ---------------------------------------------------------------------------
;; Composition: ~/in inside :or (post-expansion the dispatch must still route them)
;; ---------------------------------------------------------------------------

(deftest attr-preds-compose-with-or
  (let [{:keys [a b c d]} (build!)]
    (testing "or of two ~ branches unions the matches"
      ;; ^N -> NOUN {a,d}; ^V -> VERB {c}
      (is (= #{(str a) (str c) (str d)}
             (ids (run {"find" ["?s"]
                        "where" [["span" "?s" {"layer" "AP/pos"}]
                                 ["or" [["~" "?s.value" "^N"]] [["~" "?s.value" "^V"]]]]})))))
    (testing "or mixing in and ~ unions the matches"
      (is (= #{(str a) (str b) (str d)}
             (ids (run {"find" ["?s"]
                        "where" [["span" "?s" {"layer" "AP/pos"}]
                                 ["or" [["in" "?s.value" ["PROPN"]]] [["~" "?s.value" "^N"]]]]})))))))

;; ---------------------------------------------------------------------------
;; Validation 400s (exec surface — the parse/validate layer is also unit-tested
;; in plaid.query.ast-test)
;; ---------------------------------------------------------------------------

(defn- code-of [q]
  (try (run q) nil (catch clojure.lang.ExceptionInfo e (:code (ex-data e)))))

(deftest validation-400s
  (build!)
  (testing "~ on a numeric/opaque/reference field is a 400"
    (is (= 400 (code-of {"find" ["?t"] "where" [["token" "?t" {"layer" "AP/words"}] ["~" "?t.begin" "1"]]})))
    (is (= 400 (code-of {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos"}] ["~" "?s.doc" "x"]]})))
    (is (= 400 (code-of {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos"}] ["~" "?s.layer" "x"]]}))))
  (testing "in with an empty / non-scalar list is a 400"
    (is (= 400 (code-of {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos"}] ["in" "?s.value" []]]}))))
  (testing "an ordering op on a reference field is a 400"
    (is (= 400 (code-of {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos"}] ["span-layer" "?sl"]
                                                ["<" "?s.layer" "?sl"]]}))))
  (testing "G4: a NAME literal against a reference field is a loud 400 (= and in)"
    (is (= 400 (code-of {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos"}] ["=" "?s.layer" "pos"]]})))
    (is (= 400 (code-of {"find" ["?s"] "where" [["span" "?s" {"layer" "AP/pos"}] ["in" "?s.layer" ["pos"]]]})))))

;; ---------------------------------------------------------------------------
;; Safety: a catastrophic regex aborts (408), it does not hang
;; ---------------------------------------------------------------------------

(deftest regex-redos-is-aborted
  (let [pid  (h/create-test-project admin-request "ApDos")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "w"))
        sl   (id (h/create-span-layer admin-request tokl "lemma"))
        doc  (h/create-test-document admin-request pid "d")
        text (id (h/create-text admin-request txtl doc "x"))
        t0   (id (h/create-token admin-request tokl text 0 1))]
    (h/create-span admin-request sl [t0] (apply str (repeat 32 "a")))
    (testing "a `~` catastrophic-backtracking pattern is aborted by the watchdog"
      (binding [qe/*query-timeout-ms* 1000]
        (let [start (System/nanoTime)
              code  (try (qe/run db "admin@example.com"
                                 {"find" ["?s"] "where" [["span" "?s" {"layer" "ApDos/lemma"}]
                                                         ["~" "?s.value" "(.*a){28}"]]})
                         nil
                         (catch clojure.lang.ExceptionInfo e (:code (ex-data e))))
              ms    (/ (- (System/nanoTime) start) 1e6)]
          (is (= 408 code) "must abort with a 408 timeout")
          (is (< ms 20000) (str "must not hang (took " (long ms) "ms)")))))))

;; ---------------------------------------------------------------------------
;; ACL parity: a triple gives a reader exactly what the constraint map does, and
;; a triple naming an out-of-scope layer id leaks nothing (empty, never a 400)
;; ---------------------------------------------------------------------------

(deftest acl-cross-project-parity
  (let [c1 (build!)
        ;; a second, independent project with its own pos layer + NOUN span
        p2   (h/create-test-project admin-request "AP2")
        txtl (id (h/create-text-layer admin-request p2 "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        pos2 (id (h/create-span-layer admin-request tokl "pos"))
        doc  (h/create-test-document admin-request p2 "d2")
        tx   (id (h/create-text admin-request txtl doc "zz"))
        t    (id (h/create-token admin-request tokl tx 0 2))
        n2   (id (h/create-span admin-request pos2 [t] "NOUN"))]
    (h/add-project-reader admin-request (:pid c1) "user1@example.com")
    (testing "user1 (reader of P1) running a ~/in query sees only P1's spans"
      (let [r (qe/run db "user1@example.com"
                      {"find" ["?s"] "where" [["span" "?s"] ["in" "?s.value" ["NOUN"]]]})]
        (is (= #{(str (:a c1)) (str (:d c1))} (set (map (comp str first) (:results r)))))
        (is (not (contains? (set (map (comp str first) (:results r))) (str n2))))))
    (testing "user1 referencing P2's layer id via a triple gets EMPTY (no leak, no 400)"
      (let [r (qe/run db "user1@example.com"
                      {"find" ["?s"] "where" [["span" "?s"] ["=" "?s.layer" (str pos2)]]})]
        (is (= 0 (:count r)))
        (is (empty? (:results r)))))))
