(ns plaid.sql.query.exec-test
  "Integration tests for the query pipeline against a real (in-memory) DB.
  Builds a small corpus through the public REST helpers (as admin), then
  exercises `plaid.sql.query.exec/run` directly. The centerpiece is the
  cross-project ACL test: a user's query only sees projects they can read,
  granted explicitly via reader roles."
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
  "As admin: project/words-token-layer/pos-span-layer/doc/text 'aa bb cc' with
  three tokens and POS spans NOUN VERB NOUN. Returns the project id + span ids."
  [pname]
  (let [pid (h/create-test-project admin-request pname)
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "pos"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa bb cc"))
        t0 (id (h/create-token admin-request tokl text 0 2))
        t1 (id (h/create-token admin-request tokl text 3 5))
        t2 (id (h/create-token admin-request tokl text 6 8))]
    {:pid pid :pos sl :words tokl
     :noun0 (id (h/create-span admin-request sl [t0] "NOUN"))
     :verb1 (id (h/create-span admin-request sl [t1] "VERB"))
     :noun2 (id (h/create-span admin-request sl [t2] "NOUN"))}))

;; Layer-LESS spans: the legitimate way to query across every readable project
;; in one request. (A bare layer *name* is no longer a valid reference — layers
;; are identified by id only — so cross-project queries either omit the layer,
;; like here, or pin a layer id.)
(def ^:private noun-verb-query
  {"find" ["?s1" "?s2"]
   "where" [["span" "?s1" {"value" "NOUN"}]
            ["span" "?s2" {"value" "VERB"}]
            ["covers" "?s1" "?t1"] ["covers" "?s2" "?t2"]
            ["precedes" "?t1" "?t2"]]})

(defn- tuples [result] (mapv (fn [t] (mapv str t)) (:results result)))

(deftest noun-immediately-followed-by-verb
  (let [{:keys [noun0 verb1]} (build-corpus! "P1")
        result (qe/run db "admin@example.com" noun-verb-query)]
    (is (= ["s1" "s2"] (:columns result)))
    (testing "exactly the NOUN(tok0) -> VERB(tok1) pair; NOUN(tok2) has no following verb"
      (is (= 1 (:count result)))
      (is (= [[(str noun0) (str verb1)]] (tuples result))))))

(deftest precedes-star-is-transitive
  (let [{:keys [pos]} (build-corpus! "P1")]
    (testing "NOUN somewhere-before VERB: only NOUN@tok0 precedes VERB@tok1"
      (let [result (qe/run db "admin@example.com"
                           {"find" ["?s1" "?s2"]
                            "where" [["span" "?s1" {"layer" pos "value" "NOUN"}]
                                     ["span" "?s2" {"layer" pos "value" "VERB"}]
                                     ["covers" "?s1" "?t1"] ["covers" "?s2" "?t2"]
                                     ["precedes*" "?t1" "?t2"]]})]
        (is (= 1 (:count result)))))))

(deftest value-filter-and-limit
  (let [{:keys [pos]} (build-corpus! "P1")]
    (testing "all NOUN spans (two), bounded by :limit"
      (let [all (qe/run db "admin@example.com"
                        {"find" ["?s"] "where" [["span" "?s" {"layer" pos "value" "NOUN"}]]})
            one (qe/run db "admin@example.com"
                        {"find" ["?s"] "where" [["span" "?s" {"layer" pos "value" "NOUN"}]] "limit" 1})]
        (is (= 2 (:count all)))
        (is (= 1 (:count one)))))))

(deftest acl-cross-project-isolation
  (testing "two projects, each with a 'pos' layer + a NOUN->VERB pair; readers scoped"
    (let [c1 (build-corpus! "P1")
          c2 (build-corpus! "P2")]
      (h/add-project-reader admin-request (:pid c1) "user1@example.com")
      (h/add-project-reader admin-request (:pid c2) "user2@example.com")
      (testing "user1 (reader of P1) sees only their match"
        (let [r (qe/run db "user1@example.com" noun-verb-query)]
          (is (= 1 (:count r)))
          (is (= [[(str (:noun0 c1)) (str (:verb1 c1))]] (tuples r)))))
      (testing "user2 (reader of P2) sees only their match"
        (let [r (qe/run db "user2@example.com" noun-verb-query)]
          (is (= 1 (:count r)))
          (is (= [[(str (:noun0 c2)) (str (:verb1 c2))]] (tuples r)))))
      (testing "admin sees both projects' matches"
        (is (= 2 (:count (qe/run db "admin@example.com" noun-verb-query)))))
      (testing "explicit :scope narrows within what the user can read"
        (is (= 1 (:count (qe/run db "admin@example.com"
                                 (assoc noun-verb-query "scope" {"project-ids" [(:pid c1)]})))))))))

(deftest scope-rejects-inaccessible-project
  (let [c1 (build-corpus! "P1")
        c2 (build-corpus! "P2")]
    (h/add-project-reader admin-request (:pid c1) "user1@example.com")
    (testing "user1 (reader of P1 only) scoping to P2 -> no accessible projects -> 400"
      (is (= 400 (try (qe/run db "user1@example.com" (assoc noun-verb-query "scope" {"project-ids" [(:pid c2)]}))
                      nil
                      (catch clojure.lang.ExceptionInfo e (:code (ex-data e)))))))))

(deftest unresolvable-layer-is-400
  (build-corpus! "P1")
  (is (= 400 (try (qe/run db "admin@example.com"
                          {"find" ["?s"] "where" [["span" "?s" {"layer" "nonexistent-layer"}]]})
                  nil
                  (catch clojure.lang.ExceptionInfo e (:code (ex-data e)))))))

(deftest user-with-no-projects-gets-400
  (build-corpus! "P1")
  (testing "a user who can read nothing gets a clear 400, not an empty result"
    (is (= 400 (try (qe/run db "user2@example.com" noun-verb-query)
                    nil
                    (catch clojure.lang.ExceptionInfo e (:code (ex-data e))))))))
