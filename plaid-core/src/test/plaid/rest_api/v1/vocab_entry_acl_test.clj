(ns plaid.rest-api.v1.vocab-entry-acl-test
  "Renaming or deleting a vocabulary entry needs maintainer rights on the
  vocabulary; adding entries, editing their fields and linking stay open to
  the writers of a project the vocabulary is shared with
  (acl-shared-vocab-writers, ruled 2026-09-27). Every route to a rename or a
  delete is checked: single, bulk, and inside a batch."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request user1-request with-admin with-test-users
                                    api-call assert-created assert-ok assert-no-content
                                    assert-status with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private user1 "user1@example.com")

(defn- setup!
  "Vocabulary V shared by two projects, user1 a writer of the first.
  A document in the first with one token."
  []
  (let [v (-> (create-vocab-layer admin-request "Shared") :body :id)
        p1 (create-test-project admin-request "One")
        p2 (create-test-project admin-request "Two")
        _ (assert-no-content (link-vocab-to-project admin-request p1 v))
        _ (assert-no-content (link-vocab-to-project admin-request p2 v))
        _ (assert-no-content (add-project-writer admin-request p1 user1))
        tl (-> (create-text-layer admin-request p1 "Text") :body :id)
        tkl (-> (create-token-layer admin-request tl "Words") :body :id)
        doc (create-test-document admin-request p1 "Doc")
        text (-> (create-text admin-request tl doc "kai") :body :id)
        tok (-> (create-token admin-request tkl text 0 3) :body :id)
        item (-> (create-vocab-item admin-request v "kai") :body :id)]
    {:v v :item item :token tok}))

(defn- form-of [item]
  (-> (get-vocab-item admin-request item) :body :vocab-item/form))

(defn- batch [req ops]
  (api-call req {:method :post :path "/api/v1/batch" :body ops}))

(deftest a-writer-adds-edits-and-links-but-does-not-rename-or-delete
  (let [{:keys [v item token]} (setup!)]
    (testing "open to a writer"
      (assert-created (create-vocab-item user1-request v "mata"))
      (assert-created (bulk-create-vocab-items user1-request [{:vocab-layer-id v :form "a"}]))
      (assert-ok (update-vocab-item-metadata user1-request item {"gloss" "eat"}))
      (assert-ok (patch-vocab-item-metadata user1-request item [{:op "set" :path ["pos"] :value "V"}]))
      (assert-ok (bulk-update-vocab-items user1-request [{:id item :metadata [{:op "delete" :path ["pos"]}]}]))
      (assert-created (create-vocab-link user1-request item [token]))
      (testing "a PATCH that keeps the form is no rename"
        (assert-ok (update-vocab-item user1-request item "kai"))
        (assert-ok (bulk-update-vocab-items user1-request [{:id item :form "kai"}]))))
    (testing "refused to a writer"
      (assert-status 403 (update-vocab-item user1-request item "kay"))
      (assert-status 403 (bulk-update-vocab-items user1-request [{:id item :form "kay"}]))
      (assert-status 403 (delete-vocab-item user1-request item))
      (assert-status 403 (bulk-delete-vocab-items user1-request [item]))
      (testing "inside a batch too"
        (doseq [[label op] [["a batch rename" {:path (str "/api/v1/vocab-items/" item)
                                               :method "patch" :body {:form "kay"}}]
                            ["a batch delete" {:path (str "/api/v1/vocab-items/" item)
                                               :method "delete" :body nil}]]]
          (let [r (batch user1-request [op])]
            (is (some #{403} [(:status r) (get-in r [:body 0 :status])]) label))))
      (is (= "kai" (form-of item)) "nothing was renamed")
      (assert-ok (get-vocab-item admin-request item)))
    (testing "the refusal says why"
      (is (= "Only a maintainer of the vocabulary can rename or delete its entries."
             (-> (delete-vocab-item user1-request item) :body :error))))))

(deftest a-maintainer-of-the-vocabulary-renames-and-deletes
  (let [{:keys [v item]} (setup!)
        other (-> (create-vocab-item admin-request v "mata") :body :id)]
    (assert-no-content (add-vocab-maintainer admin-request v user1))
    (assert-ok (update-vocab-item user1-request item "kay"))
    (assert-ok (bulk-update-vocab-items user1-request [{:id item :form "kei"}]))
    (is (= "kei" (form-of item)))
    (assert-no-content (delete-vocab-item user1-request item))
    (assert-no-content (bulk-delete-vocab-items user1-request [other]))))

(deftest a-bulk-rename-needs-every-renamed-entrys-vocabulary
  (let [{:keys [v item]} (setup!)
        mine (-> (create-vocab-layer user1-request "Mine") :body :id)
        own (-> (create-vocab-item user1-request mine "x") :body :id)]
    (testing "renaming in the vocabulary it maintains, editing fields in the shared one"
      (assert-ok (bulk-update-vocab-items user1-request [{:id own :form "y"}
                                                         {:id item :metadata [{:op "set" :path ["g"] :value 1}]}])))
    (testing "renaming in both is refused, and neither changes"
      (assert-status 403 (bulk-update-vocab-items user1-request [{:id own :form "z"}
                                                                 {:id item :form "kay"}]))
      (is (= "y" (form-of own)))
      (is (= "kai" (form-of item))))
    (testing "deleting across both is refused"
      (assert-status 403 (bulk-delete-vocab-items user1-request [own item])))
    (is (some? v))))
