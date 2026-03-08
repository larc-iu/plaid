(ns plaid.rest-api.v1.relation-test
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-xtdb
                                    with-mount-states with-rest-handler admin-request api-call
                                    assert-status assert-success assert-created assert-ok assert-no-content assert-not-found assert-bad-request assert-forbidden
                                    with-admin with-test-users user1-request user2-request]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-xtdb with-mount-states with-rest-handler with-admin with-test-users)

(deftest relation-crud-and-invariants
  (let [proj (create-test-project admin-request "RelProj")
        doc (create-test-document admin-request proj "Doc4")
        tl-res (create-text-layer admin-request proj "TL4")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        tr (create-text admin-request tl doc "abcdef")
        tid (-> tr :body :id)
        _ (assert-created tr)
        tkl-res (create-token-layer admin-request tl "TokenL3")
        tkl (-> tkl-res :body :id)
        _ (assert-created tkl-res)
        id1 (-> (create-token admin-request tkl tid 0 2) :body :id)
        id2 (-> (create-token admin-request tkl tid 2 4) :body :id)
        sl-res (create-span-layer admin-request tkl "SL3")
        sl (-> sl-res :body :id)
        _ (assert-created sl-res)
        sid1 (-> (create-span admin-request sl [id1] "A") :body :id)
        sid2 (-> (create-span admin-request sl [id2] "B") :body :id)
        rl-res (create-relation-layer admin-request sl "RL3")
        rl (-> rl-res :body :id)
        _ (assert-created rl-res)
        ;; valid relation
        r1 (create-relation admin-request rl sid1 sid2 "R")
        rid (-> r1 :body :id)]
    (assert-created r1)
    ;; get, patch value, update source/target, delete
    (assert-ok (get-relation admin-request rid))
    (assert-ok (update-relation admin-request rid "X"))
    (assert-ok (update-relation-source admin-request rid sid2))
    (assert-ok (update-relation-target admin-request rid sid1))
    (assert-no-content (delete-relation admin-request rid))
    (assert-not-found (get-relation admin-request rid))))

(deftest relation-metadata-functionality
  (let [proj (create-test-project admin-request "RelMetadataProj")
        doc (create-test-document admin-request proj "RelDoc")
        tl-res (create-text-layer admin-request proj "RelTL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        tr (create-text admin-request tl doc "source target")
        tid (-> tr :body :id)
        _ (assert-created tr)
        tkl-res (create-token-layer admin-request tl "RelTokenL")
        tkl (-> tkl-res :body :id)
        _ (assert-created tkl-res)
        tk1 (create-token admin-request tkl tid 0 6) ; "source"
        id1 (-> tk1 :body :id)
        _ (assert-created tk1)
        tk2 (create-token admin-request tkl tid 7 13) ; "target"
        id2 (-> tk2 :body :id)
        _ (assert-created tk2)
        sl-res (create-span-layer admin-request tkl "RelSL")
        sl (-> sl-res :body :id)
        _ (assert-created sl-res)
        span1 (create-span admin-request sl [id1] "SOURCE")
        sid1 (-> span1 :body :id)
        _ (assert-created span1)
        span2 (create-span admin-request sl [id2] "TARGET")
        sid2 (-> span2 :body :id)
        _ (assert-created span2)
        rl-res (create-relation-layer admin-request sl "RelRL")
        rl (-> rl-res :body :id)
        _ (assert-created rl-res)]

    ;; Test creating relation with metadata
    (testing "Create relation with metadata"
      (let [metadata {"confidence" 0.92 "type" "semantic" "annotator" "model"}
            rel (create-relation admin-request rl sid1 sid2 "depends-on" metadata)
            rid (-> rel :body :id)]
        (assert-created rel)

        ;; Verify metadata is returned
        (let [retrieved (get-relation admin-request rid)]
          (assert-ok retrieved)
          (is (= "depends-on" (-> retrieved :body :relation/value)))
          (is (= sid1 (-> retrieved :body :relation/source)))
          (is (= sid2 (-> retrieved :body :relation/target)))
          (is (= metadata (-> retrieved :body :metadata))))

        ;; Update metadata
        (let [new-metadata {"confidence" 0.98 "reviewer" "human"}
              update-result (update-relation-metadata admin-request rid new-metadata)]
          (assert-ok update-result)
          (is (= new-metadata (-> update-result :body :metadata)))
          (is (= "depends-on" (-> update-result :body :relation/value))))

        ;; Update value only (metadata should be preserved)
        (assert-ok (update-relation admin-request rid "modified-depends-on"))
        (let [after-value-update (get-relation admin-request rid)]
          (assert-ok after-value-update)
          (is (= "modified-depends-on" (-> after-value-update :body :relation/value)))
          (is (= {"confidence" 0.98 "reviewer" "human"} (-> after-value-update :body :metadata))))

        ;; Clear metadata
        (let [clear-result (delete-relation-metadata admin-request rid)]
          (assert-ok clear-result)
          (is (= "modified-depends-on" (-> clear-result :body :relation/value)))
          (is (nil? (-> clear-result :body :metadata))))

        (assert-no-content (delete-relation admin-request rid))))

    ;; Test relation without metadata
    (testing "Relation without metadata"
      (let [rel (create-relation admin-request rl sid1 sid2 "simple-relation")
            rid (-> rel :body :id)]
        (assert-created rel)
        (let [retrieved (get-relation admin-request rid)]
          (assert-ok retrieved)
          (is (= "simple-relation" (-> retrieved :body :relation/value)))
          (is (nil? (-> retrieved :body :metadata))))

        ;; Add metadata to existing relation
        (let [metadata {"added-later" true}
              update-result (update-relation-metadata admin-request rid metadata)]
          (assert-ok update-result)
          (is (= metadata (-> update-result :body :metadata)))
          (is (= "simple-relation" (-> update-result :body :relation/value))))

        (assert-no-content (delete-relation admin-request rid))))))

(deftest relation-validation-rules
  (let [proj (create-test-project admin-request "RelationValidationProj")
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
        _ (assert-created sl-res)
        span1-res (create-span admin-request sl [token1-id] "A")
        span1-id (-> span1-res :body :id)
        _ (assert-created span1-res)
        span2-res (create-span admin-request sl [token2-id] "B")
        span2-id (-> span2-res :body :id)
        _ (assert-created span2-res)
        rl-res (create-relation-layer admin-request sl "RL")
        rl (-> rl-res :body :id)
        _ (assert-created rl-res)]

    (testing "Non-existent relation layer"
      (let [fake-rl (java.util.UUID/randomUUID)
            res (create-relation admin-request fake-rl span1-id span2-id "test")]
        (assert-bad-request res)))

    (testing "Non-existent source span"
      (let [fake-span (java.util.UUID/randomUUID)
            res (create-relation admin-request rl fake-span span2-id "test")]
        (assert-bad-request res)))

    (testing "Non-existent target span"
      (let [fake-span (java.util.UUID/randomUUID)
            res (create-relation admin-request rl span1-id fake-span "test")]
        (assert-bad-request res)))

    (testing "Source and target spans in different layers"
      (let [other-sl-res (create-span-layer admin-request tkl "OtherSL")
            other-sl (-> other-sl-res :body :id)
            _ (assert-created other-sl-res)
            other-span-res (create-span admin-request other-sl [token1-id] "C")
            other-span-id (-> other-span-res :body :id)
            _ (assert-created other-span-res)
            res (create-relation admin-request rl span1-id other-span-id "test")]
        (assert-bad-request res)))

    (testing "Relation layer not linked to span layer"
      (let [other-sl-res (create-span-layer admin-request tkl "UnlinkedSL")
            other-sl (-> other-sl-res :body :id)
            _ (assert-created other-sl-res)
            other-rl-res (create-relation-layer admin-request other-sl "OtherRL")
            other-rl (-> other-rl-res :body :id)
            _ (assert-created other-rl-res)
            res (create-relation admin-request other-rl span1-id span2-id "test")]
        (assert-bad-request res)))

    (testing "Source and target spans in different documents"
      (let [other-doc (create-test-document admin-request proj "OtherDoc")
            other-text-res (create-text admin-request tl other-doc "other text")
            other-text-id (-> other-text-res :body :id)
            _ (assert-created other-text-res)
            other-token-res (create-token admin-request tkl other-text-id 0 5)
            other-token-id (-> other-token-res :body :id)
            _ (assert-created other-token-res)
            other-span-res (create-span admin-request sl [other-token-id] "D")
            other-span-id (-> other-span-res :body :id)
            _ (assert-created other-span-res)
            res (create-relation admin-request rl span1-id other-span-id "test")]
        (assert-bad-request res)))

    (testing "Relation endpoint update validations"
      (let [relation-res (create-relation admin-request rl span1-id span2-id "test")
            relation-id (-> relation-res :body :id)
            _ (assert-created relation-res)]

        (testing "Update source to non-existent span"
          (let [fake-span (java.util.UUID/randomUUID)
                res (update-relation-source admin-request relation-id fake-span)]
            (assert-bad-request res)))

        (testing "Update target to non-existent span"
          (let [fake-span (java.util.UUID/randomUUID)
                res (update-relation-target admin-request relation-id fake-span)]
            (assert-bad-request res)))

        (testing "Update source to span in different layer"
          (let [other-sl-res (create-span-layer admin-request tkl "UpdateOtherSL")
                other-sl (-> other-sl-res :body :id)
                _ (assert-created other-sl-res)
                other-span-res (create-span admin-request other-sl [token1-id] "X")
                other-span-id (-> other-span-res :body :id)
                _ (assert-created other-span-res)
                res (update-relation-source admin-request relation-id other-span-id)]
            (assert-bad-request res)))

        (testing "Update target to span in different document"
          (let [other-doc (create-test-document admin-request proj "UpdateOtherDoc")
                other-text-res (create-text admin-request tl other-doc "other text")
                other-text-id (-> other-text-res :body :id)
                _ (assert-created other-text-res)
                other-token-res (create-token admin-request tkl other-text-id 0 5)
                other-token-id (-> other-token-res :body :id)
                _ (assert-created other-token-res)
                other-span-res (create-span admin-request sl [other-token-id] "E")
                other-span-id (-> other-span-res :body :id)
                _ (assert-created other-span-res)
                res (update-relation-target admin-request relation-id other-span-id)]
            (assert-bad-request res)))))))

(deftest bulk-relation-operations
  (let [proj (create-test-project admin-request "BulkRelProj")
        doc (create-test-document admin-request proj "Doc1")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "hello world test foo")
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
        tok3-res (create-token admin-request tkl text-id 12 16)
        tok3-id (-> tok3-res :body :id)
        _ (assert-created tok3-res)
        tok4-res (create-token admin-request tkl text-id 17 20)
        tok4-id (-> tok4-res :body :id)
        _ (assert-created tok4-res)
        sl-res (create-span-layer admin-request tkl "SL")
        sl (-> sl-res :body :id)
        _ (assert-created sl-res)
        span1-res (create-span admin-request sl [tok1-id] "A")
        span1-id (-> span1-res :body :id)
        _ (assert-created span1-res)
        span2-res (create-span admin-request sl [tok2-id] "B")
        span2-id (-> span2-res :body :id)
        _ (assert-created span2-res)
        span3-res (create-span admin-request sl [tok3-id] "C")
        span3-id (-> span3-res :body :id)
        _ (assert-created span3-res)
        span4-res (create-span admin-request sl [tok4-id] "D")
        span4-id (-> span4-res :body :id)
        _ (assert-created span4-res)
        rl-res (create-relation-layer admin-request sl "RL")
        rl (-> rl-res :body :id)
        _ (assert-created rl-res)]

    (testing "Bulk create relations - success case"
      (let [relations [{:relation-layer-id rl :source span1-id :target span2-id :value "R1"}
                       {:relation-layer-id rl :source span3-id :target span4-id :value "R2"}]
            res (bulk-create-relations admin-request relations)]
        (assert-created res)
        (is (= 2 (count (-> res :body :ids))))
        ;; Clean up
        (bulk-delete-relations admin-request (-> res :body :ids))))

    (testing "Bulk create relations with metadata"
      (let [relations [{:relation-layer-id rl :source span1-id :target span2-id :value "DEP" :metadata {"type" "syntactic"}}
                       {:relation-layer-id rl :source span3-id :target span4-id :value "REF" :metadata {"type" "semantic"}}]
            res (bulk-create-relations admin-request relations)]
        (assert-created res)
        (is (= 2 (count (-> res :body :ids))))
        ;; Verify metadata was set
        (let [rel-id (first (-> res :body :ids))
              rel-get (get-relation admin-request rel-id)]
          (assert-ok rel-get)
          (is (= {"type" "syntactic"} (-> rel-get :body :metadata))))
        ;; Clean up
        (bulk-delete-relations admin-request (-> res :body :ids))))

    (testing "Bulk create relations - non-existent source"
      (let [fake-span (java.util.UUID/randomUUID)
            relations [{:relation-layer-id rl :source fake-span :target span2-id :value "BAD"}]
            res (bulk-create-relations admin-request relations)]
        (assert-bad-request res)))

    (testing "Bulk create relations - non-existent target"
      (let [fake-span (java.util.UUID/randomUUID)
            relations [{:relation-layer-id rl :source span1-id :target fake-span :value "BAD"}]
            res (bulk-create-relations admin-request relations)]
        (assert-bad-request res)))

    (testing "Bulk create relations - source and target in different span layers"
      (let [other-sl-res (create-span-layer admin-request tkl "BulkOtherSL")
            other-sl (-> other-sl-res :body :id)
            _ (assert-created other-sl-res)
            other-span-res (create-span admin-request other-sl [tok1-id] "X")
            other-span-id (-> other-span-res :body :id)
            _ (assert-created other-span-res)
            relations [{:relation-layer-id rl :source span1-id :target other-span-id :value "BAD"}]
            res (bulk-create-relations admin-request relations)]
        (assert-bad-request res)))

    (testing "Bulk create relations - source and target in different documents"
      (let [doc2 (create-test-document admin-request proj "BulkDoc2")
            text2-res (create-text admin-request tl doc2 "other doc text")
            text2-id (-> text2-res :body :id)
            _ (assert-created text2-res)
            tok-other-res (create-token admin-request tkl text2-id 0 5)
            tok-other-id (-> tok-other-res :body :id)
            _ (assert-created tok-other-res)
            span-other-res (create-span admin-request sl [tok-other-id] "Y")
            span-other-id (-> span-other-res :body :id)
            _ (assert-created span-other-res)
            relations [{:relation-layer-id rl :source span1-id :target span-other-id :value "BAD"}]
            res (bulk-create-relations admin-request relations)]
        (assert-bad-request res)))

    (testing "Bulk delete relations - success case"
      (let [relations [{:relation-layer-id rl :source span1-id :target span2-id :value "D1"}
                       {:relation-layer-id rl :source span3-id :target span4-id :value "D2"}]
            create-res (bulk-create-relations admin-request relations)
            _ (assert-created create-res)
            rel-ids (-> create-res :body :ids)
            delete-res (bulk-delete-relations admin-request rel-ids)]
        (assert-no-content delete-res)
        ;; Verify relations are deleted
        (doseq [rel-id rel-ids]
          (assert-not-found (get-relation admin-request rel-id)))))))

(deftest relation-access-control
  (let [proj (create-test-project admin-request "RelACProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "source target")
        text-id (-> text-res :body :id)
        _ (assert-created text-res)
        tkl-res (create-token-layer admin-request tl "TKL")
        tkl (-> tkl-res :body :id)
        _ (assert-created tkl-res)
        tok1-res (create-token admin-request tkl text-id 0 6)
        tok1-id (-> tok1-res :body :id)
        _ (assert-created tok1-res)
        tok2-res (create-token admin-request tkl text-id 7 13)
        tok2-id (-> tok2-res :body :id)
        _ (assert-created tok2-res)
        sl-res (create-span-layer admin-request tkl "SL")
        sl (-> sl-res :body :id)
        _ (assert-created sl-res)
        span1-res (create-span admin-request sl [tok1-id] "A")
        span1-id (-> span1-res :body :id)
        _ (assert-created span1-res)
        span2-res (create-span admin-request sl [tok2-id] "B")
        span2-id (-> span2-res :body :id)
        _ (assert-created span2-res)
        rl-res (create-relation-layer admin-request sl "RL")
        rl (-> rl-res :body :id)
        _ (assert-created rl-res)
        rel-res (create-relation admin-request rl span1-id span2-id "R")
        rel-id (-> rel-res :body :id)
        _ (assert-created rel-res)]

    (testing "Non-member cannot access relations"
      (assert-forbidden (get-relation user1-request rel-id))
      (assert-forbidden (create-relation user1-request rl span1-id span2-id "X"))
      (assert-forbidden (update-relation user1-request rel-id "Y"))
      (assert-forbidden (delete-relation user1-request rel-id)))

    (testing "Reader can GET but not write"
      (assert-no-content (add-project-reader admin-request proj "user1@example.com"))
      (assert-ok (get-relation user1-request rel-id))
      (assert-forbidden (create-relation user1-request rl span1-id span2-id "X"))
      (assert-forbidden (update-relation user1-request rel-id "Y"))
      (assert-forbidden (delete-relation user1-request rel-id)))

    (testing "Writer can perform all CRUD"
      (assert-no-content (add-project-writer admin-request proj "user2@example.com"))
      (assert-ok (get-relation user2-request rel-id))
      (let [new-rel (create-relation user2-request rl span1-id span2-id "W")
            new-id (-> new-rel :body :id)]
        (assert-created new-rel)
        (assert-ok (update-relation user2-request new-id "X"))
        (assert-no-content (delete-relation user2-request new-id))))))
