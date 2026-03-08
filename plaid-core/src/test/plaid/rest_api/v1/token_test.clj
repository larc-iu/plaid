(ns plaid.rest-api.v1.token-test
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-xtdb
                                    with-mount-states with-rest-handler admin-request api-call
                                    assert-status assert-success assert-created assert-ok assert-no-content assert-not-found assert-bad-request assert-forbidden
                                    with-admin with-test-users user1-request user2-request]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-xtdb with-mount-states with-rest-handler with-admin with-test-users)

(deftest token-crud-and-validation
  (let [proj (create-test-project admin-request "TknProj")
        doc (create-test-document admin-request proj "Doc2")
        tl-res (create-text-layer admin-request proj "TL2")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        tr (create-text admin-request tl doc "hello")
        tid (-> tr :body :id)
        _ (assert-created tr)
        tkl-res (create-token-layer admin-request tl "TokenL")
        tkl (-> tkl-res :body :id)
        _ (assert-created tkl-res)
        ;; valid token
        r1 (create-token admin-request tkl tid 0 5)
        tokid (-> r1 :body :id)]
    (assert-created r1)
    ;; invalid begin > end
    (let [r2 (create-token admin-request tkl tid 6 1)]
      (assert-bad-request r2))
    ;; get, patch, delete
    (assert-ok (get-token admin-request tokid))
    (assert-ok (update-token admin-request tokid :begin 1 :end 4))
    (let [r3 (get-token admin-request tokid)]
      (assert-ok r3)
      (is (= 1 (-> r3 :body :token/begin)))
      (is (= 4 (-> r3 :body :token/end))))
    (assert-no-content (delete-token admin-request tokid))
    (assert-not-found (get-token admin-request tokid))))

(deftest token-metadata-functionality
  (let [proj (create-test-project admin-request "TokenMetadataProj")
        doc (create-test-document admin-request proj "TokenDoc")
        tl-res (create-text-layer admin-request proj "TokenTL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "hello world test")
        text-id (-> text-res :body :id)
        _ (assert-created text-res)
        tkl-res (create-token-layer admin-request tl "TokenTKL")
        tkl (-> tkl-res :body :id)
        _ (assert-created tkl-res)]

    (testing "Create token with metadata"
      (let [metadata {"pos" "NOUN" "lemma" "hello" "confidence" 0.98 "manual" false}
            token-res (create-token admin-request tkl text-id 0 5 nil metadata)
            token-id (-> token-res :body :id)]
        (assert-created token-res)

        ;; Verify metadata is returned
        (let [retrieved (get-token admin-request token-id)]
          (assert-ok retrieved)
          (is (= 0 (-> retrieved :body :token/begin)))
          (is (= 5 (-> retrieved :body :token/end)))
          (is (= metadata (-> retrieved :body :metadata))))

        ;; Update metadata
        (let [new-metadata {"pos" "INTJ" "annotator" "human"}
              update-result (update-token-metadata admin-request token-id new-metadata)]
          (assert-ok update-result)
          (is (= new-metadata (-> update-result :body :metadata)))
          (is (= 0 (-> update-result :body :token/begin)))
          (is (= 5 (-> update-result :body :token/end))))

        ;; Update token extents (metadata should be preserved)
        (assert-ok (update-token admin-request token-id :begin 1 :end 4))
        (let [after-extent-update (get-token admin-request token-id)]
          (assert-ok after-extent-update)
          (is (= 1 (-> after-extent-update :body :token/begin)))
          (is (= 4 (-> after-extent-update :body :token/end)))
          (is (= {"pos" "INTJ" "annotator" "human"} (-> after-extent-update :body :metadata))))

        ;; Clear metadata
        (let [clear-result (delete-token-metadata admin-request token-id)]
          (assert-ok clear-result)
          (is (= 1 (-> clear-result :body :token/begin)))
          (is (= 4 (-> clear-result :body :token/end)))
          (is (nil? (-> clear-result :body :metadata))))

        (assert-no-content (delete-token admin-request token-id))))

    (testing "Token without metadata"
      (let [token-res (create-token admin-request tkl text-id 6 11)
            token-id (-> token-res :body :id)]
        (assert-created token-res)
        (let [retrieved (get-token admin-request token-id)]
          (assert-ok retrieved)
          (is (= 6 (-> retrieved :body :token/begin)))
          (is (= 11 (-> retrieved :body :token/end)))
          (is (nil? (-> retrieved :body :metadata))))

        ;; Add metadata to existing token
        (let [metadata {"added-later" true "type" "word"}
              update-result (update-token-metadata admin-request token-id metadata)]
          (assert-ok update-result)
          (is (= metadata (-> update-result :body :metadata)))
          (is (= 6 (-> update-result :body :token/begin)))
          (is (= 11 (-> update-result :body :token/end))))

        (assert-no-content (delete-token admin-request token-id))))

    (testing "Token with precedence and metadata"
      (let [metadata {"priority" "high" "manual" true}
            token-res (create-token admin-request tkl text-id 12 16 100 metadata)
            token-id (-> token-res :body :id)]
        (assert-created token-res)
        (let [retrieved (get-token admin-request token-id)]
          (assert-ok retrieved)
          (is (= 12 (-> retrieved :body :token/begin)))
          (is (= 16 (-> retrieved :body :token/end)))
          (is (= 100 (-> retrieved :body :token/precedence)))
          (is (= metadata (-> retrieved :body :metadata))))

        (assert-no-content (delete-token admin-request token-id))))))

(deftest token-validation-rules
  (let [proj (create-test-project admin-request "TokenValidationProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "hello world")
        text-id (-> text-res :body :id)
        _ (assert-created text-res)
        tkl-res (create-token-layer admin-request tl "TKL")
        tkl (-> tkl-res :body :id)
        _ (assert-created tkl-res)]

    (testing "Non-existent token layer"
      (let [fake-tkl (java.util.UUID/randomUUID)
            res (create-token admin-request fake-tkl text-id 0 5)]
        (assert-bad-request res)))

    (testing "Non-existent text"
      (let [fake-text (java.util.UUID/randomUUID)
            res (create-token admin-request tkl fake-text 0 5)]
        (assert-bad-request res)))

    (testing "Token layer not linked to text layer"
      (let [other-tl-res (create-text-layer admin-request proj "OtherTL")
            other-tl (-> other-tl-res :body :id)
            _ (assert-created other-tl-res)
            other-tkl-res (create-token-layer admin-request other-tl "OtherTKL")
            other-tkl (-> other-tkl-res :body :id)
            _ (assert-created other-tkl-res)
            res (create-token admin-request other-tkl text-id 0 5)]
        ;; This validation happens at database level and returns 500
        (assert-status 500 res)))

    (testing "Non-integer begin/end - coercion catches this at middleware level"
      (is (thrown? java.lang.IllegalArgumentException
                   (api-call admin-request {:method :post
                                            :path "/api/v1/tokens"
                                            :body {:token-layer-id tkl
                                                   :text text-id
                                                   :begin "0"
                                                   :end "5"}}))))

    (testing "Negative begin index"
      (let [res (create-token admin-request tkl text-id -1 5)]
        (assert-bad-request res)))

    (testing "Token end beyond text bounds"
      (let [res (create-token admin-request tkl text-id 0 100)]
        (assert-status 400 res)))

    (testing "Non-integer precedence - coercion catches this at middleware level"
      (is (thrown? java.lang.IllegalArgumentException
                   (api-call admin-request {:method :post
                                            :path "/api/v1/tokens"
                                            :body {:token-layer-id tkl
                                                   :text text-id
                                                   :begin 0
                                                   :end 5
                                                   :precedence "high"}}))))

    (testing "Zero-length token (begin equals end)"
      (let [res (create-token admin-request tkl text-id 5 5)]
        ;; Zero-length tokens are actually allowed in this system
        (assert-created res)))

    (testing "Update token with invalid extents"
      (let [token-res (create-token admin-request tkl text-id 0 5)
            token-id (-> token-res :body :id)
            _ (assert-created token-res)]

        (testing "Negative begin in update"
          (let [res (update-token admin-request token-id :begin -1)]
            (assert-bad-request res)))

        (testing "End beyond bounds in update"
          (let [res (update-token admin-request token-id :end 100)]
            (assert-bad-request res)))

        (testing "Non-positive extent in update"
          (let [res (update-token admin-request token-id :begin 3 :end 2)]
            (assert-bad-request res)))))))

(deftest bulk-token-operations
  (let [proj (create-test-project admin-request "BulkTokenProj")
        doc1 (create-test-document admin-request proj "Doc1")
        doc2 (create-test-document admin-request proj "Doc2")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text1-res (create-text admin-request tl doc1 "hello world test")
        text1-id (-> text1-res :body :id)
        _ (assert-created text1-res)
        text2-res (create-text admin-request tl doc2 "another document text")
        text2-id (-> text2-res :body :id)
        _ (assert-created text2-res)
        tkl1-res (create-token-layer admin-request tl "TKL1")
        tkl1 (-> tkl1-res :body :id)
        _ (assert-created tkl1-res)
        tkl2-res (create-token-layer admin-request tl "TKL2")
        tkl2 (-> tkl2-res :body :id)
        _ (assert-created tkl2-res)]

    (testing "Bulk create tokens - success case"
      (let [tokens [{:token-layer-id tkl1 :text text1-id :begin 0 :end 5}
                    {:token-layer-id tkl1 :text text1-id :begin 6 :end 11}
                    {:token-layer-id tkl1 :text text1-id :begin 12 :end 16}]
            res (bulk-create-tokens admin-request tokens)]
        (assert-created res)
        (is (= 3 (count (-> res :body :ids))))
        ;; Clean up
        (bulk-delete-tokens admin-request (-> res :body :ids))))

    (testing "Bulk create tokens with metadata"
      (let [tokens [{:token-layer-id tkl1 :text text1-id :begin 0 :end 5 :metadata {"pos" "NOUN"}}
                    {:token-layer-id tkl1 :text text1-id :begin 6 :end 11 :metadata {"pos" "VERB"}}]
            res (bulk-create-tokens admin-request tokens)]
        (assert-created res)
        (is (= 2 (count (-> res :body :ids))))
        ;; Verify metadata was set
        (let [token-id (first (-> res :body :ids))
              token-get (get-token admin-request token-id)]
          (assert-ok token-get)
          (is (= {"pos" "NOUN"} (-> token-get :body :metadata))))
        ;; Clean up
        (bulk-delete-tokens admin-request (-> res :body :ids))))

    (testing "Bulk create tokens with precedence"
      (let [tokens [{:token-layer-id tkl1 :text text1-id :begin 0 :end 5 :precedence 1}
                    {:token-layer-id tkl1 :text text1-id :begin 0 :end 5 :precedence 2}]
            res (bulk-create-tokens admin-request tokens)]
        (assert-created res)
        (is (= 2 (count (-> res :body :ids))))
        ;; Clean up
        (bulk-delete-tokens admin-request (-> res :body :ids))))

    (testing "Bulk create tokens - cross-document failure"
      (let [tokens [{:token-layer-id tkl1 :text text1-id :begin 0 :end 5}
                    {:token-layer-id tkl1 :text text2-id :begin 0 :end 7}]
            res (bulk-create-tokens admin-request tokens)]
        ;; Should fail because tokens span multiple documents
        (assert-status 400 res)))

    (testing "Bulk create tokens - cross-layer failure"
      (let [tokens [{:token-layer-id tkl1 :text text1-id :begin 0 :end 5}
                    {:token-layer-id tkl2 :text text1-id :begin 6 :end 11}]
            res (bulk-create-tokens admin-request tokens)]
        ;; Should fail because tokens span multiple layers
        (assert-status 400 res)))

    (testing "Bulk create tokens - invalid extents"
      (let [tokens [{:token-layer-id tkl1 :text text1-id :begin 0 :end 5}
                    {:token-layer-id tkl1 :text text1-id :begin 10 :end 5}] ; invalid: begin > end
            res (bulk-create-tokens admin-request tokens)]
        (assert-status 400 res)))

    (testing "Bulk create tokens - out of bounds"
      (let [tokens [{:token-layer-id tkl1 :text text1-id :begin 0 :end 5}
                    {:token-layer-id tkl1 :text text1-id :begin 0 :end 100}] ; out of bounds
            res (bulk-create-tokens admin-request tokens)]
        (assert-status 400 res)))

    (testing "Bulk delete tokens - success case"
      ;; First create some tokens
      (let [tokens [{:token-layer-id tkl1 :text text1-id :begin 0 :end 5}
                    {:token-layer-id tkl1 :text text1-id :begin 6 :end 11}]
            create-res (bulk-create-tokens admin-request tokens)
            _ (assert-created create-res)
            token-ids (-> create-res :body :ids)
            delete-res (bulk-delete-tokens admin-request token-ids)]
        (assert-no-content delete-res)
        ;; Verify tokens are deleted
        (doseq [token-id token-ids]
          (assert-not-found (get-token admin-request token-id)))))

    (testing "Bulk delete tokens - partial failure with spans"
      ;; Create tokens and spans, then try to delete tokens with spans
      (let [tokens [{:token-layer-id tkl1 :text text1-id :begin 0 :end 5}
                    {:token-layer-id tkl1 :text text1-id :begin 6 :end 11}]
            create-res (bulk-create-tokens admin-request tokens)
            _ (assert-created create-res)
            token-ids (-> create-res :body :ids)
            sl-res (create-span-layer admin-request tkl1 "SL")
            sl (-> sl-res :body :id)
            _ (assert-created sl-res)
            span-res (create-span admin-request sl [(first token-ids)] "test")
            _ (assert-created span-res)
            delete-res (bulk-delete-tokens admin-request token-ids)]
        ;; Should succeed - spans should be deleted with tokens
        (assert-no-content delete-res)
        ;; Verify all tokens are deleted
        (doseq [token-id token-ids]
          (assert-not-found (get-token admin-request token-id)))))))

(deftest token-access-control
  (let [proj (create-test-project admin-request "TokenACProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "hello world")
        text-id (-> text-res :body :id)
        _ (assert-created text-res)
        tkl-res (create-token-layer admin-request tl "TKL")
        tkl (-> tkl-res :body :id)
        _ (assert-created tkl-res)
        tok-res (create-token admin-request tkl text-id 0 5)
        tok-id (-> tok-res :body :id)
        _ (assert-created tok-res)]

    (testing "Non-member cannot access tokens"
      (assert-forbidden (get-token user1-request tok-id))
      (assert-forbidden (create-token user1-request tkl text-id 6 11))
      (assert-forbidden (update-token user1-request tok-id :begin 1 :end 4))
      (assert-forbidden (delete-token user1-request tok-id)))

    (testing "Reader can GET but not write"
      (assert-no-content (add-project-reader admin-request proj "user1@example.com"))
      (assert-ok (get-token user1-request tok-id))
      (assert-forbidden (create-token user1-request tkl text-id 6 11))
      (assert-forbidden (update-token user1-request tok-id :begin 1 :end 4))
      (assert-forbidden (delete-token user1-request tok-id)))

    (testing "Writer can perform all CRUD"
      (assert-no-content (add-project-writer admin-request proj "user2@example.com"))
      (assert-ok (get-token user2-request tok-id))
      (let [new-tok (create-token user2-request tkl text-id 6 11)
            new-id (-> new-tok :body :id)]
        (assert-created new-tok)
        (assert-ok (update-token user2-request new-id :begin 7 :end 10))
        (assert-no-content (delete-token user2-request new-id))))))
