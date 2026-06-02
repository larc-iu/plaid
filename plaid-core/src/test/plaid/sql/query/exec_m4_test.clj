(ns plaid.sql.query.exec-m4-test
  "M4: result shapes (:return :entities / :count) and result-size guardrails
  (default limit, hard cap, :truncated flag)."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
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
    {:pid pid :span-ids sids}))

(def ^:private noun-q
  {"find" ["?s"] "where" [["span" "?s" {"layer" "pos" "value" "NOUN"}]]})

;; ---------------------------------------------------------------------------
;; Guardrail policy (pure)
;; ---------------------------------------------------------------------------

(deftest effective-limit-policy
  (let [eff #'qe/effective-limit]
    (testing "no :limit -> default 100"
      (is (= 100 (eff nil))))
    (testing "explicit :limit below the cap is honored"
      (is (= 50 (eff 50))))
    (testing "explicit :limit above the cap is clamped to 1000"
      (is (= 1000 (eff 99999))))))

;; ---------------------------------------------------------------------------
;; :return :count
;; ---------------------------------------------------------------------------

(deftest count-is-exact-and-ignores-limit
  (build-corpus! "CountProj" 3)
  (testing ":count returns the true number of matches, unaffected by :limit"
    (is (= {:return :count :count 3}
           (qe/run db "admin@example.com" (assoc noun-q "return" "count"))))
    (is (= 3 (:count (qe/run db "admin@example.com"
                             (assoc noun-q "return" "count" "limit" 1)))))))

;; ---------------------------------------------------------------------------
;; :return :entities
;; ---------------------------------------------------------------------------

(deftest entities-hydrate-to-rest-wire-shape
  (let [{:keys [span-ids]} (build-corpus! "EntProj" 2)]
    (testing "each cell is the full namespaced entity map (same shape as GET /spans/:id)"
      (let [r (qe/run db "admin@example.com" (assoc noun-q "return" "entities"))
            ents (map first (:results r))]
        (is (= :entities (:return r)))
        (is (= 2 (:count r)))
        (is (every? map? ents))
        (is (every? #(= "NOUN" (:span/value %)) ents))
        ;; ids round-trip and every span carries its ordered token vector
        (is (= (set (map str span-ids)) (set (map (comp str :span/id) ents))))
        (is (every? #(= 1 (count (:span/tokens %))) ents))))))

(deftest entities-respect-acl
  (testing ":entities is scoped like :ids — a reader sees only their project"
    (let [c1 (build-corpus! "EP1" 2)
          _  (build-corpus! "EP2" 2)]
      (h/add-project-reader admin-request (:pid c1) "user1@example.com")
      (let [r (qe/run db "user1@example.com" (assoc noun-q "return" "entities"))]
        (is (= 2 (:count r)))
        (is (= (set (map str (:span-ids c1)))
               (set (map (comp str :span/id first) (:results r)))))))))

;; ---------------------------------------------------------------------------
;; Truncation guardrail
;; ---------------------------------------------------------------------------

(deftest truncated-flag-reflects-limit
  (build-corpus! "TruncProj" 3)
  (testing "hitting the effective limit sets :truncated"
    (let [r (qe/run db "admin@example.com" (assoc noun-q "limit" 2))]
      (is (= 2 (:count r)))
      (is (true? (:truncated r)))))
  (testing "a limit above the match count does not truncate"
    (let [r (qe/run db "admin@example.com" (assoc noun-q "limit" 10))]
      (is (= 3 (:count r)))
      (is (false? (:truncated r)))))
  (testing "no :limit on a small result is not truncated (default 100 not reached)"
    (let [r (qe/run db "admin@example.com" noun-q)]
      (is (= 3 (:count r)))
      (is (false? (:truncated r))))))
