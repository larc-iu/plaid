(ns plaid.sql.cascade-audit-test
  "Regression coverage for the last two audit-completeness gaps in the
  SQL port:

  - #31 — `bump-document-version!` no longer emits a phantom `:update`
    audit row that ETL would misread as a `:document/update` content
    edit. It now uses a sentinel `change_type` of `:doc-version-bump`
    (the schema CHECK constraint accepts it).

  - #33 — `user/deactivate` (formerly hard delete) previously relied on FK ON DELETE CASCADE to
    sweep project_users + vocab_maintainers rows, leaving the audit
    log with no record of the membership/maintainership loss. The
    delete now walks both junction tables and emits synthetic
    `:projects` / `:vocab_layers` audit rows in the parent-row-carries-
    junction shape established by tasks #28 / #34."
  (:require [clojure.test :refer :all]
            [plaid.sql.common :as psc]
            [plaid.sql.user :as user]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

;; ============================================================
;; #31 — version-bump sentinel
;; ============================================================

(deftest version-bump-uses-sentinel-change-type
  (testing "an op touching a document emits exactly ONE :doc-version-bump
            audit row alongside the body's :insert/:update rows, never a
            plain :update row against the documents table"
    (let [proj (create-test-project admin-request "VersionBumpSentinelProj")
          doc  (create-test-document admin-request proj "VersionBumpSentinelDoc")
          tl   (-> (create-text-layer admin-request proj "VBSTL") :body :id)
          tkl  (-> (create-token-layer admin-request tl "VBSTKL") :body :id)
          text (-> (create-text admin-request tl doc "abcdefghi") :body :id)
          ;; Token creation is a doc-touching op (carries :document doc) but
          ;; the body does NOT manage documents.version — so it's a clean
          ;; example of an op that triggers bump-document-version!.
          _    (-> (create-token admin-request tkl text 0 3) :body :id)
          ;; Find the most recent token/create op against this doc.
          op   (psc/q1 db {:select [:*] :from [:operations]
                           :where [:and
                                   [:= :op_type "token/create"]
                                   [:= :document_id doc]]
                           :order-by [[:ts :desc]] :limit 1})
          _    (is (some? op) "token/create op exists for this doc")
          ;; All audit_writes for that op against the :documents table.
          doc-writes (psc/q db {:select [:*] :from [:audit_writes]
                                :where [:and
                                        [:= :op_id (:id op)]
                                        [:= :target_table "documents"]
                                        [:= :target_id (str doc)]]
                                :order-by [:seq]})
          change-types (mapv :change_type doc-writes)]
      (is (= 1 (count doc-writes))
          (str "expected exactly 1 documents audit row for the op, got " (count doc-writes)
               " (change_types: " change-types ")"))
      (is (= ["doc-version-bump"] change-types)
          "the sole documents audit row carries the sentinel change_type, not 'update'")
      ;; The audit row still carries pre/post images so ETL replay can
      ;; reproduce the version + modified_at transition.
      (let [w (first doc-writes)
            pre  (psc/read-json (:pre_image w))
            post (psc/read-json (:post_image w))]
        (is (some? pre)  "pre-image present")
        (is (some? post) "post-image present")
        (is (= (inc (:version pre)) (:version post))
            "post-image version = pre-image version + 1")
        (is (not= (:modified_at pre) (:modified_at post))
            "modified_at advanced")))))

;; ============================================================
;; #33 — user/deactivate walks project_users + vocab_maintainers
;; ============================================================

(defn- create-extra-user!
  "Create a user via plaid.sql.user/create (bypassing the REST layer so
  we don't need a token for them). The user `eid` doubles as username,
  matching the v2 contract."
  [eid]
  (let [r (user/create db eid false "irrelevant-password")]
    (is (:success r) (str "ensure-user create returned " r))
    eid))

(deftest user-deactivate-audits-project-and-vocab-cascade
  (testing "deactivating a user emits synthetic :projects + :vocab_layers
            audit rows for every membership / maintainership FK-cascade
            that would otherwise have been swept silently"
    (let [victim (create-extra-user! "cascade-victim@example.com")
          ;; Project the user will be a reader on.
          proj (create-test-project admin-request "CascadeReaderProj")
          _    (add-project-reader admin-request proj victim)
          ;; Vocab layer the user will maintain.
          vid  (-> (create-vocab-layer admin-request "CascadeMaintVocab") :body :id)
          _    (add-vocab-maintainer admin-request vid victim)
          ;; Sanity-check setup: user is on both junction tables.
          _    (is (= 1 (count (psc/q db {:select [:*] :from [:project_users]
                                          :where [:and
                                                  [:= :project_id proj]
                                                  [:= :user_id victim]]})))
                   "victim is on project_users for proj")
          _    (is (= 1 (count (psc/q db {:select [:*] :from [:vocab_maintainers]
                                          :where [:and
                                                  [:= :vocab_layer_id vid]
                                                  [:= :user_id victim]]})))
                   "victim is on vocab_maintainers for vid")
          ;; The actual deactivation (admin DELETE route).
          resp (api-call admin-request
                         {:method :delete :path (str "/api/v1/users/" victim)})
          _    (is (= 204 (:status resp)) "user deactivation succeeds (204)")
          ;; Find the user/deactivate op. The op-record's `:user` is nil
          ;; (no actor is attached to `plaid.sql.user/deactivate`), so we
          ;; key off the op_type + description (which carries the
          ;; victim's id) rather than user_id.
          op   (psc/q1 db {:select [:*] :from [:operations]
                           :where [:and
                                   [:= :op_type "user/deactivate"]
                                   [:= :description (str "Deactivate user " victim)]]
                           :order-by [[:ts :desc]] :limit 1})
          _    (is (some? op) "user/delete op recorded")
          writes (psc/q db {:select [:*] :from [:audit_writes]
                            :where [:= :op_id (:id op)]
                            :order-by [:seq]})]
      ;; Junction rows really were removed.
      (is (zero? (count (psc/q db {:select [:*] :from [:project_users]
                                   :where [:= :user_id victim]})))
          "project_users for victim is gone")
      (is (zero? (count (psc/q db {:select [:*] :from [:vocab_maintainers]
                                   :where [:= :user_id victim]})))
          "vocab_maintainers for victim is gone")
      ;; The synthetic :projects audit (parent row + ACL vectors).
      (let [proj-writes (filter #(and (= "projects" (:target_table %))
                                      (= (str proj) (str (:target_id %))))
                                writes)]
        (is (= 1 (count proj-writes))
            (str "expected 1 :projects audit row for the project the user was a reader on, got "
                 (count proj-writes)))
        (let [w (first proj-writes)
              pre  (psc/read-json (:pre_image w))
              post (psc/read-json (:post_image w))
              ;; `clojure.data.json/write-str` strips namespaces from
              ;; keyword keys (verified at the REPL: `:project/readers`
              ;; → `"readers"`), so the round-tripped keys are
              ;; unqualified.
              pre-readers  (set (:readers pre))
              post-readers (set (:readers post))]
          (is (= "update" (:change_type w))
              "synthetic ACL change is a :projects :update")
          (is (contains? pre-readers (str victim))
              (str "pre-image readers contains the victim id (was: " pre-readers ")"))
          (is (not (contains? post-readers (str victim)))
              (str "post-image readers no longer contains the victim id (was: " post-readers ")"))))
      ;; The synthetic :vocab_layers audit (vocab row + maintainers).
      (let [vocab-writes (filter #(and (= "vocab_layers" (:target_table %))
                                       (= (str vid) (str (:target_id %))))
                                 writes)]
        (is (= 1 (count vocab-writes))
            (str "expected 1 :vocab_layers audit row for the vocab the user maintained, got "
                 (count vocab-writes)))
        (let [w (first vocab-writes)
              pre  (psc/read-json (:pre_image w))
              post (psc/read-json (:post_image w))
              ;; Same namespace-stripping caveat as the :projects audit.
              pre-maints  (set (:maintainers pre))
              post-maints (set (:maintainers post))]
          (is (= "update" (:change_type w))
              "synthetic maintainers change is a :vocab_layers :update")
          (is (contains? pre-maints (str victim))
              (str "pre-image maintainers contains the victim id (was: " pre-maints ")"))
          (is (not (contains? post-maints (str victim)))
              (str "post-image maintainers no longer contains the victim id (was: "
                   post-maints ")"))))
      ;; The user row itself is audited as an :update whose post image
      ;; carries the deactivation timestamp (users are never hard-deleted).
      (let [user-writes (filter #(and (= "users" (:target_table %))
                                      (= "update" (:change_type %))
                                      (= (str victim) (str (:target_id %))))
                                writes)]
        (is (= 1 (count user-writes))
            "users row audited with change_type=update")
        (let [post (psc/read-json (:post_image (first user-writes)))]
          (is (string? (:deactivated_at post))
              "post-image carries deactivated_at"))))))
