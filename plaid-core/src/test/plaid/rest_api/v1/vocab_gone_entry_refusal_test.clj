(ns plaid.rest-api.v1.vocab-gone-entry-refusal-test
  "Deleting or merging into an entry that no longer exists is refused 403,
  as any unknown id is (the core ruling on unknown ids), but with the
  generic wording that names no vocabulary, never the maintainers-only
  message. A client reads that wording as \"changed or removed\" (D3), where
  the maintainers-only message told a maintainer they lacked the right
  (REV-F-BULK defect 4)."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request user1-request user2-request
                                    with-admin with-test-users
                                    api-call assert-status assert-no-content with-clean-db]]
            [plaid.test-helpers :refer [create-test-project create-vocab-layer
                                        create-vocab-item delete-vocab-item
                                        link-vocab-to-project add-project-writer
                                        add-vocab-maintainer get-vocab-item]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private user1 "user1@example.com")
(def ^:private user2 "user2@example.com")

;; The client's test for a refusal of something gone (plaid-ui errors.js
;; GONE_403), for a vocabulary.
(def ^:private gone-wording #"(?i)\baccess to vocab layer(?:\(s\))?\s*(?:\[\s*\])?$")

(defn- merge! [request-fn survivor losers]
  (api-call request-fn {:method :post
                        :path (str "/api/v1/vocab-items/" survivor "/merge")
                        :body {:losers losers}}))

(defn- setup!
  "Vocabulary V, linked to a project user1 and user2 write in. user1
  maintains V, user2 does not. Entries dog1 and dog2."
  []
  (let [v (-> (create-vocab-layer admin-request "Lex") :body :id)
        p (create-test-project admin-request "P")
        _ (assert-no-content (link-vocab-to-project admin-request p v))
        _ (assert-no-content (add-project-writer admin-request p user1))
        _ (assert-no-content (add-project-writer admin-request p user2))
        _ (assert-no-content (add-vocab-maintainer admin-request v user1))
        dog1 (-> (create-vocab-item admin-request v "dog") :body :id)
        dog2 (-> (create-vocab-item admin-request v "dog") :body :id)]
    {:v v :dog1 dog1 :dog2 dog2}))

(deftest a-maintainer-told-an-entry-is-gone-reads-it-as-gone
  (let [{:keys [dog1 dog2]} (setup!)]
    (assert-no-content (delete-vocab-item admin-request dog1))
    (testing "a merge into a deleted survivor"
      (let [r (merge! user1-request dog1 [dog2])]
        (assert-status 403 r)
        (is (re-find gone-wording (-> r :body :error)))
        (is (= 200 (:status (get-vocab-item admin-request dog2))) "the loser is untouched")))
    (testing "a delete of a deleted entry"
      (let [r (delete-vocab-item user1-request dog1)]
        (assert-status 403 r)
        (is (re-find gone-wording (-> r :body :error)))))
    (testing "inside a batch"
      (let [r (api-call user1-request {:method :post :path "/api/v1/batch"
                                       :body [{:path (str "/api/v1/vocab-items/" dog1 "/merge")
                                               :method "post" :body {:losers [dog2]}}]})]
        (assert-status 403 r)
        (is (re-find gone-wording (-> r :body :error)))))))

(deftest a-real-refusal-keeps-its-wording
  (let [{:keys [dog1 dog2]} (setup!)]
    (doseq [r [(merge! user2-request dog1 [dog2]) (delete-vocab-item user2-request dog1)]]
      (assert-status 403 r)
      (is (= "Only a maintainer of the vocabulary can rename or delete its entries."
             (-> r :body :error)))
      (is (not (re-find gone-wording (-> r :body :error)))))))

(deftest an-unknown-id-is-still-403-to-anyone-but-an-admin
  (let [_ (setup!)
        unknown (random-uuid)]
    (assert-status 403 (delete-vocab-item user2-request unknown))
    (assert-status 403 (merge! user2-request unknown []))
    (is (= 404 (:status (delete-vocab-item admin-request unknown))))))
