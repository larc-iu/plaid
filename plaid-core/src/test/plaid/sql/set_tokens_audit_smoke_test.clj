(ns plaid.sql.set-tokens-audit-smoke-test
  "Smoke test for the span/set-tokens audit fix: verifies that update-span-tokens
  produces an audit_writes row against :spans whose pre/post JSON images carry
  the ordered token-id vector under :tokens."
  (:require [clojure.test :refer :all]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin assert-created assert-ok with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(deftest set-tokens-audit-smoke
  (let [proj (create-test-project admin-request "SetTokAuditProj")
        doc (create-test-document admin-request proj "SetTokAuditDoc")
        tl  (-> (create-text-layer admin-request proj "STL") :body :id)
        tid (-> (create-text admin-request tl doc "abcdef") :body :id)
        tkl (-> (create-token-layer admin-request tl "STKL") :body :id)
        t1  (-> (create-token admin-request tkl tid 0 2) :body :id)
        t2  (-> (create-token admin-request tkl tid 2 4) :body :id)
        t3  (-> (create-token admin-request tkl tid 4 6) :body :id)
        sl  (-> (create-span-layer admin-request tkl "SSL") :body :id)
        sid (-> (create-span admin-request sl [t1 t2] "v") :body :id)]
    (assert-ok (update-span-tokens admin-request sid [t2 t3]))
    ;; The span now has [t2 t3] as its tokens.
    (let [r (get-span admin-request sid)]
      (assert-ok r)
      (is (= [t2 t3] (-> r :body :span/tokens))))
    ;; Look up the audit_writes scoped to THIS span (avoid cross-test pollution
    ;; on the shared file-backed DB). The set-tokens op emits exactly one row
    ;; against :spans whose target_id is this span id.
    (let [writes (psc/q db {:select [:aw.*]
                            :from [[:audit_writes :aw]]
                            :join [[:operations :o] [:= :o.id :aw.op_id]]
                            :where [:and
                                    [:= :o.op_type "span/update-tokens"]
                                    [:= :aw.target_table "spans"]
                                    [:= :aw.target_id (str sid)]]
                            :order-by [[:aw.ts :desc]] :limit 1})]
      (println :--smoke-write-count (count writes))
      (is (= 1 (count writes)) "exactly one span audit row scoped to this span id")
      (let [w (first writes)
            pre  (psc/read-json (:pre_image w))
            post (psc/read-json (:post_image w))]
        (println :--smoke-target-table (:target_table w))
        (println :--smoke-change-type (:change_type w))
        (println :--smoke-pre-tokens  (:tokens pre))
        (println :--smoke-post-tokens (:tokens post))
        (println :--smoke-pre-value   (:value pre))
        (println :--smoke-post-value  (:value post))
        (is (= "spans" (:target_table w))            "audit row targets :spans")
        (is (= "update" (:change_type w))            "change_type = update")
        (is (= [(str t1) (str t2)] (:tokens pre))    "pre-image carries old token list")
        (is (= [(str t2) (str t3)] (:tokens post))   "post-image carries new token list")
        ;; The span row state is preserved too — useful for replay.
        (is (some? (:value pre)) "pre-image carries the span row's :value column")
        (is (some? (:value post)) "post-image carries the span row's :value column")))))
