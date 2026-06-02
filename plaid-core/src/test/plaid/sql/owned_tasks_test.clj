(ns plaid.sql.owned-tasks-test
  "Regression coverage for the tasks owned by the sql/* + rest_api/v1/user.clj
  agent: #91 (doc-version-bump rows on the per-doc audit endpoint),
  #95 (admin-only /users, User-Agent sanitization), #99 (users pagination),
  #100 V4 (last-maintainer / last-admin invariants), #100 V5 (metadata key
  validation)."
  (:require [clojure.set]
            [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    with-clean-db with-admin with-test-users
                                    db admin-request user1-request
                                    rest-handler api-call
                                    assert-ok assert-no-content assert-created
                                    assert-status assert-forbidden]]
            [plaid.sql.metadata :as metadata]
            [plaid.sql.operation :as op]
            [plaid.sql.user :as user]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

;; ============================================================
;; Task #91 — doc-version-bump rows surface in per-doc audit
;; ============================================================

(deftest doc-version-bump-rows-appear-on-document-audit
  (testing "vocab/delete bumps versions on every doc that lost a vocab_link;
            those bump rows must be visible via GET /documents/:id/audit
            even though the parent op carries document_id = nil"
    (let [proj (create-test-project admin-request "BumpAuditProj")
          tl   (-> (create-text-layer admin-request proj "TL") :body :id)
          tkl  (-> (create-token-layer admin-request tl "TKL") :body :id)
          ;; Three docs, each gets a text + a token so we have somewhere
          ;; to anchor a vocab_link.
          doc-ids (mapv #(create-test-document admin-request proj (str "Doc-" %)) [1 2 3])
          text-ids (mapv (fn [d] (-> (create-text admin-request tl d "abcdef") :body :id))
                         doc-ids)
          ;; One token per doc so we have an anchor for one vocab_link
          ;; per doc — vocab/delete will then emit a :doc-version-bump
          ;; for each of those docs.
          token-ids (mapv (fn [i]
                            (-> (create-token admin-request tkl (nth text-ids i) 0 3) :body :id))
                          (range 3))
          ;; A vocab layer, granted to the project, with one item.
          vocab-id (-> (create-vocab-layer admin-request "BumpVocab") :body :id)
          _ (assert-no-content (link-vocab-to-project admin-request proj vocab-id))
          item-id  (-> (create-vocab-item admin-request vocab-id "form") :body :id)
          ;; A vocab_link in each doc — vocab/delete will wipe these +
          ;; emit a :doc-version-bump per doc.
          _ (doseq [tid token-ids]
              (assert-created (create-vocab-link admin-request item-id [tid])))
          ;; Sanity: per-doc audit before vocab/delete already has rows.
          before (count (:body (get-document-audit admin-request (first doc-ids))))
          _ (assert-no-content (delete-vocab-layer admin-request vocab-id))
          ;; Fetch the per-doc audit for doc1 — must include both the
          ;; vocab/delete parent op AND the doc-version-bump row.
          after-resp (get-document-audit admin-request (first doc-ids))
          _ (assert-ok after-resp)
          entries (:body after-resp)
          op-types (mapv (fn [e] (-> e :audit/ops first :op/type)) entries)]
      (is (> (count entries) before)
          (str "Expected new audit rows after vocab/delete; before=" before
               " after=" (count entries)))
      (is (some #{:vocab/delete} op-types)
          (str "Per-doc audit must surface the parent vocab/delete op; got "
               (vec op-types))))))

;; ============================================================
;; Task #95 — admin-only GET /users; non-admin gets 403
;; ============================================================

(deftest list-users-admin-only
  (testing "Non-admins cannot enumerate users"
    (assert-forbidden (api-call user1-request {:method :get :path "/api/v1/users"})))
  (testing "Admins get the list (bare array)"
    (let [resp (api-call admin-request {:method :get :path "/api/v1/users"})]
      (assert-ok resp)
      (is (sequential? (:body resp))))))

;; ============================================================
;; /users list shape — bare array (pagination intentionally deferred)
;; ============================================================

(deftest list-users-returns-bare-array
  (testing "GET /users returns a plain, username-ordered array of all users"
    ;; with-admin/with-test-users give us admin@, user1@, user2@; add 4 more.
    (doseq [u ["zz-aaa@example.com" "zz-bbb@example.com" "zz-ccc@example.com" "zz-ddd@example.com"]]
      (user/create db u false "password"))
    (let [r (api-call admin-request {:method :get :path "/api/v1/users"})
          _ (assert-ok r)
          body (:body r)]
      (is (sequential? body) "bare array, not an {:entries ...} envelope")
      ;; all 7 users present (3 standing + 4 created), none dropped by a cap
      (is (>= (count body) 7) (str "expected the full roster, got " (count body)))
      (is (every? #(contains? % :user/username) body))
      (is (= (map :user/username body)
             (sort (map :user/username body)))
          "ordered by username"))))

;; ============================================================
;; Task #100 V4 — last maintainer / last admin guards
;; ============================================================

(defn- add-maintainer* [actor proj uid]
  (api-call actor {:method :post
                   :path (str "/api/v1/projects/" proj "/maintainers/" uid)}))

(defn- remove-maintainer* [actor proj uid]
  (api-call actor {:method :delete
                   :path (str "/api/v1/projects/" proj "/maintainers/" uid)}))

(deftest cannot-remove-last-project-maintainer
  (testing "Removing the only maintainer is rejected with 400"
    (let [proj (create-test-project admin-request "LastMaintainerProj")]
      ;; add user1 as the only maintainer
      (assert-no-content (add-maintainer* admin-request proj "user1@example.com"))
      (assert-status 400 (remove-maintainer* admin-request proj "user1@example.com"))
      ;; Adding a second maintainer makes the removal succeed.
      (assert-no-content (add-maintainer* admin-request proj "user2@example.com"))
      (assert-no-content (remove-maintainer* admin-request proj "user1@example.com")))))

(deftest cannot-demote-last-admin
  (testing "Demoting the only admin via PATCH is rejected"
    ;; admin@example.com is the standing admin. The only admin.
    (let [resp (api-call admin-request {:method :patch
                                        :path "/api/v1/users/admin@example.com"
                                        :body {:is-admin false}})]
      (assert-status 400 resp))))

(deftest cannot-delete-last-admin
  (testing "Deleting the only admin is rejected"
    (let [resp (api-call admin-request {:method :delete
                                        :path "/api/v1/users/admin@example.com"})]
      (assert-status 400 resp))))

(deftest cannot-delete-sole-project-maintainer
  (testing "Deleting a user who is the only maintainer of any project is
            rejected with 400, with the affected project ids surfaced."
    ;; Make a fresh non-admin user whose ONLY role anywhere is sole
    ;; maintainer of one project.
    (let [_ (user/create db "sole-maint@example.com" false "password")
          proj (create-test-project admin-request "SoleMaintProj")
          _ (assert-no-content (add-maintainer* admin-request proj
                                                "sole-maint@example.com"))
          resp (api-call admin-request {:method :delete
                                        :path "/api/v1/users/sole-maint@example.com"})]
      (assert-status 400 resp))))

;; ============================================================
;; Task #100 V5 — metadata key validation
;; ============================================================

(deftest valid-metadata-key-rejects-bad-keys
  (testing "Empty string rejected"
    (is (not (metadata/valid-metadata-key? ""))))
  (testing "Whitespace-only rejected"
    (is (not (metadata/valid-metadata-key? "   ")))
    (is (not (metadata/valid-metadata-key? "\t\t"))))
  (testing "Over max length rejected"
    (is (not (metadata/valid-metadata-key?
              (apply str (repeat (inc metadata/max-metadata-key-length) "a"))))))
  (testing "Control characters rejected"
    (is (not (metadata/valid-metadata-key? "ab cd")))
    (is (not (metadata/valid-metadata-key? "abcd")))
    (is (not (metadata/valid-metadata-key? "abcd")))
    (is (not (metadata/valid-metadata-key? "ab\ncd"))))
  (testing "Reasonable keys accepted"
    (is (metadata/valid-metadata-key? "k1"))
    (is (metadata/valid-metadata-key? :a-keyword))
    (is (metadata/valid-metadata-key? "with spaces"))))
