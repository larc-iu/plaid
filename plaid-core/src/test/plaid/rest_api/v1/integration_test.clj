(ns plaid.rest-api.v1.integration-test
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-xtdb
                                    with-mount-states with-rest-handler admin-request api-call
                                    assert-status assert-success assert-created assert-ok assert-no-content assert-not-found assert-bad-request
                                    with-admin with-test-users]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-xtdb with-mount-states with-rest-handler with-admin with-test-users)

(deftest cascade-deletion-behavior
  (let [proj (create-test-project admin-request "CascadeProj")
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
        _ (assert-created rl-res)
        relation-res (create-relation admin-request rl span1-id span2-id "R")
        relation-id (-> relation-res :body :id)
        _ (assert-created relation-res)]

    (testing "Deleting text cascades to delete tokens, spans, and relations"
      ;; Verify everything exists first
      (assert-ok (get-text admin-request text-id))
      (assert-ok (get-token admin-request token1-id))
      (assert-ok (get-token admin-request token2-id))
      (assert-ok (get-span admin-request span1-id))
      (assert-ok (get-span admin-request span2-id))
      (assert-ok (get-relation admin-request relation-id))

      ;; Delete the text
      (assert-no-content (delete-text admin-request text-id))

      ;; Verify everything is gone
      (assert-not-found (get-text admin-request text-id))
      (assert-not-found (get-token admin-request token1-id))
      (assert-not-found (get-token admin-request token2-id))
      (assert-not-found (get-span admin-request span1-id))
      (assert-not-found (get-span admin-request span2-id))
      (assert-not-found (get-relation admin-request relation-id)))))

(deftest edge-cases-and-boundary-conditions
  (let [proj (create-test-project admin-request "EdgeCaseProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)]

    (testing "Empty text body"
      (let [res (create-text admin-request tl doc "")]
        (assert-created res)
        (let [text-id (-> res :body :id)
              get-res (get-text admin-request text-id)]
          (assert-ok get-res)
          (is (= "" (-> get-res :body :text/body)))
          (delete-text admin-request text-id))))

    (testing "Unicode text content"
      (let [unicode-text "Hello 世界! 🌍 Émojis and ñoñó"
            res (create-text admin-request tl doc unicode-text)]
        (assert-created res)
        (let [text-id (-> res :body :id)
              get-res (get-text admin-request text-id)]
          (assert-ok get-res)
          (is (= unicode-text (-> get-res :body :text/body)))
          (delete-text admin-request text-id))))

    (testing "Large text content"
      (let [large-text (apply str (repeat 10000 "A"))
            res (create-text admin-request tl doc large-text)]
        (assert-created res)
        (let [text-id (-> res :body :id)
              get-res (get-text admin-request text-id)]
          (assert-ok get-res)
          (is (= large-text (-> get-res :body :text/body)))
          (delete-text admin-request text-id))))

    (testing "Whitespace-only text"
      (let [whitespace-text "   \n\t  \r\n   "
            res (create-text admin-request tl doc whitespace-text)]
        (assert-created res)
        (let [text-id (-> res :body :id)
              get-res (get-text admin-request text-id)]
          (assert-ok get-res)
          (is (= whitespace-text (-> get-res :body :text/body)))
          (delete-text admin-request text-id))))))

(deftest metadata-type-validation
  (let [proj (create-test-project admin-request "MetadataValidationProj")
        doc (create-test-document admin-request proj "ValidationDoc")
        tl-res (create-text-layer admin-request proj "ValidationTL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "test text")
        text-id (-> text-res :body :id)
        _ (assert-created text-res)
        tkl-res (create-token-layer admin-request tl "ValidationTKL")
        tkl (-> tkl-res :body :id)
        _ (assert-created tkl-res)
        token-res (create-token admin-request tkl text-id 0 4)
        token-id (-> token-res :body :id)
        _ (assert-created token-res)
        sl-res (create-span-layer admin-request tkl "ValidationSL")
        sl (-> sl-res :body :id)
        _ (assert-created sl-res)
        span-res (create-span admin-request sl [token-id] "test")
        span-id (-> span-res :body :id)
        _ (assert-created span-res)
        rl-res (create-relation-layer admin-request sl "ValidationRL")
        rl (-> rl-res :body :id)
        _ (assert-created rl-res)]

    (testing "Complex metadata values work for all entity types"
      (let [complex-metadata {"string" "value"
                              "number" 42
                              "float" 3.14
                              "boolean" true
                              "nested" {"inner" "value"}
                              "array" [1 2 3]
                              "mixed-array" ["string" 42 true nil]}]

        ;; Test text metadata (check each key-value pair)
        (let [update-result (update-text-metadata admin-request text-id complex-metadata)
              returned-metadata (-> update-result :body :metadata)]
          (assert-ok update-result)
          (is (= (count complex-metadata) (count returned-metadata)))
          (doseq [[k v] complex-metadata]
            (is (= v (get returned-metadata k)))))

        ;; Test token metadata
        (let [update-result (update-token-metadata admin-request token-id complex-metadata)
              returned-metadata (-> update-result :body :metadata)]
          (assert-ok update-result)
          (is (= (count complex-metadata) (count returned-metadata)))
          (doseq [[k v] complex-metadata]
            (is (= v (get returned-metadata k)))))

        ;; Test span metadata
        (let [update-result (update-span-metadata admin-request span-id complex-metadata)
              returned-metadata (-> update-result :body :metadata)]
          (assert-ok update-result)
          (is (= (count complex-metadata) (count returned-metadata)))
          (doseq [[k v] complex-metadata]
            (is (= v (get returned-metadata k)))))

        ;; Create relation for testing
        (let [span2-res (create-span admin-request sl [token-id] "test2")
              span2-id (-> span2-res :body :id)
              _ (assert-created span2-res)
              rel-res (create-relation admin-request rl span-id span2-id "rel" complex-metadata)
              rel-id (-> rel-res :body :id)]
          (assert-created rel-res)
          (let [retrieved (get-relation admin-request rel-id)
                returned-metadata (-> retrieved :body :metadata)]
            (assert-ok retrieved)
            (is (= (count complex-metadata) (count returned-metadata)))
            (doseq [[k v] complex-metadata]
              (is (= v (get returned-metadata k)))))
          (assert-no-content (delete-relation admin-request rel-id))
          (assert-no-content (delete-span admin-request span2-id)))))

    (testing "Empty metadata handling"
      (let [empty-metadata {}]
        (assert-ok (update-text-metadata admin-request text-id empty-metadata))
        (assert-ok (update-token-metadata admin-request token-id empty-metadata))
        (assert-ok (update-span-metadata admin-request span-id empty-metadata))

        ;; Empty metadata means no :metadata key should be present
        (is (nil? (-> (get-text admin-request text-id) :body :metadata)))
        (is (nil? (-> (get-token admin-request token-id) :body :metadata)))
        (is (nil? (-> (get-span admin-request span-id) :body :metadata)))))))
