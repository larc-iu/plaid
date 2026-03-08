(ns plaid.rest-api.v1.text-test
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-xtdb
                                    with-mount-states with-rest-handler admin-request api-call
                                    assert-status assert-success assert-created assert-ok assert-no-content assert-not-found assert-bad-request assert-forbidden
                                    with-admin with-test-users user1-request user2-request]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-xtdb with-mount-states with-rest-handler with-admin with-test-users)

(deftest text-crud-and-uniqueness
  (let [proj (create-test-project admin-request "DataProj")
        doc (create-test-document admin-request proj "Doc1")
        tl-res (create-text-layer admin-request proj "TL1")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        ;; create text
        res1 (create-text admin-request tl doc "foo")
        tid (-> res1 :body :id)]
    (assert-created res1)
    ;; cannot create second text on same layer+doc
    (let [res2 (create-text admin-request tl doc "bar")]
      (assert-status 409 res2))
    ;; get, patch, delete
    (assert-ok (get-text admin-request tid))
    (assert-ok (update-text admin-request tid "baz"))
    (let [res3 (get-text admin-request tid)]
      (assert-ok res3)
      (is (= "baz" (-> res3 :body :text/body))))
    (assert-no-content (delete-text admin-request tid))
    (assert-not-found (get-text admin-request tid))))

(deftest text-validation-rules
  (let [proj (create-test-project admin-request "TextValidationProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)]

    (testing "Non-existent text layer"
      (let [fake-tl (java.util.UUID/randomUUID)
            res (create-text admin-request fake-tl doc "test")]
        (assert-bad-request res)))

    (testing "Non-existent document"
      (let [fake-doc (java.util.UUID/randomUUID)
            res (create-text admin-request tl fake-doc "test")]
        (assert-bad-request res)))

    (testing "Text layer not linked to document's project"
      (let [other-proj (create-test-project admin-request "OtherProj")
            other-tl-res (create-text-layer admin-request other-proj "OtherTL")
            other-tl (-> other-tl-res :body :id)
            _ (assert-created other-tl-res)
            res (create-text admin-request other-tl doc "test")]
        (assert-bad-request res)))

    (testing "Duplicate text for same layer+document"
      (let [dup-doc (create-test-document admin-request proj "DupDoc")
            res1 (create-text admin-request tl dup-doc "first")
            _ (assert-created res1)
            res2 (create-text admin-request tl dup-doc "second")]
        (assert-status 409 res2)))))

(deftest text-update-with-tokens
  (let [proj (create-test-project admin-request "TextUpdateProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        tkl-res (create-token-layer admin-request tl "TKL")
        tkl (-> tkl-res :body :id)
        _ (assert-created tkl-res)]

    (testing "Update text - deletion of first word"
      (let [text-res (create-text admin-request tl doc "Hello world the quick brown fox jumped over the lazy brown dog")
            text-id (-> text-res :body :id)
            _ (assert-created text-res)
            tok1-res (create-token admin-request tkl text-id 0 5) ; "Hello"
            tok1-id (-> tok1-res :body :id)
            _ (assert-created tok1-res)
            tok2-res (create-token admin-request tkl text-id 6 11) ; "world"
            tok2-id (-> tok2-res :body :id)
            _ (assert-created tok2-res)]

        ;; Delete "Hello " - should delete tok1 and shift tok2
        (assert-ok (update-text admin-request text-id "world the quick brown fox jumped over the lazy brown dog"))

        ;; First token deleted, second token shifted
        (assert-not-found (get-token admin-request tok1-id))
        (let [tok2-get (get-token admin-request tok2-id)]
          (assert-ok tok2-get)
          (is (= 0 (-> tok2-get :body :token/begin)))
          (is (= 5 (-> tok2-get :body :token/end))))

        (delete-text admin-request text-id)))

    (testing "Update text with zero-width tokens"
      (let [text-res (create-text admin-request tl doc "The quick brown fox jumped over the lazy dog and then some more")
            text-id (-> text-res :body :id)
            _ (assert-created text-res)
            tok1-res (create-token admin-request tkl text-id 0 0) ; zero-width at start
            tok1-id (-> tok1-res :body :id)
            _ (assert-created tok1-res)
            tok2-res (create-token admin-request tkl text-id 10 10) ; zero-width at position 10 (after "quick ")
            tok2-id (-> tok2-res :body :id)
            _ (assert-created tok2-res)
            tok3-res (create-token admin-request tkl text-id 63 63) ; zero-width at end
            tok3-id (-> tok3-res :body :id)
            _ (assert-created tok3-res)]

        ;; Delete "brown " (positions 10-16) - should delete tok2
        (assert-ok (update-text admin-request text-id "The quick fox jumped over the lazy dog and then some more"))

        ;; Check tokens
        (assert-ok (get-token admin-request tok1-id)) ; still exists at position 0
        (assert-not-found (get-token admin-request tok2-id)) ; deleted
        (let [tok3-get (get-token admin-request tok3-id)]
          (assert-ok tok3-get)
          (is (= 57 (-> tok3-get :body :token/begin))) ; shifted left by 6
          (is (= 57 (-> tok3-get :body :token/end)))) ; still zero-width

        (delete-text admin-request text-id)))

    (testing "Update text - token deletion due to complete overlap"
      (let [text-res (create-text admin-request tl doc "The quick brown fox jumped over the lazy dog and then some more")
            text-id (-> text-res :body :id)
            _ (assert-created text-res)
            tok1-res (create-token admin-request tkl text-id 0 3) ; "The"
            tok1-id (-> tok1-res :body :id)
            _ (assert-created tok1-res)
            tok2-res (create-token admin-request tkl text-id 4 9) ; "quick"
            tok2-id (-> tok2-res :body :id)
            _ (assert-created tok2-res)
            tok3-res (create-token admin-request tkl text-id 10 15) ; "brown"
            tok3-id (-> tok3-res :body :id)
            _ (assert-created tok3-res)]

        ;; Delete "quick brown " - should delete tok2 and tok3
        (assert-ok (update-text admin-request text-id "The fox jumped over the lazy dog and then some more"))

        ;; Check tokens
        (assert-ok (get-token admin-request tok1-id)) ; still exists
        (assert-not-found (get-token admin-request tok2-id)) ; deleted
        (assert-not-found (get-token admin-request tok3-id)) ; deleted

        (delete-text admin-request text-id)))

    (testing "Update text - partial token overlap"
      (let [text-res (create-text admin-request tl doc "The overlapping words in this sentence are interesting to analyze")
            text-id (-> text-res :body :id)
            _ (assert-created text-res)
            tok1-res (create-token admin-request tkl text-id 4 11) ; "overlap" (positions 4-11)
            tok1-id (-> tok1-res :body :id)
            _ (assert-created tok1-res)
            tok2-res (create-token admin-request tkl text-id 8 15) ; "lapping" (positions 8-15)
            tok2-id (-> tok2-res :body :id)
            _ (assert-created tok2-res)]

        ;; Delete "lap" (positions 8-11) - affects both tokens
        (assert-ok (update-text admin-request text-id "The overping words in this sentence are interesting to analyze"))

        ;; Check token adjustments
        (let [tok1-get (get-token admin-request tok1-id)
              tok2-get (get-token admin-request tok2-id)]
          (assert-ok tok1-get)
          (assert-ok tok2-get)
          (is (= 4 (-> tok1-get :body :token/begin)))
          (is (= 9 (-> tok1-get :body :token/end))) ; shrunk to "overp"
          (is (= 8 (-> tok2-get :body :token/begin))) ; starts where deletion happened
          (is (= 12 (-> tok2-get :body :token/end)))) ; adjusted for deletion: "ping"

        (delete-text admin-request text-id)))

    (testing "Update text - insertion within token"
      (let [text-res (create-text admin-request tl doc "The hello world example is simple but effective for testing")
            text-id (-> text-res :body :id)
            _ (assert-created text-res)
            tok-res (create-token admin-request tkl text-id 4 9) ; "hello"
            tok-id (-> tok-res :body :id)
            _ (assert-created tok-res)]

        ;; Insert "XXX" in the middle of "hello"
        (assert-ok (update-text admin-request text-id "The heXXXllo world example is simple but effective for testing"))

        ;; Check token expansion
        (let [tok-get (get-token admin-request tok-id)]
          (assert-ok tok-get)
          (is (= 4 (-> tok-get :body :token/begin)))
          (is (= 12 (-> tok-get :body :token/end)))) ; expanded to include insertion

        (delete-text admin-request text-id)))

    (testing "Update text - complex multi-token scenario"
      (let [text-res (create-text admin-request tl doc "AABBCCDDEE followed by more text to ensure proper diff behavior")
            text-id (-> text-res :body :id)
            _ (assert-created text-res)
            ;; Create tokens for each pair
            tok1-res (create-token admin-request tkl text-id 0 2) ; "AA"
            tok1-id (-> tok1-res :body :id)
            _ (assert-created tok1-res)
            tok2-res (create-token admin-request tkl text-id 2 4) ; "BB"
            tok2-id (-> tok2-res :body :id)
            _ (assert-created tok2-res)
            tok3-res (create-token admin-request tkl text-id 4 6) ; "CC"
            tok3-id (-> tok3-res :body :id)
            _ (assert-created tok3-res)
            tok4-res (create-token admin-request tkl text-id 6 8) ; "DD"
            tok4-id (-> tok4-res :body :id)
            _ (assert-created tok4-res)
            tok5-res (create-token admin-request tkl text-id 8 10) ; "EE"
            tok5-id (-> tok5-res :body :id)
            _ (assert-created tok5-res)
            ;; Add a zero-width token in the middle
            tok6-res (create-token admin-request tkl text-id 5 5) ; zero-width between CC
            tok6-id (-> tok6-res :body :id)
            _ (assert-created tok6-res)]

        ;; Replace "BBCCDD" with "X" - should affect multiple tokens
        (assert-ok (update-text admin-request text-id "AAXEE followed by more text to ensure proper diff behavior"))

        ;; Check results
        (assert-ok (get-token admin-request tok1-id)) ; "AA" unaffected
        (assert-not-found (get-token admin-request tok2-id)) ; deleted
        (assert-not-found (get-token admin-request tok3-id)) ; deleted
        (assert-not-found (get-token admin-request tok4-id)) ; deleted
        (assert-not-found (get-token admin-request tok6-id)) ; zero-width deleted

        (let [tok5-get (get-token admin-request tok5-id)]
          (assert-ok tok5-get)
          (is (= 3 (-> tok5-get :body :token/begin))) ; shifted left significantly
          (is (= 5 (-> tok5-get :body :token/end)))) ; still "EE"

        (delete-text admin-request text-id)))

    (testing "Update text - token at deletion boundary"
      (let [text-res (create-text admin-request tl doc "The boundary test example shows how tokens behave at deletion boundaries")
            text-id (-> text-res :body :id)
            _ (assert-created text-res)
            tok1-res (create-token admin-request tkl text-id 4 12) ; "boundary"
            tok1-id (-> tok1-res :body :id)
            _ (assert-created tok1-res)
            tok2-res (create-token admin-request tkl text-id 13 17) ; "test"
            tok2-id (-> tok2-res :body :id)
            _ (assert-created tok2-res)]

        ;; Delete the space between words
        (assert-ok (update-text admin-request text-id "The boundarytest example shows how tokens behave at deletion boundaries"))

        ;; Check tokens remain intact but shifted
        (let [tok1-get (get-token admin-request tok1-id)
              tok2-get (get-token admin-request tok2-id)]
          (assert-ok tok1-get)
          (assert-ok tok2-get)
          (is (= 4 (-> tok1-get :body :token/begin)))
          (is (= 12 (-> tok1-get :body :token/end))) ; unchanged
          (is (= 12 (-> tok2-get :body :token/begin))) ; shifted to touch tok1
          (is (= 16 (-> tok2-get :body :token/end)))) ; shifted left by 1

        (delete-text admin-request text-id)))

    (testing "Update text - empty text edge case"
      (let [text-res (create-text admin-request tl doc "This entire sentence will be deleted to create an empty text body")
            text-id (-> text-res :body :id)
            _ (assert-created text-res)
            tok-res (create-token admin-request tkl text-id 0 64)
            tok-id (-> tok-res :body :id)
            _ (assert-created tok-res)]

        ;; Update to empty string - should delete all tokens
        (assert-ok (update-text admin-request text-id ""))

        (assert-not-found (get-token admin-request tok-id))

        (delete-text admin-request text-id)))))

(deftest text-update-cascade-effects
  (let [proj (create-test-project admin-request "CascadeUpdateProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        tkl-res (create-token-layer admin-request tl "TKL")
        tkl (-> tkl-res :body :id)
        _ (assert-created tkl-res)
        sl-res (create-span-layer admin-request tkl "SL")
        sl (-> sl-res :body :id)
        _ (assert-created sl-res)
        rl-res (create-relation-layer admin-request sl "RL")
        rl (-> rl-res :body :id)
        _ (assert-created rl-res)]

    (testing "Text update cascades to spans and relations"
      (let [text-res (create-text admin-request tl doc "The first word second word and third word in this long sentence with many additional words to ensure the diff algorithm works properly")
            text-id (-> text-res :body :id)
            _ (assert-created text-res)
            ;; Create tokens
            tok1-res (create-token admin-request tkl text-id 4 9) ; "first"
            tok1-id (-> tok1-res :body :id)
            _ (assert-created tok1-res)
            tok2-res (create-token admin-request tkl text-id 15 21) ; "second"
            tok2-id (-> tok2-res :body :id)
            _ (assert-created tok2-res)
            tok3-res (create-token admin-request tkl text-id 31 36) ; "third"
            tok3-id (-> tok3-res :body :id)
            _ (assert-created tok3-res)
            ;; Create spans
            span1-res (create-span admin-request sl [tok1-id] "S1")
            span1-id (-> span1-res :body :id)
            _ (assert-created span1-res)
            span2-res (create-span admin-request sl [tok2-id] "S2")
            span2-id (-> span2-res :body :id)
            _ (assert-created span2-res)
            span3-res (create-span admin-request sl [tok3-id] "S3")
            span3-id (-> span3-res :body :id)
            _ (assert-created span3-res)
            ;; Create relations
            rel-res (create-relation admin-request rl span1-id span2-id "R1")
            rel-id (-> rel-res :body :id)
            _ (assert-created rel-res)]

        ;; Delete "second word and " - should cascade delete tok2, span2, and relation
        (assert-ok (update-text admin-request text-id "The first word third word in this long sentence with many additional words to ensure the diff algorithm works properly"))

        ;; Check cascading deletions
        (assert-ok (get-token admin-request tok1-id)) ; still exists
        (assert-not-found (get-token admin-request tok2-id)) ; deleted
        (let [tok3-get (get-token admin-request tok3-id)]
          (assert-ok tok3-get) ; still exists but shifted
          (is (= 15 (-> tok3-get :body :token/begin))) ; shifted left
          (is (= 20 (-> tok3-get :body :token/end)))) ; shifted left

        (assert-ok (get-span admin-request span1-id)) ; still exists
        (assert-not-found (get-span admin-request span2-id)) ; deleted with token
        (assert-ok (get-span admin-request span3-id)) ; still exists

        (assert-not-found (get-relation admin-request rel-id)) ; deleted with span

        (delete-text admin-request text-id)))))

(deftest text-metadata-functionality
  (let [proj (create-test-project admin-request "TextMetadataProj")
        doc (create-test-document admin-request proj "TextDoc")
        tl-res (create-text-layer admin-request proj "TextTL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)]

    (testing "Create text with metadata"
      (let [metadata {"source" "corpus-v2" "language" "en" "annotated" true "quality" 0.95}
            text-res (create-text admin-request tl doc "Hello world" metadata)
            text-id (-> text-res :body :id)]
        (assert-created text-res)

        ;; Verify metadata is returned
        (let [retrieved (get-text admin-request text-id)]
          (assert-ok retrieved)
          (is (= "Hello world" (-> retrieved :body :text/body)))
          (is (= metadata (-> retrieved :body :metadata))))

        ;; Update metadata
        (let [new-metadata {"source" "corpus-v3" "reviewer" "human"}
              update-result (update-text-metadata admin-request text-id new-metadata)]
          (assert-ok update-result)
          (is (= new-metadata (-> update-result :body :metadata)))
          (is (= "Hello world" (-> update-result :body :text/body))))

        ;; Update text body (metadata should be preserved)
        (assert-ok (update-text admin-request text-id "Updated text"))
        (let [after-body-update (get-text admin-request text-id)]
          (assert-ok after-body-update)
          (is (= "Updated text" (-> after-body-update :body :text/body)))
          (is (= {"source" "corpus-v3" "reviewer" "human"} (-> after-body-update :body :metadata))))

        ;; Clear metadata
        (let [clear-result (delete-text-metadata admin-request text-id)]
          (assert-ok clear-result)
          (is (= "Updated text" (-> clear-result :body :text/body)))
          (is (nil? (-> clear-result :body :metadata))))

        (assert-no-content (delete-text admin-request text-id))))

    (testing "Text without metadata"
      (let [text-res (create-text admin-request tl doc "Simple text")
            text-id (-> text-res :body :id)]
        (assert-created text-res)
        (let [retrieved (get-text admin-request text-id)]
          (assert-ok retrieved)
          (is (= "Simple text" (-> retrieved :body :text/body)))
          (is (nil? (-> retrieved :body :metadata))))

        ;; Add metadata to existing text
        (let [metadata {"added-later" true}
              update-result (update-text-metadata admin-request text-id metadata)]
          (assert-ok update-result)
          (is (= metadata (-> update-result :body :metadata)))
          (is (= "Simple text" (-> update-result :body :text/body))))

        (assert-no-content (delete-text admin-request text-id))))))

(deftest text-access-control
  (let [proj (create-test-project admin-request "TextACProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "access control test")
        text-id (-> text-res :body :id)
        _ (assert-created text-res)]

    (testing "Non-member cannot access texts"
      (assert-forbidden (get-text user1-request text-id))
      (let [doc2 (create-test-document admin-request proj "Doc2")]
        (assert-forbidden (create-text user1-request tl doc2 "sneaky")))
      (assert-forbidden (update-text user1-request text-id "hacked"))
      (assert-forbidden (delete-text user1-request text-id)))

    (testing "Reader can GET but not write"
      (assert-no-content (add-project-reader admin-request proj "user1@example.com"))
      (assert-ok (get-text user1-request text-id))
      (let [doc3 (create-test-document admin-request proj "Doc3")]
        (assert-forbidden (create-text user1-request tl doc3 "sneaky")))
      (assert-forbidden (update-text user1-request text-id "hacked"))
      (assert-forbidden (delete-text user1-request text-id)))

    (testing "Writer can perform all CRUD"
      (assert-no-content (add-project-writer admin-request proj "user2@example.com"))
      (assert-ok (get-text user2-request text-id))
      (assert-ok (update-text user2-request text-id "writer updated"))
      (let [r (get-text user2-request text-id)]
        (assert-ok r)
        (is (= "writer updated" (-> r :body :text/body)))))))
