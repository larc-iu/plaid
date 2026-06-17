(ns plaid.rest-api.v1.vocab-item-bulk-test
  "Tests for POST/DELETE /vocab-items/bulk — the bulk vocab-item endpoints,
  sibling to the vocab-link bulk variants. Unlike vocab links, vocab items
  hang off a vocab LAYER (not a document), so there is no document/OCC
  version and entries may target different layers in one call."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request assert-status assert-created assert-ok
                                    assert-no-content assert-bad-request assert-forbidden
                                    with-admin with-test-users user1-request with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private user1 "user1@example.com")

(defn- setup
  "A project plus two vocab layers, both granted to the project."
  []
  (let [proj (create-test-project admin-request "BulkVI")
        v1 (-> (create-vocab-layer admin-request "V1") :body :id)
        v2 (-> (create-vocab-layer admin-request "V2") :body :id)]
    (link-vocab-to-project admin-request proj v1)
    (link-vocab-to-project admin-request proj v2)
    {:proj proj :v1 v1 :v2 v2}))

(deftest bulk-create-heterogeneous
  (testing "creates items across DIFFERENT vocab layers in one call"
    (let [{:keys [v1 v2]} (setup)
          res (bulk-create-vocab-items admin-request
                                       [{:vocab-layer-id v1 :form "dogs"}
                                        {:vocab-layer-id v2 :form "run"}
                                        {:vocab-layer-id v1 :form "cat"}])
          ids (-> res :body :ids)]
      (assert-created res)
      (is (= 3 (count ids)))
      (is (apply distinct? ids) "every item gets its own id")
      ;; Each item resolves with the right layer + form, in input order.
      (is (= v1 (-> (get-vocab-item admin-request (nth ids 0)) :body :vocab-item/layer)))
      (is (= "dogs" (-> (get-vocab-item admin-request (nth ids 0)) :body :vocab-item/form)))
      (is (= v2 (-> (get-vocab-item admin-request (nth ids 1)) :body :vocab-item/layer)))
      (is (= "run" (-> (get-vocab-item admin-request (nth ids 1)) :body :vocab-item/form)))
      (is (= v1 (-> (get-vocab-item admin-request (nth ids 2)) :body :vocab-item/layer))))))

(deftest bulk-create-with-metadata
  (testing "inline metadata is folded onto each created item"
    (let [{:keys [v1]} (setup)
          res (bulk-create-vocab-items admin-request
                                       [{:vocab-layer-id v1 :form "dogs"
                                         :metadata {"prov" "inferred" "provSource" "import:x"}}])
          item-id (-> res :body :ids first)]
      (assert-created res)
      (is (= "inferred" (-> (get-vocab-item admin-request item-id) :body :metadata (get "prov")))))))

(deftest bulk-create-rejects-bad-entry
  (testing "an unknown vocab layer fails the whole atomic batch (400)"
    (let [{:keys [v1]} (setup)]
      (assert-status 400
                     (bulk-create-vocab-items admin-request
                                              [{:vocab-layer-id v1 :form "dogs"}
                                               {:vocab-layer-id (random-uuid) :form "run"}])))))

(deftest bulk-create-rejects-empty
  (testing "an empty array is a 400 (at least one item required)"
    (setup)
    (assert-bad-request (bulk-create-vocab-items admin-request []))))

(deftest bulk-delete-cascades-links-and-drops-unknown
  (testing "bulk delete removes items + their descendant links; unknown ids dropped"
    (let [{:keys [proj v1]} (setup)
          ;; A doc + a token so we can link an item, to prove the cascade.
          doc (create-test-document admin-request proj "Doc")
          tl (-> (create-text-layer admin-request proj "TL") :body :id)
          text-id (-> (create-text admin-request tl doc "dogs run") :body :id)
          word (-> (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}) :body :id)
          tok (-> (bulk-create-tokens admin-request [{:token-layer-id word :text text-id :begin 0 :end 4}]) :body :ids first)
          ids (-> (bulk-create-vocab-items admin-request
                                           [{:vocab-layer-id v1 :form "dogs"}
                                            {:vocab-layer-id v1 :form "run"}])
                  :body :ids)
          [i1 i2] ids
          link-id (-> (create-vocab-link admin-request i1 [tok]) :body :id)]
      ;; Sanity: the link exists before the delete.
      (assert-ok (get-vocab-link admin-request link-id))
      ;; Delete one real item + one bogus id → 204; the item AND its link gone.
      (assert-no-content (bulk-delete-vocab-items admin-request [i1 (random-uuid)]))
      (is (= 404 (:status (get-vocab-item admin-request i1))))
      (is (= 404 (:status (get-vocab-link admin-request link-id))) "descendant link cascaded")
      ;; The untouched item survives, then delete the rest.
      (assert-ok (get-vocab-item admin-request i2))
      (assert-no-content (bulk-delete-vocab-items admin-request [i2]))
      (is (= 404 (:status (get-vocab-item admin-request i2)))))))

(deftest bulk-requires-vocab-writer
  (testing "a user without write access to the layer cannot bulk create or delete"
    (let [{:keys [v1]} (setup)
          ids (-> (bulk-create-vocab-items admin-request [{:vocab-layer-id v1 :form "dogs"}]) :body :ids)]
      (assert-forbidden (bulk-create-vocab-items user1-request [{:vocab-layer-id v1 :form "x"}]))
      (assert-forbidden (bulk-delete-vocab-items user1-request ids)))))

(deftest writer-can-bulk
  (testing "a non-admin project writer (with the vocab granted) can bulk create + delete"
    (let [{:keys [proj v1]} (setup)
          _ (add-project-writer admin-request proj user1)
          res (bulk-create-vocab-items user1-request [{:vocab-layer-id v1 :form "dogs"}
                                                      {:vocab-layer-id v1 :form "run"}])
          ids (-> res :body :ids)]
      (assert-created res)
      (is (= 2 (count ids)))
      (assert-no-content (bulk-delete-vocab-items user1-request ids))
      (is (= 404 (:status (get-vocab-item admin-request (first ids))))))))
