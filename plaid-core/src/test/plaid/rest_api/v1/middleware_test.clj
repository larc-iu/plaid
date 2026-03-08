(ns plaid.rest-api.v1.middleware-test
  (:require [clojure.test :refer :all]
            [clojure.data.json :as json]
            [plaid.fixtures :refer [with-xtdb
                                    with-mount-states with-rest-handler admin-request api-call
                                    assert-status assert-created assert-ok assert-no-content
                                    with-admin with-test-users]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-xtdb with-mount-states with-rest-handler with-admin with-test-users)

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
  "Parse X-Document-Versions header from a response, returning {doc-id version-uuid}."
  [response]
  (when-let [h (get-in response [:headers "X-Document-Versions"])]
    (let [m (json/read-str h)]
      (into {} (map (fn [[k v]] [(java.util.UUID/fromString k) (java.util.UUID/fromString v)])) m))))

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
