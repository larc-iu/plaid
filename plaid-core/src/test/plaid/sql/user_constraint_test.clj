(ns plaid.sql.user-constraint-test
  "Regression coverage for task #57: `unique-constraint-violation?` in
  plaid.sql.user used to catch ANY SQLite constraint failure and
  re-project it to 409 'User already exists'. That was wrong for a CHECK
  violation on `is_admin IN (0,1)`, which carries the same
  SQLSTATE/`SQLITE_CONSTRAINT` text but is a server bug, not a taken
  account.

  Only a uniqueness failure on the account's identity is translated to 409.
  Two columns can report that one — the PK on `users.id` and the UNIQUE on
  `users.username`, which every row writes equal to the id — and either
  means the same thing. Anything else propagates as a SQLException and
  reaches submit-operation*'s generic catch, which surfaces a 500 carrying
  the original message."
  (:require [clojure.test :refer :all]
            [plaid.sql.common :as psc]
            [plaid.sql.user :as user]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin with-clean-db]]
            [plaid.test-helpers :refer :all])
  (:import [java.sql SQLException]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(deftest duplicate-account-projects-to-409
  (testing "creating a user whose email/id already exists surfaces as
            {:success false :code 409}"
    (let [uid "dup-account-test@example.com"
          r1 (user/create db uid false "irrelevant-password" nil)]
      (is (:success r1) (str "first create succeeded: " r1))
      (let [r2 (user/create db uid false "irrelevant-password" nil)]
        (is (false? (:success r2))
            (str "second create with the same email fails: " r2))
        (is (= 409 (:code r2))
            (str "the collision projects to 409, got: " r2))))))

(deftest other-constraint-violations-do-not-mask-as-409
  (testing "only an identity-uniqueness failure counts as 'account taken';
            any other SQLite constraint violation must reach the generic
            catch (a 500 carrying its original message) rather than being
            mislabelled 409"
    ;; Asserted against the predicate itself. It used to be exercised by
    ;; renaming a user so a fresh create would collide on the PK alone, but
    ;; there is no rename any more: a user's id is their email address and
    ;; nothing rewrites it, so `users.id` and `users.username` can no longer
    ;; disagree, and a PK-only collision is unreachable through the API.
    (let [taken? #'user/account-taken-violation?]
      (is (true? (taken? (SQLException. "[SQLITE_CONSTRAINT_UNIQUE] UNIQUE constraint failed: users.username"))))
      (is (true? (taken? (SQLException. "[SQLITE_CONSTRAINT_UNIQUE] UNIQUE constraint failed: users.id"))))
      (is (true? (taken? (RuntimeException. "wrapped"
                                            (SQLException. "UNIQUE constraint failed: users.id"))))
          "walks the cause chain, since next.jdbc may wrap the driver exception")
      (is (false? (taken? (SQLException. "[SQLITE_CONSTRAINT_CHECK] CHECK constraint failed: is_admin IN (0, 1)")))
          "a CHECK violation is a server bug, not a taken account")
      (is (false? (taken? (SQLException. "[SQLITE_CONSTRAINT_UNIQUE] UNIQUE constraint failed: api_tokens.id")))
          "another table's uniqueness is not this user's problem")
      (is (false? (taken? (RuntimeException. "not a SQLException at all")))))))

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
