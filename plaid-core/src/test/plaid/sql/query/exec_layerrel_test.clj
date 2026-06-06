(ns plaid.sql.query.exec-layerrel-test
  "Integration tests for layer-to-layer STRUCTURAL relationships: a layer clause
  may reference its immutable parent layer via a structural slot named after the
  domain attribute — token-layer's `text-layer` / `parent-token-layer`, span-layer's
  `token-layer`, relation-layer's `span-layer`. The slot holds a layer variable
  (binds + joins the parent node) or a scalar layer reference (resolved to one
  layer), exactly like the entity `layer` slot. ACL centerpiece: a structural ref
  can never reach a layer outside the caller's scope."
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
(defn- run
  ([q] (run "admin@example.com" q))
  ([user q] (qe/run db user q)))

(defn- build!
  "A full layer tree in project `pname`:
    text layers : Transcription  (+ a bare Translation, for negative chaining)
    token layers: sentences (root) > words (parent-token-layer = sentences)
    span layer  : pos  >  relation layer deprel
  over text 'aa bb': sentence S0@0-5; word tokens t0@0-2 t1@3-5;
  pos spans NOUN@t0 / VERB@t1; deprel relation NOUN -> VERB."
  [pname]
  (let [pid   (h/create-test-project admin-request pname)
        txtl  (id (h/create-text-layer admin-request pid "Transcription"))
        txl2  (id (h/create-text-layer admin-request pid "Translation"))
        ;; a parent token layer must be non-overlapping (so child containment is unambiguous)
        sentl (id (h/create-token-layer admin-request txtl "sentences" "non-overlapping"))
        wordl (id (h/create-token-layer-opts admin-request txtl "words" {:parent-token-layer-id sentl}))
        pos   (id (h/create-span-layer admin-request wordl "pos"))
        depr  (id (h/create-relation-layer admin-request pos "deprel"))
        doc   (h/create-test-document admin-request pid "d1")
        text  (id (h/create-text admin-request txtl doc "aa bb"))
        _S0   (id (h/create-token admin-request sentl text 0 5))
        t0    (id (h/create-token admin-request wordl text 0 2))
        t1    (id (h/create-token admin-request wordl text 3 5))
        noun  (id (h/create-span admin-request pos [t0] "NOUN"))
        verb  (id (h/create-span admin-request pos [t1] "VERB"))
        rel   (id (h/create-relation admin-request depr noun verb "nsubj"))]
    {:pid pid :txtl txtl :txl2 txl2 :sentl sentl :wordl wordl :pos pos :depr depr
     :noun noun :verb verb :rel rel}))

(def ^:private chain
  "A span whose span-layer's token-layer's text-layer is named Transcription."
  {"find" ["?s"]
   "where" [["span" "?s" {"layer" "?sl"}]
            ["span-layer" "?sl" {"token-layer" "?tl"}]
            ["token-layer" "?tl" {"text-layer" "?txtl"}]
            ["text-layer" "?txtl" {"name" "Transcription"}]]})

(deftest chain-span-through-layers-to-text-layer-name
  (let [{:keys [noun verb]} (build! "LR1")]
    (testing "spans up the layer tree to a text layer named Transcription -> both pos spans"
      (is (= #{(str noun) (str verb)} (ids (run chain)))))
    (testing "named Translation (a bare text layer with no token layers) -> none"
      (is (empty? (ids (run (assoc-in chain ["where" 3 2 "name"] "Translation"))))))))

(deftest scalar-slot-equals-var-plus-name
  (let [{:keys [txtl noun verb]} (build! "LR2")
        ;; one-clause scalar ref (by layer id) on the token layer's text-layer slot
        scalar (ids (run {"find" ["?s"]
                          "where" [["span" "?s" {"layer" "?sl"}]
                                   ["span-layer" "?sl" {"token-layer" "?tl"}]
                                   ["token-layer" "?tl" {"text-layer" (str txtl)}]]}))]
    (testing "a scalar text-layer id reference yields exactly the var + name-clause form"
      (is (= #{(str noun) (str verb)} scalar))
      (is (= scalar (ids (run chain)))))))

(deftest parent-token-layer-nesting
  (let [{:keys [sentl wordl]} (build! "LR3")]
    (testing "the token layer whose parent is named 'sentences' is 'words'"
      (is (= #{(str wordl)}
             (ids (run {"find" ["?w"]
                        "where" [["token-layer" "?w" {"parent-token-layer" "?s"}]
                                 ["token-layer" "?s" {"name" "sentences"}]]})))))
    (testing "projecting the parent layer var of 'words' returns the sentences layer"
      (is (= #{(str sentl)}
             (ids (run {"find" ["?s"]
                        "where" [["token-layer" "?w" {"parent-token-layer" "?s" "name" "words"}]]})))))))

(deftest relation-layer-through-span-layer
  (let [{:keys [rel]} (build! "LR4")]
    (testing "relations whose relation-layer's span-layer is named 'pos'"
      (is (= #{(str rel)}
             (ids (run {"find" ["?r"]
                        "where" [["relation" "?r" {"layer" "?rl"}]
                                 ["relation-layer" "?rl" {"span-layer" "?sl"}]
                                 ["span-layer" "?sl" {"name" "pos"}]]})))))))

(deftest cross-project-acl
  (let [p1 (build! "LRP1")
        p2 (build! "LRP2")]
    (h/add-project-reader admin-request (:pid p1) "user1@example.com")
    (testing "admin sees both projects' spans through the structural chain"
      (is (= #{(str (:noun p1)) (str (:verb p1)) (str (:noun p2)) (str (:verb p2))}
             (ids (run chain)))))
    (testing "user1 (reader of P1) sees ONLY P1's spans — the structural join cannot reach P2's text layer"
      (is (= #{(str (:noun p1)) (str (:verb p1))} (ids (run "user1@example.com" chain)))))
    ;; a scalar structural ref (by id) is scope-confined: P2's text-layer id resolves
    ;; for admin (P2 in scope) but is invisible to user1 (only P1 readable) -> 400.
    (let [p2-scalar {"find" ["?s"]
                     "where" [["span" "?s" {"layer" "?sl"}]
                              ["span-layer" "?sl" {"token-layer" "?tl"}]
                              ["token-layer" "?tl" {"text-layer" (str (:txtl p2))}]]}]
      (testing "admin (P2 in scope) gets P2's spans via P2's text-layer id"
        (is (= #{(str (:noun p2)) (str (:verb p2))} (ids (run p2-scalar)))))
      (testing "user1 (reader of P1 only) -> 400, P2's text layer is not visible in scope"
        (is (= 400 (try (run "user1@example.com" p2-scalar)
                        (catch clojure.lang.ExceptionInfo e (:code (ex-data e))))))))))

(deftest structural-scalar-ref-must-be-an-id
  (let [{:keys [txtl noun verb]} (build! "LR6")]
    (testing "a non-uuid structural scalar ref is a 400 (layers are identified by id only)"
      (is (= 400 (try (run {"find" ["?s"]
                            "where" [["span" "?s" {"layer" "?sl"}]
                                     ["span-layer" "?sl" {"token-layer" "?tl"}]
                                     ["token-layer" "?tl" {"text-layer" "Transcription"}]]})
                      (catch clojure.lang.ExceptionInfo e (:code (ex-data e)))))))
    (testing "a structural ref given by layer id resolves"
      (is (= #{(str noun) (str verb)}
             (ids (run {"find" ["?s"]
                        "where" [["span" "?s" {"layer" "?sl"}]
                                 ["span-layer" "?sl" {"token-layer" "?tl"}]
                                 ["token-layer" "?tl" {"text-layer" (str txtl)}]]})))))
    (testing "a structural variable (joined parent) resolves"
      (is (= #{(str noun) (str verb)}
             (ids (run chain)))))))

(deftest structural-slot-inside-not-correlates
  ;; Regression (review f58a7e2): a structural slot on a CORRELATED layer var inside
  ;; :not was a no-op in compile-not!, so the FK correlation was dropped — the :not
  ;; degraded to "exists ANY layer named sentences", returning empty for everything.
  (let [{:keys [sentl wordl]} (build! "LR7")]
    (testing "token layers WITHOUT a parent named 'sentences' -> sentences (no parent), NOT words"
      (let [got (ids (run {"find" ["?tl"]
                           "where" [["token-layer" "?tl" {}]
                                    ["not" ["token-layer" "?tl" {"parent-token-layer" "?p"}]
                                     ["token-layer" "?p" {"name" "sentences"}]]]}))]
        (is (contains? got (str sentl)) "sentences has no parent -> kept")
        (is (not (contains? got (str wordl))) "words' parent IS sentences -> excluded")))))

(deftest name-filter-inside-not-correlates
  ;; Regression (pre-existing, surfaced by the review): a correlated layer var's
  ;; :name filter inside :not was dropped too (NOT EXISTS (SELECT 1 WHERE TRUE)
  ;; -> always false -> always empty). Now emitted inside the subquery.
  (let [{:keys [noun verb]} (build! "LR8")]
    (testing "spans on a layer named 'pos' that is NOT also named 'deprel' -> all pos spans"
      (is (= #{(str noun) (str verb)}
             (ids (run {"find" ["?s"]
                        "where" [["span" "?s" {"layer" "?sl"}]
                                 ["span-layer" "?sl" {"name" "pos"}]
                                 ["not" ["span-layer" "?sl" {"name" "deprel"}]]]})))))))
