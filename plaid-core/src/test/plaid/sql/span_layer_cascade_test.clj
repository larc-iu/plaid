(ns plaid.sql.span-layer-cascade-test
  "Regression test for Task #35: span_layer/cascade-delete! ordering bug.

  The previous ordering audit-deleted (1) relations under nested
  relation_layers, then (2) the relation_layers themselves, then (3)
  spans and their referencing relations. Step 2's
  `DELETE FROM relation_layers WHERE id = ?` fires FK ON DELETE CASCADE
  on `relations.relation_layer_id`, silently sweeping any relation in a
  to-be-deleted relation_layer that step 1 had missed and that step 3
  would have audited — leaving the audit log incomplete.

  The fix collects ALL affected relations (those in nested
  relation_layers AND those elsewhere whose source/target span is in
  the span_layer) in one query, audit-deletes them BEFORE any
  relation_layer or span row goes away, and only then continues with
  relation_layers, spans, and the span_layer row itself.

  This test exercises the cross-layer case by inserting a relation
  whose source is in the deleted span_layer but whose relation_layer
  lives under a SIBLING span_layer — a configuration that bypasses the
  application-level invariants checked by `plaid.sql.relation/create`
  but is allowed by the SQL schema. The audit log must capture that
  relation's deletion (as a :delete row under this op)."
  (:require [clojure.test :refer :all]
            [next.jdbc :as jdbc]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin
                                    assert-ok assert-created assert-no-content
                                    api-call with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- delete-span-layer [user-request-fn span-layer-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/span-layers/" span-layer-id)}))

(deftest span-layer-cascade-audits-cross-layer-relations
  (let [proj   (create-test-project admin-request "SLCascadeProj")
        doc    (create-test-document admin-request proj "SLCascadeDoc")
        txtl   (-> (create-text-layer admin-request proj "SLCTL") :body :id)
        tokl   (-> (create-token-layer admin-request txtl "SLCTKL") :body :id)
        text   (-> (create-text admin-request txtl doc "abcdefghi") :body :id)
        ;; Two sibling span_layers under the same token_layer.
        sl-x   (-> (create-span-layer admin-request tokl "SL_X") :body :id)
        sl-y   (-> (create-span-layer admin-request tokl "SL_Y") :body :id)
        ;; Each span_layer has its own relation_layer.
        rl-x   (-> (create-relation-layer admin-request sl-x "RL_X") :body :id)
        rl-y   (-> (create-relation-layer admin-request sl-y "RL_Y") :body :id)
        t1     (-> (create-token admin-request tokl text 0 3) :body :id)
        t2     (-> (create-token admin-request tokl text 3 6) :body :id)
        t3     (-> (create-token admin-request tokl text 6 9) :body :id)
        ;; Two spans in SL_X (will get caught by step 4 below) plus
        ;; one in SL_Y (the cross-layer relation's target).
        sx1    (-> (create-span admin-request sl-x [t1] "x1") :body :id)
        sx2    (-> (create-span admin-request sl-x [t2] "x2") :body :id)
        sy1    (-> (create-span admin-request sl-y [t3] "y1") :body :id)
        ;; (a) Relation inside RL_X (nested under SL_X). Goes through the
        ;; API so its invariants (same-layer source/target) hold.
        rel-in-rlx (-> (create-relation admin-request rl-x sx1 sx2 "rval-in-x")
                       :body :id)
        ;; (b) Cross-layer relation: lives in RL_Y but references SX2
        ;; (a span in SL_X being deleted). The API's
        ;; check-relation-invariants! refuses this, so we insert raw
        ;; (bypassing audit). The schema permits it because relation
        ;; rows have no constraint matching span_layer↔relation_layer.
        cross-rel-id (psc/new-uuid)
        _ (jdbc/execute!
           db
           (psc/format-sql
            {:insert-into :relations
             :values [{:id cross-rel-id
                       :relation_layer_id rl-y
                       :document_id doc
                       ;; source/target in two different span_layers —
                       ;; only reachable via raw SQL like this.
                       :source_span_id sy1
                       :target_span_id sx2
                       :value (psc/write-json "rval-cross")}]}))]
    ;; Sanity: the cross-layer relation exists pre-delete.
    (is (some? (psc/q1 db {:select [:*] :from [:relations]
                           :where [:= :id cross-rel-id]}))
        "raw-inserted cross-layer relation is present before the cascade")
    ;; Trigger the cascade.
    (assert-no-content (delete-span-layer admin-request sl-x))
    ;; The relation row really is gone from the live table (the
    ;; question is whether it was audited along the way).
    (is (nil? (psc/q1 db {:select [:*] :from [:relations]
                          :where [:= :id cross-rel-id]}))
        "cross-layer relation is gone after the cascade")
    ;; Locate the span_layer/delete operation.
    (let [op (psc/q1 db {:select [:*] :from [:operations]
                         :where [:and
                                 [:= :op_type "span-layer/delete"]
                                 [:= :project_id proj]]
                         :order-by [[:ts :desc]] :limit 1})
          _  (is (some? op) "span-layer/delete operation was recorded")
          writes (psc/q db {:select [:*] :from [:audit_writes]
                            :where [:= :op_id (:id op)]})
          deletes (filter #(= "delete" (:change_type %)) writes)
          delete-ids (->> deletes
                          (map :target_id)
                          (map str)
                          set)]
      (println :--sl-cascade-write-count (count writes))
      (println :--sl-cascade-delete-count (count deletes))
      (println :--sl-cascade-deleted-by-table
               (->> deletes
                    (group-by :target_table)
                    (into {} (map (fn [[k v]] [k (count v)])))))
      ;; Both relations should have audit-deleted rows under this op.
      (is (contains? delete-ids (str rel-in-rlx))
          "nested-RL relation (rel-in-rlx) was audit-deleted")
      (is (contains? delete-ids (str cross-rel-id))
          "cross-layer relation in sibling RL_Y was audit-deleted (not FK-swept)")
      ;; Spans in SL_X audited.
      (is (contains? delete-ids (str sx1)) "span sx1 audited")
      (is (contains? delete-ids (str sx2)) "span sx2 audited")
      ;; RL_X audited (RL_Y survives — it's under SL_Y).
      (is (contains? delete-ids (str rl-x)) "RL_X audit-deleted")
      (is (not (contains? delete-ids (str rl-y)))
          "RL_Y is under sibling SL_Y; must not be touched")
      ;; SL_X itself audited.
      (is (contains? delete-ids (str sl-x)) "SL_X audit-deleted")
      ;; Post-image-only log: a :delete row carries NO image at all (post is
      ;; nil for deletes; pre_image is no longer persisted). The point of
      ;; this test — that every cascaded deletion IS audited — is covered by
      ;; the delete-ids checks above; the as-of fold treats a :delete as
      ;; "entity absent" and needs no image.
      (doseq [d deletes]
        (is (nil? (:pre_image d))
            (str "delete audit for " (:target_table d) "/"
                 (:target_id d) " has no pre_image (post-image-only log)"))
        (is (nil? (:post_image d))
            (str "delete audit for " (:target_table d) "/"
                 (:target_id d) " has no post_image"))))))
