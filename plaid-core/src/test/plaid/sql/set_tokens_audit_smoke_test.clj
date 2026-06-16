(ns plaid.sql.set-tokens-audit-smoke-test
  "Smoke test for the span/set-tokens audit fix: verifies that update-span-tokens
  produces an audit_writes row against :spans whose post-image JSON carries the
  new ordered token-id vector under :tokens (the log is post-image-only)."
  (:require [clojure.test :refer :all]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin assert-created assert-ok
                                    assert-no-content with-clean-db]]
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
            post (psc/read-json (:post_image w))]
        (println :--smoke-target-table (:target_table w))
        (println :--smoke-change-type (:change_type w))
        (println :--smoke-post-tokens (:tokens post))
        (println :--smoke-post-value  (:value post))
        (is (= "spans" (:target_table w))            "audit row targets :spans")
        (is (= "update" (:change_type w))            "change_type = update")
        (is (nil? (:pre_image w))                    "pre-image is not persisted (post-image-only log)")
        (is (= [(str t2) (str t3)] (:tokens post))   "post-image carries new token list")
        ;; The full span row state rides the post-image too.
        (is (some? (:value post)) "post-image carries the span row's :value column")))))

(deftest token-delete-span-trim-audit
  ;; A token delete that leaves a span with SOME tokens used to trim the
  ;; span via FK CASCADE only — no audit row — so the audit log was not
  ;; row-complete and as-of reconstruction would see the stale :tokens
  ;; vector. multi-delete! now emits a synthetic :update audit row on
  ;; :spans (trim-span-tokens!), same shape as span/set-tokens'.
  (let [proj (create-test-project admin-request "SpanTrimAuditProj")
        doc (create-test-document admin-request proj "SpanTrimAuditDoc")
        tl  (-> (create-text-layer admin-request proj "TTL") :body :id)
        tid (-> (create-text admin-request tl doc "abcdef") :body :id)
        tkl (-> (create-token-layer admin-request tl "TTKL") :body :id)
        t1  (-> (create-token admin-request tkl tid 0 2) :body :id)
        t2  (-> (create-token admin-request tkl tid 2 4) :body :id)
        sl  (-> (create-span-layer admin-request tkl "TSL") :body :id)
        sid (-> (create-span admin-request sl [t1 t2] "v") :body :id)
        rl  (-> (create-relation-layer admin-request sl "TRL") :body :id)
        sid2 (-> (create-span admin-request sl [t2] "w") :body :id)
        rid (-> (create-relation admin-request rl sid sid2 "dep") :body :id)]
    (assert-no-content (delete-token admin-request t1))
    ;; OLTP: span survives with only t2; the relation on it survives too
    ;; (only ORPHANED spans drag their relations down).
    (let [r (get-span admin-request sid)]
      (assert-ok r)
      (is (= [t2] (-> r :body :span/tokens))))
    (assert-ok (get-relation admin-request rid))
    ;; Audit: exactly one synthetic :update row on :spans under the
    ;; token/delete op, carrying the trimmed token vector.
    (let [writes (psc/q db {:select [:aw.*]
                            :from [[:audit_writes :aw]]
                            :join [[:operations :o] [:= :o.id :aw.op_id]]
                            :where [:and
                                    [:= :o.op_type "token/delete"]
                                    [:= :aw.target_table "spans"]
                                    [:= :aw.target_id (str sid)]]})]
      (is (= 1 (count writes)) "exactly one span audit row for the trim")
      (let [w (first writes)
            post (psc/read-json (:post_image w))]
        (is (= "update" (:change_type w))     "change_type = update")
        (is (nil? (:pre_image w))             "pre-image is not persisted (post-image-only log)")
        (is (= [(str t2)] (:tokens post))     "post-image carries trimmed token list")
        (is (some? (:value post)) "post-image carries the span row's :value column")))))
