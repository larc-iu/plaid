(ns plaid.sql.user-constraint-test
  "Regression coverage for task #57: `unique-constraint-violation?` in
  plaid.sql.user used to catch ANY SQLite constraint failure and
  re-project it to 409 'User already exists'. That was wrong for PK
  collisions on `users.id` and CHECK violations on `is_admin IN (0,1)`,
  both of which carry the same SQLSTATE/`SQLITE_CONSTRAINT` text.

  After the fix, ONLY `UNIQUE constraint failed: users.username` is
  translated to 409; any other constraint violation propagates as a
  SQLException and reaches submit-operation*'s generic catch, which
  surfaces a 500."
  (:require [clojure.test :refer :all]
            [plaid.sql.common :as psc]
            [plaid.sql.user :as user]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(deftest duplicate-username-projects-to-409
  (testing "creating a user with an id (== username) that already exists
            surfaces as {:success false :code 409}"
    (let [uid "dup-username-test@example.com"
          r1 (user/create db uid false "irrelevant-password")]
      (is (:success r1) (str "first create succeeded: " r1))
      (let [r2 (user/create db uid false "irrelevant-password")]
        (is (false? (:success r2))
            (str "second create with same username fails: " r2))
        (is (= 409 (:code r2))
            (str "username collision projects to 409, got: " r2))))))

(deftest non-username-constraint-violation-does-not-mask-as-409
  (testing "a non-username constraint violation must NOT be silently
            re-projected to 409 'user taken' — it should surface as a
            real error (5xx) carrying the original SQLException
            message, so diagnostics aren't misleading."
    ;; We force a PK collision by calling the private insert-user-row!
    ;; directly with a duplicate id but a NEW username — that bypasses
    ;; the username-unique path (id differs in `:username`? no: id IS
    ;; username here). To exercise a PURE PK-only collision we INSERT
    ;; first via the public API, then call the underlying SQL path
    ;; with a distinct username but the same id; this trips PK on
    ;; `users.id` while leaving `users.username` unique. Since
    ;; `insert-user-row!` ties id == username, we instead inject a
    ;; different username via direct SQL to set the stage, then INSERT
    ;; via public `create` to collide on PK.
    (let [uid "pk-collision-victim@example.com"
          r1 (user/create db uid false "irrelevant-password")]
      (is (:success r1) (str "first create succeeded: " r1))
      ;; Rename the row so a fresh create reuses the id but the
      ;; username slot is free. This isolates the PK-on-id collision
      ;; from the UNIQUE-on-username one.
      (let [rename-res (user/merge db uid {:user/username "pk-collision-renamed@example.com"})]
        (is (:success rename-res) (str "rename succeeded: " rename-res)))
      ;; Now create with the original id again. id is still taken
      ;; (PK collision on users.id), but the username slot is free, so
      ;; the FAILURE mode is exclusively the PK violation — the path
      ;; we want to assert does NOT mask as 409.
      (let [r2 (user/create db uid false "irrelevant-password")]
        (is (false? (:success r2))
            (str "second create with same id (PK collision) fails: " r2))
        (is (not= 409 (:code r2))
            (str "PK collision must NOT be projected to 409 'user taken';"
                 " expected non-409 (typically 500) but got " r2))))))

;; ============================================================
;; Task #59 — create+metadata emits ONE :insert (no noisy :update)
;; ============================================================

(deftest create-span-with-metadata-emits-single-insert
  (testing "creating a span WITH metadata produces exactly ONE :spans
            audit row (change_type :insert) carrying both :tokens AND
            :metadata folded into the post_image — NOT a noisy
            :insert + :update pair"
    (let [proj (create-test-project admin-request "FoldMetaProj")
          doc  (create-test-document admin-request proj "FoldMetaDoc")
          tl   (-> (create-text-layer admin-request proj "FMTL") :body :id)
          tkl  (-> (create-token-layer admin-request tl "FMTKL") :body :id)
          sl   (-> (create-span-layer admin-request tkl "FMSL") :body :id)
          text (-> (create-text admin-request tl doc "abcdefghi") :body :id)
          tok  (-> (create-token admin-request tkl text 0 3) :body :id)
          metadata {"k1" "v1" "k2" "v2"}
          span-resp (create-span admin-request sl [tok] "val" metadata)
          span-id (-> span-resp :body :id)
          _ (is (= 201 (:status span-resp))
                (str "span create succeeds: " span-resp))
          ;; Find the span/create op.
          op (psc/q1 db {:select [:*] :from [:operations]
                         :where [:and
                                 [:= :op_type "span/create"]
                                 [:= :document_id doc]]
                         :order-by [[:ts :desc]] :limit 1})
          _ (is (some? op) "span/create op exists")
          ;; All audit_writes for that op against the :spans table.
          span-writes (psc/q db {:select [:*] :from [:audit_writes]
                                 :where [:and
                                         [:= :op_id (:id op)]
                                         [:= :target_table "spans"]
                                         [:= :target_id (str span-id)]]
                                 :order-by [:seq]})
          change-types (mapv :change_type span-writes)]
      (is (= 1 (count span-writes))
          (str "expected exactly 1 :spans audit row, got "
               (count span-writes) " (change_types: " change-types ")"))
      (is (= ["insert"] change-types)
          "the sole :spans audit row is :insert, NOT an :insert+:update pair")
      ;; post_image carries both :tokens and :metadata.
      (let [post (psc/read-json (:post_image (first span-writes)))]
        (is (vector? (:tokens post))
            (str "post_image folds in :tokens (was: " post ")"))
        (is (= 1 (count (:tokens post)))
            (str "post_image :tokens has the one inserted token (was: " (:tokens post) ")"))
        (is (map? (:metadata post))
            (str "post_image folds in :metadata (was: " post ")"))
        ;; psc/read-json keywordizes keys, so {"k1" "v1"} round-trips
        ;; as {:k1 "v1"}. Compare with the expected keywordized shape.
        (is (= {:k1 "v1" :k2 "v2"} (:metadata post))
            (str "post_image :metadata matches the inserted map (was: " (:metadata post) ")"))))))
