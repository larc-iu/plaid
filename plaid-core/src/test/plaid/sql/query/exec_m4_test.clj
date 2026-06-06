(ns plaid.sql.query.exec-m4-test
  "M4: result shapes (:return :entities / :count) and result-size guardrails
  (default limit, hard cap, :truncated flag)."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [clojure.string :as str]
            [honey.sql :as hsql]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [resp] (-> resp :body :id))

(defn- build-corpus!
  "Project `pname`: words layer + pos span layer; n NOUN spans over n tokens in
  text 'aa bb cc dd ee' (5 slots). Returns {:pid :span-ids [ids in order]}."
  [pname n]
  (let [pid  (h/create-test-project admin-request pname)
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "pos"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa bb cc dd ee"))
        offs (take n [[0 2] [3 5] [6 8] [9 11] [12 14]])
        sids (mapv (fn [[b e]]
                     (let [t (id (h/create-token admin-request tokl text b e))]
                       (id (h/create-span admin-request sl [t] "NOUN"))))
                   offs)]
    {:pid pid :span-ids sids :sl sl}))

(defn- noun-q [pos]
  {"find" ["?s"] "where" [["span" "?s" {"layer" pos "value" "NOUN"}]]})

;; ---------------------------------------------------------------------------
;; Guardrail policy (pure)
;; ---------------------------------------------------------------------------

(deftest effective-limit-policy
  (let [eff #'qe/effective-limit]
    (testing "no :limit -> default 1000"
      (is (= 1000 (eff nil))))
    (testing "explicit :limit below the cap is honored"
      (is (= 50 (eff 50))))
    (testing "explicit :limit above the cap is clamped to 100000"
      (is (= 100000 (eff 999999))))))

;; ---------------------------------------------------------------------------
;; :return :count
;; ---------------------------------------------------------------------------

(deftest count-is-exact-and-ignores-limit
  (let [{:keys [sl]} (build-corpus! "CountProj" 3)]
    (testing ":count returns the true number of matches, unaffected by :limit"
      (is (= {:return :count :count 3 :truncated false}
             (qe/run db "admin@example.com" (assoc (noun-q sl) "return" "count"))))
      (is (= 3 (:count (qe/run db "admin@example.com"
                               (assoc (noun-q sl) "return" "count" "limit" 1))))))))

(deftest count-query-is-bounded
  (testing "the count query caps its inner subquery so a runaway cross-product can't materialize"
    (let [cap @#'qe/count-cap
          formatted (hsql/format (#'qe/count-query [{:select-distinct [[:t.id :x]] :from [[:tokens :t]]}]))
          sql (first formatted)
          params (rest formatted)]
      (is (str/includes? (str/lower-case sql) "limit"))
      (is (some #(= (inc cap) %) params)
          (str "inner subquery limited to count-cap+1; got " formatted)))))

;; ---------------------------------------------------------------------------
;; :return :entities
;; ---------------------------------------------------------------------------

(deftest entities-hydrate-to-rest-wire-shape
  (let [{:keys [span-ids sl]} (build-corpus! "EntProj" 2)]
    (testing "each cell is the full namespaced entity map (same shape as GET /spans/:id)"
      (let [r (qe/run db "admin@example.com" (assoc (noun-q sl) "return" "entities"))
            ents (map first (:results r))]
        (is (= :entities (:return r)))
        (is (= 2 (:count r)))
        (is (every? map? ents))
        (is (every? #(= "NOUN" (:span/value %)) ents))
        ;; ids round-trip and every span carries its ordered token vector
        (is (= (set (map str span-ids)) (set (map (comp str :span/id) ents))))
        (is (every? #(= 1 (count (:span/tokens %))) ents))))))

(deftest entities-hydrate-token-relation-vocab
  (testing "hydration works for every entity kind, not just spans (each uses a different get fn)"
    (let [pid  (h/create-test-project admin-request "EntKinds")
          txtl (id (h/create-text-layer admin-request pid "text"))
          tokl (id (h/create-token-layer admin-request txtl "words"))
          sl   (id (h/create-span-layer admin-request tokl "pos"))
          rl   (id (h/create-relation-layer admin-request sl "dep"))
          doc  (h/create-test-document admin-request pid "d1")
          text (id (h/create-text admin-request txtl doc "aa bb"))
          t0 (id (h/create-token admin-request tokl text 0 2))
          t1 (id (h/create-token admin-request tokl text 3 5))
          s0 (id (h/create-span admin-request sl [t0] "NOUN"))
          s1 (id (h/create-span admin-request sl [t1] "VERB"))
          r0 (id (h/create-relation admin-request rl s1 s0 "nsubj"))
          vl (id (h/create-vocab-layer admin-request "EntKinds-lex"))
          _  (h/link-vocab-to-project admin-request pid vl)
          kemal (id (h/create-vocab-item admin-request vl "Kemal"))
          _  (h/create-vocab-link admin-request kemal [t0])]
      (testing "token entity"
        (let [e (-> (qe/run db "admin@example.com"
                            {"find" ["?t"] "where" [["token" "?t" {"layer" tokl "begin" 0}]]
                             "return" "entities"}) :results ffirst)]
          (is (= (str t0) (str (:token/id e))))
          (is (= 0 (:token/begin e)))))
      (testing "relation entity carries source/target"
        (let [e (-> (qe/run db "admin@example.com"
                            {"find" ["?r"] "where" [["relation" "?r" {"layer" rl "value" "nsubj"}]]
                             "return" "entities"}) :results ffirst)]
          (is (= (str r0) (str (:relation/id e))))
          (is (= "nsubj" (:relation/value e)))
          (is (= (str s1) (str (:relation/source e))))
          (is (= (str s0) (str (:relation/target e))))))
      (testing "vocab-item entity carries form"
        (let [e (-> (qe/run db "admin@example.com"
                            {"find" ["?v"] "where" [["vocab" "?v" {"form" "Kemal"}]]
                             "return" "entities"}) :results ffirst)]
          (is (= (str kemal) (str (:vocab-item/id e))))
          (is (= "Kemal" (:vocab-item/form e))))))))

(deftest entities-respect-acl
  (testing ":entities is scoped like :ids — a reader sees only their project"
    (let [c1 (build-corpus! "EP1" 2)
          _  (build-corpus! "EP2" 2)]
      (h/add-project-reader admin-request (:pid c1) "user1@example.com")
      (let [r (qe/run db "user1@example.com" (assoc (noun-q (:sl c1)) "return" "entities"))]
        (is (= 2 (:count r)))
        (is (= (set (map str (:span-ids c1)))
               (set (map (comp str :span/id first) (:results r)))))))))

;; ---------------------------------------------------------------------------
;; Truncation guardrail
;; ---------------------------------------------------------------------------

(deftest truncated-flag-reflects-limit
  (let [{:keys [sl]} (build-corpus! "TruncProj" 3)]
    (testing "hitting the effective limit sets :truncated"
      (let [r (qe/run db "admin@example.com" (assoc (noun-q sl) "limit" 2))]
        (is (= 2 (:count r)))
        (is (true? (:truncated r)))))
    (testing "a limit above the match count does not truncate"
      (let [r (qe/run db "admin@example.com" (assoc (noun-q sl) "limit" 10))]
        (is (= 3 (:count r)))
        (is (false? (:truncated r)))))
    (testing "no :limit on a small result is not truncated (default 1000 not reached)"
      (let [r (qe/run db "admin@example.com" (noun-q sl))]
        (is (= 3 (:count r)))
        (is (false? (:truncated r)))))))
