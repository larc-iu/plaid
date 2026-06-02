(ns plaid.sql.api-token-test
  "SQL-layer tests for named per-user API tokens: create/read/list/active?/
  revoke, plus the audited-op side effects."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fixtures :refer [with-db with-mount-states with-clean-db db]]
            [plaid.sql.api-token :as api-token]
            [plaid.sql.common :as psc]
            [plaid.sql.user :as user]))

(use-fixtures :once with-db with-mount-states)
(use-fixtures :each with-clean-db)

(defn- mk-user! [id]
  (user/create db id false "pw")
  id)

(deftest create-and-read
  (let [uid (mk-user! "tok-user@example.com")
        {:keys [success extra]} (api-token/create! db uid "CI bot" uid)]
    (is success)
    ;; `extra` is the token id — a java.util.UUID at the SQL layer (stored as
    ;; TEXT, rendered as a string only on the JSON wire).
    (is (uuid? extra))
    (testing "get returns external shape and never the signed token"
      (let [t (api-token/get db extra)]
        (is (= "CI bot" (:api-token/name t)))
        (is (= uid (:api-token/user-id t)))
        (is (nil? (:api-token/revoked-at t)))
        (is (not (contains? t :token)))
        (is (not (contains? t :api-token/token)))))
    (testing "list-for-user returns the token"
      (is (= [extra] (mapv :api-token/id (api-token/list-for-user db uid)))))
    (testing "active? is true before revoke"
      (is (api-token/active? db extra)))))

(deftest revoke-soft-and-idempotent
  (let [uid (mk-user! "tok-user2@example.com")
        {id :extra} (api-token/create! db uid "tok" uid)]
    (is (api-token/active? db id))
    (is (:success (api-token/revoke! db id uid)))
    (testing "no longer active but row preserved with revoked-at"
      (is (not (api-token/active? db id)))
      (is (some? (:api-token/revoked-at (api-token/get db id)))))
    (testing "re-revoke is idempotent success"
      (is (:success (api-token/revoke! db id uid))))
    (testing "revoked token still listed (shown, not hidden)"
      (is (= [id] (mapv :api-token/id (api-token/list-for-user db uid)))))))

(deftest revoke-unknown-404
  (let [uid (mk-user! "tok-user3@example.com")
        {:keys [success code]} (api-token/revoke! db "no-such-token" uid)]
    (is (not success))
    (is (= 404 code))))

(deftest create-blank-name-400
  (let [uid (mk-user! "tok-user4@example.com")
        {:keys [success code]} (api-token/create! db uid "" uid)]
    (is (not success))
    (is (= 400 code))))

(deftest create-revoke-emit-operations
  (let [uid (mk-user! "tok-user5@example.com")
        {id :extra} (api-token/create! db uid "tok" uid)
        _ (api-token/revoke! db id uid)
        op-types (->> (psc/q db {:select [:op_type]
                                 :from [:operations]
                                 :where [:in :op_type ["api-token/create" "api-token/revoke"]]})
                      (map :op_type)
                      set)]
    (is (= #{"api-token/create" "api-token/revoke"} op-types))))
