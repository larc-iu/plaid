(ns plaid.sql.bulk-update-test
  "Task #102.5 — bulk-update-by-id! edge cases the higher-level callers
  don't reliably hit:
    - empty input  -> []        (no SQL, no audit rows)
    - single id    -> 1 audit row
    - sparse attrs -> per-row attrs union into a single CASE-expression
                      UPDATE; rows that omit a column keep their pre-image.

  Tests run `bulk-update-by-id!` directly inside a `submit-operation!`
  body — avoids exercising the higher-level token/text callers, which
  layer their own validation and could mask helper-level regressions."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin with-clean-db
                                    assert-created]]
            [plaid.sql.common :as psc]
            [plaid.sql.operation :as op]
            [plaid.test-helpers :refer [create-test-project create-test-document
                                        create-text-layer create-token-layer
                                        create-text create-token]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- setup-fixture! [name-prefix]
  (let [proj (create-test-project admin-request (str name-prefix "Proj"))
        doc (create-test-document admin-request proj (str name-prefix "Doc"))
        tl-res (create-text-layer admin-request proj (str name-prefix "TL"))
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        tkl-res (create-token-layer admin-request tl (str name-prefix "TKL"))
        tkl (-> tkl-res :body :id)
        _ (assert-created tkl-res)
        text-res (create-text admin-request tl doc "abcdefghij")
        text-id (-> text-res :body :id)
        _ (assert-created text-res)
        t1 (-> (create-token admin-request tkl text-id 0 3) :body :id)
        t2 (-> (create-token admin-request tkl text-id 3 6) :body :id)]
    {:proj proj :doc doc :text-id text-id :token-layer tkl :t1 t1 :t2 t2}))

(defn- audit-rows-for-op [op-id]
  (psc/q db {:select [:*] :from [:audit_writes]
             :where [:= :op_id op-id]
             :order-by [:seq]}))

(defn- latest-op-id [op-type]
  (-> (psc/q1 db {:select [:id] :from [:operations]
                  :where [:= :op_type op-type]
                  :order-by [[:ts :desc]] :limit 1})
      :id))

(deftest bulk-update-empty-input-returns-empty-vector
  (testing "empty map input -> [] result, no audit rows"
    (let [{:keys [proj]} (setup-fixture! "BulkEmpty")
          ;; Run an op that does nothing but call bulk-update-by-id! with {}.
          result (op/submit-operation!
                  [tx db {:type :test/bulk-update-empty
                          :project proj
                          :description "empty bulk-update"
                          :user "admin@example.com"}]
                  (psc/bulk-update-by-id! tx :tokens {}))
          op-id (latest-op-id "test/bulk-update-empty")
          rows (audit-rows-for-op op-id)]
      (is (:success result) (str "op should succeed: " result))
      (is (= [] (:extra result)) "extra should be the empty result vector")
      ;; No row-level audit writes emitted by the helper itself.
      (is (every? #(not= "tokens" (:target_table %)) rows)
          (str "expected no tokens-audit rows for empty input; got " rows)))))

(deftest bulk-update-single-id-emits-one-audit-row
  (testing "single id -> exactly 1 audit row"
    (let [{:keys [proj t1]} (setup-fixture! "BulkOne")
          _ (op/submit-operation!
             [tx db {:type :test/bulk-update-one
                     :project proj
                     :description "single bulk-update"
                     :user "admin@example.com"}]
             (psc/bulk-update-by-id! tx :tokens {t1 {:begin 1}}))
          op-id (latest-op-id "test/bulk-update-one")
          token-rows (filter #(= "tokens" (:target_table %))
                             (audit-rows-for-op op-id))]
      (is (= 1 (count token-rows))
          (str "Expected exactly one tokens-audit row; got " (count token-rows)
               " — " token-rows))
      (is (= "update" (-> token-rows first :change_type))
          "the single row must be an :update"))))

(deftest bulk-update-sparse-attrs-per-row
  (testing "row 1 has :begin only; row 2 has :end_ only — each row keeps
            its unchanged column via the :else fallback in the CASE
            expression, and each row emits its own audit row."
    (let [{:keys [proj t1 t2]} (setup-fixture! "BulkSparse")
          pre-t1 (psc/fetch-by-id db :tokens t1)
          pre-t2 (psc/fetch-by-id db :tokens t2)
          _ (op/submit-operation!
             [tx db {:type :test/bulk-update-sparse
                     :project proj
                     :description "sparse bulk-update"
                     :user "admin@example.com"}]
             (psc/bulk-update-by-id! tx :tokens
                                     {t1 {:begin 1}
                                      t2 {:end_ 9}}))
          post-t1 (psc/fetch-by-id db :tokens t1)
          post-t2 (psc/fetch-by-id db :tokens t2)
          op-id (latest-op-id "test/bulk-update-sparse")
          token-rows (filter #(= "tokens" (:target_table %))
                             (audit-rows-for-op op-id))]
      ;; t1 :begin changed; :end_ preserved.
      (is (= 1 (:begin post-t1)))
      (is (= (:end_ pre-t1) (:end_ post-t1))
          (str "t1 :end_ must be preserved by the :else fallback"))
      ;; t2 :end_ changed; :begin preserved.
      (is (= 9 (:end_ post-t2)))
      (is (= (:begin pre-t2) (:begin post-t2))
          (str "t2 :begin must be preserved by the :else fallback"))
      ;; Both rows produce one audit row each (the helper skips no-op
      ;; rows; these are real changes so both emit).
      (is (= 2 (count token-rows))
          (str "Expected one audit row per updated token; got "
               (count token-rows) " — " token-rows)))))
