(ns plaid.rest-api.v1.vocab-link-bulk-test
  "Tests for POST/DELETE /vocab-links/bulk — the bulk vocab-link endpoints
  added alongside the existing token/span/relation bulk variants."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request assert-status assert-created assert-ok
                                    assert-no-content assert-bad-request assert-forbidden
                                    with-admin with-test-users user1-request with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- setup
  "Project + doc + text-layer + text 'dogs run cat' + a word token layer with
  three tokens, plus a vocab layer linked to the project with two items."
  []
  (let [proj (create-test-project admin-request "BulkVL")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        text-id (-> (create-text admin-request tl doc "dogs run cat") :body :id)
        word (-> (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}) :body :id)
        tok-res (bulk-create-tokens admin-request
                                    (mapv (fn [[b e]] {:token-layer-id word :text text-id :begin b :end e})
                                          [[0 4] [5 8] [9 12]]))
        [t1 t2 t3] (-> tok-res :body :ids)
        vocab (-> (create-vocab-layer admin-request "V") :body :id)
        _ (link-vocab-to-project admin-request proj vocab)
        item-a (-> (create-vocab-item admin-request vocab "dogs") :body :id)
        item-b (-> (create-vocab-item admin-request vocab "run") :body :id)]
    (assert-created tok-res)
    {:proj proj :doc doc :text-id text-id :word word
     :t1 t1 :t2 t2 :t3 t3 :vocab vocab :item-a item-a :item-b item-b}))

(deftest bulk-create-heterogeneous
  (testing "links many tokens to DIFFERENT vocab items in one call"
    (let [{:keys [t1 t2 t3 item-a item-b]} (setup)
          res (bulk-create-vocab-links admin-request
                                       [{:vocab-item item-a :tokens [t1]}
                                        {:vocab-item item-b :tokens [t2]}
                                        {:vocab-item item-a :tokens [t3]}])
          ids (-> res :body :ids)]
      (assert-created res)
      (is (= 3 (count ids)))
      (is (apply distinct? ids) "every link gets its own id")
      ;; Each link resolves with the right item + token.
      (is (= item-a (-> (get-vocab-link admin-request (nth ids 0)) :body :vocab-link/vocab-item)))
      (is (= [t1] (-> (get-vocab-link admin-request (nth ids 0)) :body :vocab-link/tokens)))
      (is (= item-b (-> (get-vocab-link admin-request (nth ids 1)) :body :vocab-link/vocab-item)))
      (is (= [t3] (-> (get-vocab-link admin-request (nth ids 2)) :body :vocab-link/tokens))))))

(deftest bulk-create-with-metadata
  (testing "inline metadata is folded onto each created link"
    (let [{:keys [t1 item-a]} (setup)
          res (bulk-create-vocab-links admin-request
                                       [{:vocab-item item-a :tokens [t1]
                                         :metadata {"prov" "inferred" "provSource" "rule:x"}}])
          link-id (-> res :body :ids first)]
      (assert-created res)
      (is (= "inferred" (-> (get-vocab-link admin-request link-id) :body :metadata (get "prov")))))))

(deftest bulk-create-rejects-multi-document
  (testing "tokens spread across two documents are rejected (400)"
    (let [{:keys [proj t1 item-a]} (setup)
          ;; A second document with its own text + token.
          doc2 (create-test-document admin-request proj "Doc2")
          tl2 (-> (create-text-layer admin-request proj "TL2") :body :id)
          text2 (-> (create-text admin-request tl2 doc2 "dogs") :body :id)
          word2 (-> (create-token-layer-opts admin-request tl2 "Words2" {:overlap-mode "non-overlapping"}) :body :id)
          other (-> (bulk-create-tokens admin-request [{:token-layer-id word2 :text text2 :begin 0 :end 4}]) :body :ids first)]
      (assert-bad-request
       (bulk-create-vocab-links admin-request
                                [{:vocab-item item-a :tokens [t1]}
                                 {:vocab-item item-a :tokens [other]}])))))

(deftest bulk-create-rejects-bad-entry
  (testing "an unknown vocab item fails the whole atomic batch (400)"
    (let [{:keys [t1 t2 item-a]} (setup)]
      (assert-status 400
                     (bulk-create-vocab-links admin-request
                                              [{:vocab-item item-a :tokens [t1]}
                                               {:vocab-item (random-uuid) :tokens [t2]}])))))

(deftest bulk-delete-and-unknown-id-drop
  (testing "bulk delete removes existing links; unknown ids are silently dropped"
    (let [{:keys [t1 t2 item-a item-b]} (setup)
          ids (-> (bulk-create-vocab-links admin-request
                                           [{:vocab-item item-a :tokens [t1]}
                                            {:vocab-item item-b :tokens [t2]}])
                  :body :ids)
          [l1 l2] ids]
      ;; Delete one real + one bogus id → 204, the real one gone, the other kept.
      (assert-no-content (bulk-delete-vocab-links admin-request [l1 (random-uuid)]))
      (is (= 404 (:status (get-vocab-link admin-request l1))))
      (assert-ok (get-vocab-link admin-request l2))
      ;; Delete the rest.
      (assert-no-content (bulk-delete-vocab-links admin-request [l2]))
      (is (= 404 (:status (get-vocab-link admin-request l2)))))))

(deftest bulk-requires-project-writer
  (testing "a non-member cannot bulk create or delete"
    (let [{:keys [t1 item-a]} (setup)
          ids (-> (bulk-create-vocab-links admin-request [{:vocab-item item-a :tokens [t1]}]) :body :ids)]
      (assert-forbidden (bulk-create-vocab-links user1-request [{:vocab-item item-a :tokens [t1]}]))
      (assert-forbidden (bulk-delete-vocab-links user1-request ids)))))
