(ns plaid.rest-api.v1.span-test
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-xtdb
                                    with-mount-states with-rest-handler admin-request api-call
                                    assert-status assert-success assert-created assert-ok assert-no-content assert-not-found assert-bad-request assert-forbidden
                                    with-admin with-test-users user1-request user2-request]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-xtdb with-mount-states with-rest-handler with-admin with-test-users)

(deftest span-crud-and-invariants
  (let [proj (create-test-project admin-request "SpanProj")
        doc (create-test-document admin-request proj "Doc3")
        tl-res (create-text-layer admin-request proj "TL3")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        tr (create-text admin-request tl doc "abc")
        tid (-> tr :body :id)
        _ (assert-created tr)
        tkl-res (create-token-layer admin-request tl "TokenL2")
        tkl (-> tkl-res :body :id)
        _ (assert-created tkl-res)
        tk1 (create-token admin-request tkl tid 0 1)
        id1 (-> tk1 :body :id)
        _ (assert-created tk1)
        tk2 (create-token admin-request tkl tid 1 3)
        id2 (-> tk2 :body :id)
        _ (assert-created tk2)
        sl-res (create-span-layer admin-request tkl "SL2")
        sl (-> sl-res :body :id)
        _ (assert-created sl-res)
        ;; valid span
        r1 (create-span admin-request sl [id1 id2] "v")
        sid (-> r1 :body :id)]
    (assert-created r1)
    ;; invalid: empty tokens
    (let [r2 (create-span admin-request sl [] "v")]
      (assert-bad-request r2))
    ;; get, patch, replace tokens, delete
    (assert-ok (get-span admin-request sid))
    (assert-ok (update-span admin-request sid :value "w"))
    (assert-ok (update-span-tokens admin-request sid [id2]))
    (let [r3 (get-span admin-request sid)]
      (assert-ok r3)
      (is (= [id2] (-> r3 :body :span/tokens))))
    (assert-no-content (delete-span admin-request sid))
    (assert-not-found (get-span admin-request sid))))

(deftest span-atomic-values-and-metadata
  (let [proj (create-test-project admin-request "AtomicSpanProj")
        doc (create-test-document admin-request proj "AtomicDoc")
        tl-res (create-text-layer admin-request proj "AtomicTL")
        tl (-> tl-res :body :id)
        tr (create-text admin-request tl doc "test")
        tid (-> tr :body :id)
        tkl-res (create-token-layer admin-request tl "AtomicTokenL")
        tkl (-> tkl-res :body :id)
        tk1 (create-token admin-request tkl tid 0 2)
        id1 (-> tk1 :body :id)
        tk2 (create-token admin-request tkl tid 2 4)
        id2 (-> tk2 :body :id)
        sl-res (create-span-layer admin-request tkl "AtomicSL")
        sl (-> sl-res :body :id)]

    ;; Test atomic values
    (testing "Valid atomic values"
      ;; String value
      (let [span1 (create-span admin-request sl [id1] "PERSON")]
        (assert-created span1)
        (is (= "PERSON" (-> (get-span admin-request (-> span1 :body :id)) :body :span/value)))
        (assert-no-content (delete-span admin-request (-> span1 :body :id))))

      ;; Number value
      (let [span2 (create-span admin-request sl [id1] 42)]
        (assert-created span2)
        (is (= 42 (-> (get-span admin-request (-> span2 :body :id)) :body :span/value)))
        (assert-no-content (delete-span admin-request (-> span2 :body :id))))

      ;; Boolean value
      (let [span3 (create-span admin-request sl [id1] true)]
        (assert-created span3)
        (is (= true (-> (get-span admin-request (-> span3 :body :id)) :body :span/value)))
        (assert-no-content (delete-span admin-request (-> span3 :body :id))))

      ;; Null value
      (let [span4 (create-span admin-request sl [id1] nil)]
        (assert-created span4)
        (is (= nil (-> (get-span admin-request (-> span4 :body :id)) :body :span/value)))
        (assert-no-content (delete-span admin-request (-> span4 :body :id)))))

    ;; Test metadata functionality
    (testing "Metadata support"
      ;; Create span with metadata
      (let [metadata {"confidence" 0.95 "source" "model-v2" "reviewed" false}
            span (create-span admin-request sl [id1 id2] "ENTITY" metadata)
            sid (-> span :body :id)]
        (assert-created span)

        ;; Verify metadata is returned
        (let [retrieved (get-span admin-request sid)]
          (assert-ok retrieved)
          (is (= "ENTITY" (-> retrieved :body :span/value)))
          (is (= metadata (-> retrieved :body :metadata))))

        ;; Update metadata
        (let [new-metadata {"confidence" 0.98 "annotator" "human"}
              update-result (update-span-metadata admin-request sid new-metadata)]
          (assert-ok update-result)
          (is (= new-metadata (-> update-result :body :metadata)))
          (is (= "ENTITY" (-> update-result :body :span/value))))

        ;; Update both value and metadata
        (let [final-metadata {"final" true}]
          (assert-ok (update-span admin-request sid :value "FINAL"))
          (let [update-result (update-span-metadata admin-request sid final-metadata)]
            (assert-ok update-result)
            (is (= "FINAL" (-> update-result :body :span/value)))
            (is (= final-metadata (-> update-result :body :metadata)))))

        (assert-no-content (delete-span admin-request sid)))

      ;; Span without metadata should not have metadata field
      (let [span (create-span admin-request sl [id1] "NO_METADATA")
            sid (-> span :body :id)]
        (assert-created span)
        (let [retrieved (get-span admin-request sid)]
          (assert-ok retrieved)
          (is (= "NO_METADATA" (-> retrieved :body :span/value)))
          (is (nil? (-> retrieved :body :metadata))))
        (assert-no-content (delete-span admin-request sid))))))

(deftest span-metadata-functionality
  (let [proj (create-test-project admin-request "MetadataProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        tr (create-text admin-request tl doc "hello")
        tid (-> tr :body :id)
        _ (assert-created tr)
        tkl-res (create-token-layer admin-request tl "TokenL")
        tkl (-> tkl-res :body :id)
        _ (assert-created tkl-res)
        tk1 (create-token admin-request tkl tid 0 5)
        id1 (-> tk1 :body :id)
        _ (assert-created tk1)
        sl-res (create-span-layer admin-request tkl "SL")
        sl (-> sl-res :body :id)
        _ (assert-created sl-res)]
    ;; Create span with metadata
    (let [metadata {"logprobs" 0.95 "confidence" "high"}
          r1 (create-span admin-request sl [id1] "hello" metadata)
          sid (-> r1 :body :id)]
      (assert-created r1)
      ;; Get span and check metadata is returned
      (let [r2 (get-span admin-request sid)]
        (assert-ok r2)
        (is (= "hello" (-> r2 :body :span/value)))
        (is (= metadata (-> r2 :body :metadata))))
      ;; Update metadata only
      (let [new-metadata {"updated" true "score" 1.0}]
        (assert-ok (update-span-metadata admin-request sid new-metadata))
        (let [r3 (get-span admin-request sid)]
          (assert-ok r3)
          (is (= "hello" (-> r3 :body :span/value)))
          (is (= new-metadata (-> r3 :body :metadata)))))
      ;; Update value only (metadata should be preserved)
      (assert-ok (update-span admin-request sid :value "updated"))
      (let [r4 (get-span admin-request sid)]
        (assert-ok r4)
        (is (= "updated" (-> r4 :body :span/value)))
        (is (= {"updated" true "score" 1.0} (-> r4 :body :metadata))))
      ;; Update both value and metadata
      (let [final-metadata {"final" true}]
        (assert-ok (update-span admin-request sid :value "final"))
        (assert-ok (update-span-metadata admin-request sid final-metadata))
        (let [r5 (get-span admin-request sid)]
          (assert-ok r5)
          (is (= "final" (-> r5 :body :span/value)))
          (is (= final-metadata (-> r5 :body :metadata)))))
      ;; Delete metadata
      (let [r6 (delete-span-metadata admin-request sid)]
        (assert-ok r6)
        (is (= "final" (-> r6 :body :span/value)))
        (is (nil? (-> r6 :body :metadata)))))))

(deftest span-validation-rules
  (let [proj (create-test-project admin-request "SpanValidationProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "hello world test")
        text-id (-> text-res :body :id)
        _ (assert-created text-res)
        tkl-res (create-token-layer admin-request tl "TKL")
        tkl (-> tkl-res :body :id)
        _ (assert-created tkl-res)
        token1-res (create-token admin-request tkl text-id 0 5)
        token1-id (-> token1-res :body :id)
        _ (assert-created token1-res)
        token2-res (create-token admin-request tkl text-id 6 11)
        token2-id (-> token2-res :body :id)
        _ (assert-created token2-res)
        sl-res (create-span-layer admin-request tkl "SL")
        sl (-> sl-res :body :id)
        _ (assert-created sl-res)]

    (testing "Non-existent span layer"
      (let [fake-sl (java.util.UUID/randomUUID)
            res (create-span admin-request fake-sl [token1-id] "test")]
        (assert-bad-request res)))

    (testing "Non-existent token IDs"
      (let [fake-token (java.util.UUID/randomUUID)
            res (create-span admin-request sl [fake-token] "test")]
        (assert-bad-request res)))

    (testing "Tokens from different layers"
      (let [other-tkl-res (create-token-layer admin-request tl "OtherTKL")
            other-tkl (-> other-tkl-res :body :id)
            _ (assert-created other-tkl-res)
            other-token-res (create-token admin-request other-tkl text-id 12 16)
            other-token-id (-> other-token-res :body :id)
            _ (assert-created other-token-res)
            res (create-span admin-request sl [token1-id other-token-id] "test")]
        (assert-bad-request res)))

    (testing "Span layer not linked to token layer"
      (let [other-tkl-res (create-token-layer admin-request tl "UnlinkedTKL")
            other-tkl (-> other-tkl-res :body :id)
            _ (assert-created other-tkl-res)
            other-sl-res (create-span-layer admin-request other-tkl "OtherSL")
            other-sl (-> other-sl-res :body :id)
            _ (assert-created other-sl-res)
            res (create-span admin-request other-sl [token1-id] "test")]
        (assert-bad-request res)))

    (testing "Tokens from different documents"
      (let [other-doc (create-test-document admin-request proj "OtherDoc")
            other-text-res (create-text admin-request tl other-doc "other text")
            other-text-id (-> other-text-res :body :id)
            _ (assert-created other-text-res)
            other-token-res (create-token admin-request tkl other-text-id 0 5)
            other-token-id (-> other-token-res :body :id)
            _ (assert-created other-token-res)
            res (create-span admin-request sl [token1-id other-token-id] "test")]
        (assert-bad-request res)))

    (testing "Span token update validations"
      (let [span-res (create-span admin-request sl [token1-id] "test")
            span-id (-> span-res :body :id)
            _ (assert-created span-res)]

        (testing "Update with non-existent token"
          (let [fake-token (java.util.UUID/randomUUID)
                res (update-span-tokens admin-request span-id [fake-token])]
            (assert-bad-request res)))

        (testing "Update with empty token list"
          (let [res (update-span-tokens admin-request span-id [])]
            (assert-bad-request res)))))))

(deftest bulk-span-operations
  (let [proj (create-test-project admin-request "BulkSpanProj")
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
        _ (assert-created tkl2-res)
        ;; Create tokens for doc1/tkl1
        tok1-res (create-token admin-request tkl1 text1-id 0 5)
        tok1-id (-> tok1-res :body :id)
        _ (assert-created tok1-res)
        tok2-res (create-token admin-request tkl1 text1-id 6 11)
        tok2-id (-> tok2-res :body :id)
        _ (assert-created tok2-res)
        tok3-res (create-token admin-request tkl1 text1-id 12 16)
        tok3-id (-> tok3-res :body :id)
        _ (assert-created tok3-res)
        ;; Create tokens for doc2/tkl1
        tok4-res (create-token admin-request tkl1 text2-id 0 7)
        tok4-id (-> tok4-res :body :id)
        _ (assert-created tok4-res)
        ;; Create tokens for doc1/tkl2
        tok5-res (create-token admin-request tkl2 text1-id 0 5)
        tok5-id (-> tok5-res :body :id)
        _ (assert-created tok5-res)
        sl1-res (create-span-layer admin-request tkl1 "SL1")
        sl1 (-> sl1-res :body :id)
        _ (assert-created sl1-res)
        sl2-res (create-span-layer admin-request tkl2 "SL2")
        sl2 (-> sl2-res :body :id)
        _ (assert-created sl2-res)]

    (testing "Bulk create spans - success case"
      (let [spans [{:span-layer-id sl1 :tokens [tok1-id] :value "NOUN"}
                   {:span-layer-id sl1 :tokens [tok2-id] :value "VERB"}
                   {:span-layer-id sl1 :tokens [tok3-id] :value "ADJ"}]
            res (bulk-create-spans admin-request spans)]
        (assert-created res)
        (is (= 3 (count (-> res :body :ids))))
        ;; Clean up
        (bulk-delete-spans admin-request (-> res :body :ids))))

    (testing "Bulk create spans with metadata"
      (let [spans [{:span-layer-id sl1 :tokens [tok1-id] :value "ENTITY" :metadata {"confidence" 0.9}}
                   {:span-layer-id sl1 :tokens [tok2-id] :value "ACTION" :metadata {"confidence" 0.8}}]
            res (bulk-create-spans admin-request spans)]
        (assert-created res)
        (is (= 2 (count (-> res :body :ids))))
        ;; Verify metadata was set
        (let [span-id (first (-> res :body :ids))
              span-get (get-span admin-request span-id)]
          (assert-ok span-get)
          (is (= {"confidence" 0.9} (-> span-get :body :metadata))))
        ;; Clean up
        (bulk-delete-spans admin-request (-> res :body :ids))))

    (testing "Bulk create spans with multiple tokens"
      (let [spans [{:span-layer-id sl1 :tokens [tok1-id tok2-id] :value "PHRASE"}
                   {:span-layer-id sl1 :tokens [tok3-id] :value "WORD"}]
            res (bulk-create-spans admin-request spans)]
        (assert-created res)
        (is (= 2 (count (-> res :body :ids))))
        ;; Clean up
        (bulk-delete-spans admin-request (-> res :body :ids))))

    (testing "Bulk create spans - cross-document failure"
      (let [spans [{:span-layer-id sl1 :tokens [tok1-id] :value "WORD1"}
                   {:span-layer-id sl1 :tokens [tok4-id] :value "WORD2"}] ; tok4 is from doc2
            res (bulk-create-spans admin-request spans)]
        ;; Should fail because spans reference tokens from different documents
        (assert-status 400 res)))

    (testing "Bulk create spans - cross-layer failure"
      (let [spans [{:span-layer-id sl1 :tokens [tok1-id] :value "WORD1"}
                   {:span-layer-id sl2 :tokens [tok5-id] :value "WORD2"}] ; different span layer
            res (bulk-create-spans admin-request spans)]
        ;; Should fail because spans are in different layers
        (assert-status 400 res)))

    (testing "Bulk create spans - tokens from different layers within same span"
      (let [spans [{:span-layer-id sl1 :tokens [tok1-id tok5-id] :value "MIXED"}] ; tok5 is from tkl2
            res (bulk-create-spans admin-request spans)]
        ;; Should fail because tokens within a span are from different token layers
        (assert-status 400 res)))

    (testing "Bulk create spans - empty tokens list"
      (let [spans [{:span-layer-id sl1 :tokens [] :value "EMPTY"}]
            res (bulk-create-spans admin-request spans)]
        (assert-status 400 res)))

    (testing "Bulk create spans - non-existent tokens"
      (let [fake-token-id (java.util.UUID/randomUUID)
            spans [{:span-layer-id sl1 :tokens [fake-token-id] :value "FAKE"}]
            res (bulk-create-spans admin-request spans)]
        (assert-status 400 res)))

    (testing "Bulk delete spans - success case"
      ;; First create some spans
      (let [spans [{:span-layer-id sl1 :tokens [tok1-id] :value "WORD1"}
                   {:span-layer-id sl1 :tokens [tok2-id] :value "WORD2"}]
            create-res (bulk-create-spans admin-request spans)
            _ (assert-created create-res)
            span-ids (-> create-res :body :ids)
            delete-res (bulk-delete-spans admin-request span-ids)]
        (assert-no-content delete-res)
        ;; Verify spans are deleted
        (doseq [span-id span-ids]
          (assert-not-found (get-span admin-request span-id)))))

    (testing "Bulk delete spans - with relations"
      ;; Create spans, relations, then delete spans
      (let [spans [{:span-layer-id sl1 :tokens [tok1-id] :value "SOURCE"}
                   {:span-layer-id sl1 :tokens [tok2-id] :value "TARGET"}]
            create-res (bulk-create-spans admin-request spans)
            _ (assert-created create-res)
            span-ids (-> create-res :body :ids)
            rl-res (create-relation-layer admin-request sl1 "RL")
            rl (-> rl-res :body :id)
            _ (assert-created rl-res)
            rel-res (create-relation admin-request rl (first span-ids) (second span-ids) "DEPENDS")
            rel-id (-> rel-res :body :id)
            _ (assert-created rel-res)
            delete-res (bulk-delete-spans admin-request span-ids)]
        ;; Should succeed - relations should be deleted with spans
        (assert-no-content delete-res)
        ;; Verify spans and relations are deleted
        (doseq [span-id span-ids]
          (assert-not-found (get-span admin-request span-id)))
        (assert-not-found (get-relation admin-request rel-id))))))

(deftest span-access-control
  (let [proj (create-test-project admin-request "SpanACProj")
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
        tok1-res (create-token admin-request tkl text-id 0 5)
        tok1-id (-> tok1-res :body :id)
        _ (assert-created tok1-res)
        tok2-res (create-token admin-request tkl text-id 6 11)
        tok2-id (-> tok2-res :body :id)
        _ (assert-created tok2-res)
        sl-res (create-span-layer admin-request tkl "SL")
        sl (-> sl-res :body :id)
        _ (assert-created sl-res)
        span-res (create-span admin-request sl [tok1-id] "V")
        span-id (-> span-res :body :id)
        _ (assert-created span-res)]

    (testing "Non-member cannot access spans"
      (assert-forbidden (get-span user1-request span-id))
      (assert-forbidden (create-span user1-request sl [tok2-id] "X"))
      (assert-forbidden (update-span user1-request span-id :value "Y"))
      (assert-forbidden (delete-span user1-request span-id)))

    (testing "Reader can GET but not write"
      (assert-no-content (add-project-reader admin-request proj "user1@example.com"))
      (assert-ok (get-span user1-request span-id))
      (assert-forbidden (create-span user1-request sl [tok2-id] "X"))
      (assert-forbidden (update-span user1-request span-id :value "Y"))
      (assert-forbidden (delete-span user1-request span-id)))

    (testing "Writer can perform all CRUD"
      (assert-no-content (add-project-writer admin-request proj "user2@example.com"))
      (assert-ok (get-span user2-request span-id))
      (let [new-span (create-span user2-request sl [tok2-id] "W")
            new-id (-> new-span :body :id)]
        (assert-created new-span)
        (assert-ok (update-span user2-request new-id :value "X"))
        (assert-no-content (delete-span user2-request new-id))))))
