(ns plaid.rest-api.v1.middleware-test
  (:require [clojure.test :refer :all]
            [clojure.data.json :as json]
            [plaid.fixtures :refer [with-db
                                    with-mount-states with-rest-handler admin-request api-call
                                    assert-status assert-created assert-ok assert-no-content
                                    with-admin with-test-users with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(deftest document-version-conflict-detection
  (let [proj (create-test-project admin-request "VersionConflictProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "original text")
        text-id (-> text-res :body :id)
        _ (assert-created text-res)]

    (testing "Write with current document-version succeeds"
      (let [doc-res (get-document admin-request doc)
            _ (assert-ok doc-res)
            version (-> doc-res :body :document/version)
            update-res (api-call admin-request {:method :patch
                                                :path (str "/api/v1/texts/" text-id "?document-version=" version)
                                                :body {:body "updated text"}})]
        (assert-ok update-res)))

    (testing "Write with stale document-version returns 409"
      (let [doc-res (get-document admin-request doc)
            _ (assert-ok doc-res)
            stale-version (-> doc-res :body :document/version)
            ;; Advance the version
            _ (assert-ok (update-text admin-request text-id "another update"))
            ;; Now try with stale version
            conflict-res (api-call admin-request {:method :patch
                                                  :path (str "/api/v1/texts/" text-id "?document-version=" stale-version)
                                                  :body {:body "should fail"}})]
        (assert-status 409 conflict-res)
        (is (some? (-> conflict-res :body :error)))))))

(deftest document-version-header-on-get
  (let [proj (create-test-project admin-request "VersionHeaderProj")
        doc (create-test-document admin-request proj "Doc")]

    (testing "GET document returns X-Document-Versions header"
      (let [res (get-document admin-request doc)]
        (assert-ok res)
        (is (some? (get-in res [:headers "X-Document-Versions"])))))))

(defn- parse-version-header
  "Parse X-Document-Versions header from a response, returning {doc-id version}.
  v2 used audit-id UUIDs as the version; the SQL port uses integer document
  versions, so we keep the value as a Long without further coercion."
  [response]
  (when-let [h (get-in response [:headers "X-Document-Versions"])]
    (let [m (json/read-str h)]
      (into {} (map (fn [[k v]] [(java.util.UUID/fromString k) v])) m))))

(deftest document-version-header-on-write-responses
  (let [proj (create-test-project admin-request "VersionWriteProj")
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
        tok1 (create-token admin-request tkl text-id 0 5)
        tok1-id (-> tok1 :body :id)
        _ (assert-created tok1)
        tok2 (create-token admin-request tkl text-id 6 11)
        tok2-id (-> tok2 :body :id)
        _ (assert-created tok2)
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
        _ (assert-created rl-res)]

    (testing "Relation create response includes X-Document-Versions header"
      (let [res (create-relation admin-request rl span1-id span2-id "dep")
            _ (assert-created res)
            versions (parse-version-header res)]
        (is (some? versions) "Response must include X-Document-Versions header")
        (is (contains? versions doc) "Version map must contain the affected document ID")))

    (testing "Span create response includes X-Document-Versions header"
      (let [res (create-span admin-request sl [tok1-id] "C")
            _ (assert-created res)
            versions (parse-version-header res)]
        (is (some? versions))
        (is (contains? versions doc))))

    (testing "Text update response includes X-Document-Versions header"
      (let [res (api-call admin-request {:method :patch
                                         :path (str "/api/v1/texts/" text-id)
                                         :body {:body "updated text"}})
            _ (assert-ok res)
            versions (parse-version-header res)]
        (is (some? versions))
        (is (contains? versions doc))))))

(deftest document-version-sequential-writes-with-version-tracking
  (let [proj (create-test-project admin-request "SeqWriteProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "abc def ghi")
        text-id (-> text-res :body :id)
        _ (assert-created text-res)
        tkl-res (create-token-layer admin-request tl "TKL")
        tkl (-> tkl-res :body :id)
        _ (assert-created tkl-res)
        tok1 (create-token admin-request tkl text-id 0 3)
        tok1-id (-> tok1 :body :id)
        tok2 (create-token admin-request tkl text-id 4 7)
        tok2-id (-> tok2 :body :id)
        tok3 (create-token admin-request tkl text-id 8 11)
        tok3-id (-> tok3 :body :id)
        sl-res (create-span-layer admin-request tkl "SL")
        sl (-> sl-res :body :id)
        _ (assert-created sl-res)
        s1 (-> (create-span admin-request sl [tok1-id] "A") :body :id)
        s2 (-> (create-span admin-request sl [tok2-id] "B") :body :id)
        s3 (-> (create-span admin-request sl [tok3-id] "C") :body :id)
        rl-res (create-relation-layer admin-request sl "RL")
        rl (-> rl-res :body :id)
        _ (assert-created rl-res)]

    (testing "Sequential writes using version from previous response succeed"
      ;; Get initial version
      (let [doc-res (get-document admin-request doc)
            _ (assert-ok doc-res)
            v0 (-> doc-res :body :document/version)

            ;; First write with v0
            r1 (api-call admin-request {:method :post
                                        :path (str "/api/v1/relations?document-version=" v0)
                                        :body {:layer-id rl :source-id s1 :target-id s2 :value "rel1"}})
            _ (assert-created r1)
            r1-id (-> r1 :body :id)
            v1 (get (parse-version-header r1) doc)]
        (is (some? v1) "First write must return updated version")
        (is (not= v0 v1) "Version must change after write")

        ;; Second write using v1 from the header — this is the exact scenario
        ;; that was failing (client sent stale v0 for second request → 409)
        (let [r2 (api-call admin-request {:method :post
                                          :path (str "/api/v1/relations?document-version=" v1)
                                          :body {:layer-id rl :source-id s2 :target-id s3 :value "rel2"}})
              _ (assert-created r2)
              v2 (get (parse-version-header r2) doc)]
          (is (some? v2) "Second write must return updated version")
          (is (not= v1 v2) "Version must change again after second write")

          ;; Third write using v2
          (let [r3 (api-call admin-request {:method :delete
                                            :path (str "/api/v1/relations/" r1-id "?document-version=" v2)})]
            (assert-no-content r3)
            (let [v3 (get (parse-version-header r3) doc)]
              (is (some? v3) "Delete must also return updated version")
              (is (not= v2 v3)))))))))

(deftest document-version-stale-after-write-without-header-update
  (let [proj (create-test-project admin-request "StaleVersionProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "foo bar")
        text-id (-> text-res :body :id)
        _ (assert-created text-res)
        tkl-res (create-token-layer admin-request tl "TKL")
        tkl (-> tkl-res :body :id)
        _ (assert-created tkl-res)
        tok1 (create-token admin-request tkl text-id 0 3)
        tok1-id (-> tok1 :body :id)
        tok2 (create-token admin-request tkl text-id 4 7)
        tok2-id (-> tok2 :body :id)
        sl-res (create-span-layer admin-request tkl "SL")
        sl (-> sl-res :body :id)
        _ (assert-created sl-res)
        s1 (-> (create-span admin-request sl [tok1-id] "A") :body :id)
        s2 (-> (create-span admin-request sl [tok2-id] "B") :body :id)
        rl-res (create-relation-layer admin-request sl "RL")
        rl (-> rl-res :body :id)
        _ (assert-created rl-res)]

    (testing "Reusing stale version after a write returns 409"
      (let [doc-res (get-document admin-request doc)
            v0 (-> doc-res :body :document/version)

            ;; First write succeeds, version advances
            r1 (api-call admin-request {:method :post
                                        :path (str "/api/v1/relations?document-version=" v0)
                                        :body {:layer-id rl :source-id s1 :target-id s2 :value "dep"}})
            _ (assert-created r1)]

        ;; Second write with the SAME (now stale) version must fail
        (let [r2 (api-call admin-request {:method :post
                                          :path (str "/api/v1/relations?document-version=" v0)
                                          :body {:layer-id rl :source-id s2 :target-id s1 :value "dep2"}})]
          (assert-status 409 r2))))))

(deftest document-version-rejects-v2-format-uuid
  ;; Old v2 clients used audit-id UUIDs for ?document-version=. The SQL
  ;; port uses integers; a UUID-shaped value must be rejected with a clear
  ;; 400 rather than silently bypassing OCC (the original v2-port bug).
  (let [proj (create-test-project admin-request "UuidVersionProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "hello")
        text-id (-> text-res :body :id)
        _ (assert-created text-res)
        bad-version "550e8400-e29b-41d4-a716-446655440000"]

    (testing "PATCH with UUID document-version returns 400 (not silently allowed)"
      (let [res (api-call admin-request {:method :patch
                                         :path (str "/api/v1/texts/" text-id
                                                    "?document-version=" bad-version)
                                         :body {:body "updated"}})]
        (assert-status 400 res)
        (let [err (-> res :body :error)]
          (is (some? err) "Response body must include an :error message")
          (is (string? err))
          (is (re-find #"(?i)v2|uuid|integer" (str err))
              "Error message must signal deprecation (mention v2/UUID/integer)"))))

    (testing "Uppercased-hex UUID is also rejected (regex is case-insensitive)"
      (let [res (api-call admin-request {:method :patch
                                         :path (str "/api/v1/texts/" text-id
                                                    "?document-version=550E8400-E29B-41D4-A716-446655440000")
                                         :body {:body "updated"}})]
        (assert-status 400 res)))))

(deftest atomic-batch-surfaces-merged-document-versions-header
  ;; Each sub-response sets X-Document-Versions on itself; previously those
  ;; headers were buried inside body[*].headers and clients never read them.
  ;; The atomic batch handler must now surface the merged map on the outer
  ;; response so clients can advance their OCC state.
  (let [proj (create-test-project admin-request "BatchVersionProj")
        doc1 (create-test-document admin-request proj "Doc1")
        doc2 (create-test-document admin-request proj "Doc2")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text1-res (create-text admin-request tl doc1 "doc1 text")
        text1-id (-> text1-res :body :id)
        _ (assert-created text1-res)
        text2-res (create-text admin-request tl doc2 "doc2 text")
        text2-id (-> text2-res :body :id)
        _ (assert-created text2-res)
        ;; Run two writes against two different documents in one batch.
        batch-res (api-call admin-request
                            {:method :post
                             :path "/api/v1/batch"
                             :body [{:path (str "/api/v1/texts/" text1-id)
                                     :method "patch"
                                     :body {:body "doc1 updated"}}
                                    {:path (str "/api/v1/texts/" text2-id)
                                     :method "patch"
                                     :body {:body "doc2 updated"}}]})]
    (assert-ok batch-res)
    (testing "Batch response carries merged X-Document-Versions header"
      (let [versions (parse-version-header batch-res)]
        (is (some? versions)
            "Outer batch response must include X-Document-Versions header")
        (is (contains? versions doc1) "Header must include doc1's id")
        (is (contains? versions doc2) "Header must include doc2's id")
        (is (every? integer? (vals versions))
            "Versions must be integer document.version values")))))

(deftest atomic-batch-document-versions-header-last-write-wins
  ;; When two sub-requests touch the same document, the merged outer
  ;; header should reflect the LATEST committed version (last-write-wins).
  (let [proj (create-test-project admin-request "BatchVersionLwwProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc "original")
        text-id (-> text-res :body :id)
        _ (assert-created text-res)
        ;; Two writes against the same doc — final outer version must
        ;; match the second sub-response (not the first).
        batch-res (api-call admin-request
                            {:method :post
                             :path "/api/v1/batch"
                             :body [{:path (str "/api/v1/texts/" text-id)
                                     :method "patch"
                                     :body {:body "first edit"}}
                                    {:path (str "/api/v1/texts/" text-id)
                                     :method "patch"
                                     :body {:body "second edit"}}]})]
    (assert-ok batch-res)
    (let [outer-versions (parse-version-header batch-res)
          ;; Fetch the current doc version directly so we know the truth.
          doc-res (get-document admin-request doc)
          live-version (-> doc-res :body :document/version)]
      (is (= live-version (get outer-versions doc))
          "Merged header must reflect the latest committed doc version"))))
