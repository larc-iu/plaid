(ns plaid.sql.audit-cascade-test
  "Regression coverage for the project-delete policy: deleting a project is
  a TRUE delete. The descendant subtree is swept by FK ON DELETE CASCADE in
  the DB engine and is intentionally NOT audited row-by-row — a deleted
  project is neither recoverable nor time-travelable (see
  `plaid.history.read/project-live?`), so per-descendant delete history
  would be write-only. The op emits exactly ONE audit row: the `projects`
  `:delete`.

  This REVERSES the earlier 'audit every descendant on project delete'
  policy. That policy made a ~200-document project delete ~188k audited
  row-deletes — enough to blow past the client's HTTP timeout.

  `entity_metadata` is the one descendant table with no FK to its owning
  entity (it's a polymorphic key-value table), so FK CASCADE can't reach
  it; `plaid.sql.project/delete` sweeps it explicitly. We verify it leaves
  no orphans.

  Junction tables (span_tokens, vocab_link_tokens, project_users,
  project_vocabs, vocab_maintainers) are never directly audited under any
  policy — here they simply ride FK CASCADE."
  (:require [clojure.test :refer :all]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin assert-created assert-ok
                                    assert-no-content with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(deftest project-delete-emits-one-audit-row-and-fk-cascades-the-subtree
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
        rel  (-> (create-relation admin-request rl s1 s2 "rval") :body :id)
        ;; Metadata on a sampling of entity kinds. These rows live in
        ;; entity_metadata, which FK CASCADE cannot reach, so the delete
        ;; path must sweep them explicitly (else they'd orphan).
        _    (assert-ok (update-document-metadata admin-request doc {"k" "dv"}))
        _    (assert-ok (update-token-metadata admin-request t1 {"k" "tv"}))
        _    (assert-ok (update-span-metadata admin-request s1 {"k" "sv"}))]
    (assert-no-content (delete-test-project admin-request proj))
    (let [op (psc/q1 db {:select [:*] :from [:operations]
                         :where [:and
                                 [:= :op_type "project/delete"]
                                 [:= :project_id proj]]
                         :order-by [[:ts :desc]] :limit 1})
          _ (is (some? op) "project/delete operation was recorded")
          writes (psc/q db {:select [:*] :from [:audit_writes]
                            :where [:= :op_id (:id op)]})
          deletes (filter #(= "delete" (:change_type %)) writes)]
      ;; EXACTLY ONE audit row — the project itself. No per-row descendant
      ;; audits: FK CASCADE swept them silently, by design.
      (is (= 1 (count writes))
          (str "expected exactly 1 audit row (the project delete), got "
               (count writes) " by table: " (frequencies (map :target_table writes))))
      (is (= 1 (count deletes)) "the sole audit row is a delete")
      (is (= "projects" (:target_table (first deletes)))
          "the audited delete targets the project")
      (is (= proj (:target_id (first deletes))))
      ;; Post-image-only log: a :delete row carries no image at all.
      (is (nil? (:pre_image (first deletes))) "pre-image is not persisted")
      (is (nil? (:post_image (first deletes))) "delete rows have no post-image")
      ;; FK ON DELETE CASCADE actually removed the whole subtree from OLTP.
      (doseq [[table where] [[:documents       [:= :project_id proj]]
                             [:text_layers     [:= :project_id proj]]
                             [:token_layers    [:= :project_id proj]]
                             [:span_layers     [:= :project_id proj]]
                             [:relation_layers [:= :project_id proj]]
                             [:texts           [:= :id text]]
                             [:tokens          [:in :id [t1 t2 t3]]]
                             [:spans           [:in :id [s1 s2]]]
                             [:relations       [:= :id rel]]]]
        (is (empty? (psc/q db {:select [:id] :from [table] :where where}))
            (str table " rows were FK-cascaded away")))
      ;; entity_metadata had no FK to ride, so the delete path swept it.
      (is (empty? (psc/q db {:select [:*] :from [:entity_metadata]
                             :where [:in :entity_id [doc t1 s1]]}))
          "entity_metadata for the project's entities was swept (no orphans)"))))

;; ---------------------------------------------------------------------------
;; Junction tables MUST NOT appear in audit_writes
;; ---------------------------------------------------------------------------
;; Policy: junction-table state changes (span_tokens, vocab_link_tokens,
;; project_users, vocab_maintainers, project_vocabs) are NEVER directly
;; audited. Under the true-delete policy this is trivially upheld — the only
;; audited row on a project delete is the project itself.

(def ^:private junction-tables
  #{"span_tokens" "vocab_link_tokens" "project_users"
    "vocab_maintainers" "project_vocabs"})

(deftest project-delete-emits-no-junction-table-audits
  ;; Build a subtree that ALSO populates every junction we care about, then
  ;; delete the project and assert NO audit_writes row references a junction
  ;; table — nor any descendant entity table (FK CASCADE sweeps them all
  ;; unaudited; only the project row is audited).
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
        ;; project_users is already populated (creator is maintainer).
        ;; vocab + project_vocabs + vocab_maintainers + vocab_link_tokens.
        vid  (-> (create-vocab-layer admin-request "JunctionAuditVocab") :body :id)
        _    (assert-no-content (link-vocab-to-project admin-request proj vid))
        item (-> (create-vocab-item admin-request vid "form") :body :id)
        _    (-> (create-vocab-link admin-request item [t1]) :body :id)]
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
      (is (seq writes) "the delete produced an audit row")
      (is (empty? junction-rows)
          (str "Junction tables MUST NOT appear in audit_writes directly. "
               "Offending rows by table: "
               (frequencies (map :target_table junction-rows))))
      ;; Under the true-delete policy the ONLY audited row is the project
      ;; itself; descendants (incl. junction parents like spans/vocab_links)
      ;; ride FK CASCADE unaudited.
      (let [tables (set (map :target_table writes))]
        (is (= #{"projects"} tables)
            (str "only the project row is audited on a project delete; got " tables))))))
