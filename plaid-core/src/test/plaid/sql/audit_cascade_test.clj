(ns plaid.sql.audit-cascade-test
  "Smoke test for ETL-readiness of the audit log: verifies that deleting
  a project produces per-row audit_writes entries for every descendant
  entity (documents, layers, texts, tokens, spans, relations) instead
  of relying on FK ON DELETE CASCADE (which would silently delete those
  rows without creating audit entries).

  Junction tables (span_tokens, vocab_link_tokens, project_users,
  project_vocabs, vocab_maintainers) remain unaudited by policy — the
  parent entity's audit row captures the structural change at higher
  fidelity."
  (:require [clojure.test :refer :all]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin assert-created assert-ok
                                    assert-no-content with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(deftest project-delete-audits-full-subtree
  (let [proj (create-test-project admin-request "AuditCascadeProj")
        doc  (create-test-document admin-request proj "AuditCascadeDoc")
        txtl (-> (create-text-layer admin-request proj "ATL") :body :id)
        tokl (-> (create-token-layer admin-request txtl "ATKL") :body :id)
        sl   (-> (create-span-layer admin-request tokl "ASL") :body :id)
        rl   (-> (create-relation-layer admin-request sl "ARL") :body :id)
        text (-> (create-text admin-request txtl doc "abcdefghi") :body :id)
        t1   (-> (create-token admin-request tokl text 0 3) :body :id)
        t2   (-> (create-token admin-request tokl text 3 6) :body :id)
        t3   (-> (create-token admin-request tokl text 6 9) :body :id)
        s1   (-> (create-span admin-request sl [t1] "val1") :body :id)
        s2   (-> (create-span admin-request sl [t2] "val2") :body :id)
        rel  (-> (create-relation admin-request rl s1 s2 "rval") :body :id)]
    ;; Delete the project — should cascade-audit the entire subtree.
    (assert-no-content (delete-test-project admin-request proj))
    ;; Find the project/delete op.
    (let [op (psc/q1 db {:select [:*] :from [:operations]
                         :where [:and
                                 [:= :op_type "project/delete"]
                                 [:= :project_id proj]]
                         :order-by [[:ts :desc]] :limit 1})
          _ (is (some? op) "project/delete operation was recorded")
          writes (psc/q db {:select [:*] :from [:audit_writes]
                            :where [:= :op_id (:id op)]})
          deletes (filter #(= "delete" (:change_type %)) writes)
          deleted-by-table (->> deletes
                                (group-by :target_table)
                                (into {} (map (fn [[k v]] [k (count v)]))))]
      (println :--cascade-op-id (:id op))
      (println :--cascade-write-count (count writes))
      (println :--cascade-delete-count (count deletes))
      (println :--cascade-deleted-by-table deleted-by-table)
      ;; Per-table assertions: each layer + entity type contributes at
      ;; least one audited delete row.
      (is (= 1 (clojure.core/get deleted-by-table "projects" 0))
          "project itself audited")
      (is (= 1 (clojure.core/get deleted-by-table "documents" 0))
          "document audited")
      (is (= 1 (clojure.core/get deleted-by-table "text_layers" 0))
          "text_layer audited")
      (is (= 1 (clojure.core/get deleted-by-table "token_layers" 0))
          "token_layer audited")
      (is (= 1 (clojure.core/get deleted-by-table "span_layers" 0))
          "span_layer audited")
      (is (= 1 (clojure.core/get deleted-by-table "relation_layers" 0))
          "relation_layer audited")
      (is (= 1 (clojure.core/get deleted-by-table "texts" 0))
          "text audited")
      (is (= 3 (clojure.core/get deleted-by-table "tokens" 0))
          "all 3 tokens audited")
      (is (= 2 (clojure.core/get deleted-by-table "spans" 0))
          "both spans audited")
      (is (= 1 (clojure.core/get deleted-by-table "relations" 0))
          "relation audited")
      ;; Aggregate count: 1 project + 1 doc + 4 layers + 1 text + 3
      ;; tokens + 2 spans + 1 relation = 13 row-level deletes audited.
      ;; (NOT just 1 for the project, which is what FK CASCADE alone
      ;; would have produced.)
      (is (>= (count deletes) 13)
          "at least 13 row-level delete audits for the full subtree")
      ;; Every delete row must have a pre_image (ETL replay needs to
      ;; reconstruct the deleted row).
      (doseq [d deletes]
        (is (some? (:pre_image d))
            (str "delete audit for " (:target_table d) "/" (:target_id d)
                 " carries a pre_image"))))))

;; ---------------------------------------------------------------------------
;; Task #102.6 — junction tables MUST NOT appear in audit_writes
;; ---------------------------------------------------------------------------
;; Policy: junction-table state changes (span_tokens, vocab_link_tokens,
;; project_users, vocab_maintainers, project_vocabs) are NEVER directly
;; audited — the parent entity's audit row (e.g. spans, vocab_links,
;; projects, vocabs) captures the structural change at higher fidelity.
;; ETL replays the junction state from the parent's pre/post images, not
;; from per-row junction rows.

(def ^:private junction-tables
  #{"span_tokens" "vocab_link_tokens" "project_users"
    "vocab_maintainers" "project_vocabs"})

(deftest project-delete-emits-no-junction-table-audits
  ;; Build out a subtree that ALSO populates every junction we care about,
  ;; then cascade-delete the project and assert NO audit_writes row
  ;; references a junction table directly.
  (let [proj (create-test-project admin-request "JunctionAuditProj")
        doc  (create-test-document admin-request proj "JuncAuditDoc")
        txtl (-> (create-text-layer admin-request proj "TL") :body :id)
        tokl (-> (create-token-layer admin-request txtl "TKL") :body :id)
        sl   (-> (create-span-layer admin-request tokl "SL") :body :id)
        _rl  (-> (create-relation-layer admin-request sl "RL") :body :id)
        text (-> (create-text admin-request txtl doc "abcdefghij") :body :id)
        t1   (-> (create-token admin-request tokl text 0 3) :body :id)
        t2   (-> (create-token admin-request tokl text 3 6) :body :id)
        ;; span_tokens junction — span referencing two tokens.
        _    (-> (create-span admin-request sl [t1 t2] "two-token-span") :body :id)
        ;; project_users junction is already populated at project creation
        ;; (the creator becomes a maintainer automatically) — no need to
        ;; add another user here.
        ;;
        ;; vocab + project_vocabs + vocab_maintainers + vocab_link_tokens
        ;; junctions — link a vocab to the project, item, and use it on t1.
        vid  (-> (create-vocab-layer admin-request "JunctionAuditVocab") :body :id)
        _    (assert-no-content (link-vocab-to-project admin-request proj vid))
        item (-> (create-vocab-item admin-request vid "form") :body :id)
        _    (-> (create-vocab-link admin-request item [t1]) :body :id)]
    ;; Cascade-delete the project (also cleans up the vocab linkage via
    ;; project_vocabs cascade). We don't delete the vocab itself here —
    ;; the assertion focuses on the project subtree's junctions.
    (assert-no-content (delete-test-project admin-request proj))
    (let [op (psc/q1 db {:select [:*] :from [:operations]
                         :where [:and
                                 [:= :op_type "project/delete"]
                                 [:= :project_id proj]]
                         :order-by [[:ts :desc]] :limit 1})
          writes (psc/q db {:select [:*] :from [:audit_writes]
                            :where [:= :op_id (:id op)]})
          junction-rows (filter #(contains? junction-tables (:target_table %)) writes)]
      (is (some? op) "project/delete op recorded")
      (is (seq writes) "cascade produced audit rows")
      (is (empty? junction-rows)
          (str "Junction tables MUST NOT appear in audit_writes directly. "
               "Offending rows by table: "
               (frequencies (map :target_table junction-rows))))
      ;; Sanity: the parent entities ARE audited (the structural changes
      ;; are recorded via spans/vocab_links/projects rows, not via the
      ;; junctions themselves).
      (let [tables (set (map :target_table writes))]
        (is (contains? tables "spans") "spans (parent of span_tokens) audited")
        (is (contains? tables "projects") "projects (parent of project_users) audited")))))
