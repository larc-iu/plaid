(ns plaid.rest-api.v1.data-test
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-xtdb with-rest-handler admin-request api-call
                                    assert-status assert-success assert-created assert-ok assert-no-content assert-not-found assert-bad-request
                                    with-admin with-test-users]]
            [ring.mock.request :as mock]))

(use-fixtures :once with-xtdb with-rest-handler with-admin with-test-users)

;; Helper to create a project for tests
(defn- create-test-project [user-request-fn project-name]
  (let [response (api-call user-request-fn {:method :post
                                            :path   "/api/v1/projects"
                                            :body   {:name project-name}})]
    (assert-created response)
    (-> response :body :id)))

(defn- delete-test-project [user-request-fn project-id]
  (api-call user-request-fn {:method :delete :path (str "/api/v1/projects/" project-id)}))

;; Helper to create a document for tests
(defn- create-test-document [user-request-fn project-id doc-name]
  (let [response (api-call user-request-fn {:method :post
                                            :path   "/api/v1/documents"
                                            :body   {:project-id project-id :name doc-name}})]
    (assert-created response)
    (-> response :body :id)))

;; Helper functions for layer creation
(defn- create-text-layer [user-request-fn project-id name]
  (api-call user-request-fn {:method :post
                             :path   "/api/v1/text-layers"
                             :body   {:project-id project-id :name name}}))

(defn- create-token-layer [user-request-fn text-layer-id name]
  (api-call user-request-fn {:method :post
                             :path   "/api/v1/token-layers"
                             :body   {:text-layer-id text-layer-id :name name}}))

(defn- create-span-layer [user-request-fn token-layer-id name]
  (api-call user-request-fn {:method :post
                             :path   "/api/v1/span-layers"
                             :body   {:token-layer-id token-layer-id :name name}}))

(defn- create-relation-layer [user-request-fn span-layer-id name]
  (api-call user-request-fn {:method :post
                             :path   "/api/v1/relation-layers"
                             :body   {:span-layer-id span-layer-id :name name}}))

;; Text API Helper Functions
(defn- create-text [user-request-fn text-layer-id document-id body]
  (api-call user-request-fn {:method :post
                             :path   "/api/v1/texts"
                             :body   {:text-layer-id text-layer-id
                                      :document-id   document-id
                                      :body          body}}))

(defn- get-text [user-request-fn text-id]
  (api-call user-request-fn {:method :get
                             :path   (str "/api/v1/texts/" text-id)}))

(defn- update-text [user-request-fn text-id new-body]
  (api-call user-request-fn {:method :patch
                             :path   (str "/api/v1/texts/" text-id)
                             :body   {:body new-body}}))

(defn- delete-text [user-request-fn text-id]
  (api-call user-request-fn {:method :delete
                             :path   (str "/api/v1/texts/" text-id)}))

;; Token API Helper Functions
(defn- create-token [user-request-fn token-layer-id text-id begin end & [precedence]]
  (api-call user-request-fn {:method :post
                             :path   "/api/v1/tokens"
                             :body   (cond-> {:token-layer-id token-layer-id
                                              :text-id        text-id
                                              :begin          begin
                                              :end            end}
                                             precedence (assoc :precedence precedence))}))

(defn- get-token [user-request-fn token-id]
  (api-call user-request-fn {:method :get
                             :path   (str "/api/v1/tokens/" token-id)}))

(defn- update-token [user-request-fn token-id & {:keys [begin end precedence]}]
  (api-call user-request-fn {:method :patch
                             :path   (str "/api/v1/tokens/" token-id)
                             :body   (cond-> {}
                                             begin (assoc :begin begin)
                                             end (assoc :end end)
                                             precedence (assoc :precedence precedence))}))

(defn- delete-token [user-request-fn token-id]
  (api-call user-request-fn {:method :delete
                             :path   (str "/api/v1/tokens/" token-id)}))

;; Span API Helper Functions
(defn- create-span
  ([user-request-fn span-layer-id tokens value]
   (api-call user-request-fn {:method :post
                              :path   "/api/v1/spans"
                              :body   {:span-layer-id span-layer-id
                                       :tokens        tokens
                                       :value         value}}))
  ([user-request-fn span-layer-id tokens value metadata]
   (api-call user-request-fn {:method :post
                              :path   "/api/v1/spans"
                              :body   {:span-layer-id span-layer-id
                                       :tokens        tokens
                                       :value         value
                                       :metadata      metadata}})))

(defn- get-span [user-request-fn span-id]
  (api-call user-request-fn {:method :get
                             :path   (str "/api/v1/spans/" span-id)}))

(defn- update-span [user-request-fn span-id & {:keys [value]}]
  (api-call user-request-fn {:method :patch
                             :path   (str "/api/v1/spans/" span-id)
                             :body   {:value value}}))

(defn- update-span-metadata [user-request-fn span-id metadata]
  (api-call user-request-fn {:method :put
                             :path   (str "/api/v1/spans/" span-id "/metadata")
                             :body   metadata}))

(defn- delete-span-metadata [user-request-fn span-id]
  (api-call user-request-fn {:method :delete
                             :path   (str "/api/v1/spans/" span-id "/metadata")}))

(defn- update-span-tokens [user-request-fn span-id tokens]
  (api-call user-request-fn {:method :put
                             :path   (str "/api/v1/spans/" span-id "/tokens")
                             :body   {:tokens tokens}}))

(defn- delete-span [user-request-fn span-id]
  (api-call user-request-fn {:method :delete
                             :path   (str "/api/v1/spans/" span-id)}))

;; Relation API Helper Functions
(defn- create-relation [user-request-fn layer-id source-id target-id value]
  (api-call user-request-fn {:method :post
                             :path   "/api/v1/relations"
                             :body   {:layer-id  layer-id
                                      :source-id source-id
                                      :target-id target-id
                                      :value     value}}))

(defn- get-relation [user-request-fn relation-id]
  (api-call user-request-fn {:method :get
                             :path   (str "/api/v1/relations/" relation-id)}))

(defn- update-relation [user-request-fn relation-id value]
  (api-call user-request-fn {:method :patch
                             :path   (str "/api/v1/relations/" relation-id)
                             :body   {:value value}}))

(defn- update-relation-source [user-request-fn relation-id span-id]
  (api-call user-request-fn {:method :put
                             :path   (str "/api/v1/relations/" relation-id "/source")
                             :body   {:span-id span-id}}))

(defn- update-relation-target [user-request-fn relation-id span-id]
  (api-call user-request-fn {:method :put
                             :path   (str "/api/v1/relations/" relation-id "/target")
                             :body   {:span-id span-id}}))

(defn- delete-relation [user-request-fn relation-id]
  (api-call user-request-fn {:method :delete
                             :path   (str "/api/v1/relations/" relation-id)}))

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
          (is (= final-metadata (-> r5 :body :metadata))))))))

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

;; Additional comprehensive validation tests
(deftest text-validation-rules
  (let [proj (create-test-project admin-request "TextValidationProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)]

    (testing "Non-string body validation - coercion catches this at middleware level"
      ;; Note: The coercion middleware catches non-string bodies before our validation,
      ;; so this test verifies the middleware layer works correctly
      (is (thrown? clojure.lang.ExceptionInfo
                   (api-call admin-request {:method :post
                                            :path "/api/v1/texts"
                                            :body {:text-layer-id tl
                                                   :document-id doc
                                                   :body 123}}))))

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
        (assert-status 409 res2)))

    (testing "Update text body with non-string - coercion catches this at middleware level"
      (let [update-doc (create-test-document admin-request proj "UpdateDoc")
            text-res (create-text admin-request tl update-doc "original")
            text-id (-> text-res :body :id)
            _ (assert-created text-res)]
        (is (thrown? clojure.lang.ExceptionInfo
                     (api-call admin-request {:method :patch
                                              :path (str "/api/v1/texts/" text-id)
                                              :body {:body 456}})))))))

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
      (is (thrown? clojure.lang.ExceptionInfo
                   (api-call admin-request {:method :post
                                            :path "/api/v1/tokens"
                                            :body {:token-layer-id tkl
                                                   :text-id text-id
                                                   :begin "0"
                                                   :end "5"}}))))

    (testing "Negative begin index"
      (let [res (create-token admin-request tkl text-id -1 5)]
        (assert-bad-request res)))

    (testing "Token end beyond text bounds"
      (let [res (create-token admin-request tkl text-id 0 100)]
        ;; This validation happens at database level and returns 500
        (assert-status 500 res)))

    (testing "Non-integer precedence - coercion catches this at middleware level"
      (is (thrown? clojure.lang.ExceptionInfo
                   (api-call admin-request {:method :post
                                            :path "/api/v1/tokens"
                                            :body {:token-layer-id tkl
                                                   :text-id text-id
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
            (assert-bad-request res)))))))

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
            tok1-res (create-token admin-request tkl text-id 0 5)  ; "Hello"
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
            tok1-res (create-token admin-request tkl text-id 0 0)   ; zero-width at start
            tok1-id (-> tok1-res :body :id)
            _ (assert-created tok1-res)
            tok2-res (create-token admin-request tkl text-id 10 10)   ; zero-width at position 10 (after "quick ")
            tok2-id (-> tok2-res :body :id)
            _ (assert-created tok2-res)
            tok3-res (create-token admin-request tkl text-id 63 63)   ; zero-width at end
            tok3-id (-> tok3-res :body :id)
            _ (assert-created tok3-res)]
        
        ;; Delete "brown " (positions 10-16) - should delete tok2
        (assert-ok (update-text admin-request text-id "The quick fox jumped over the lazy dog and then some more"))
        
        ;; Check tokens
        (assert-ok (get-token admin-request tok1-id))        ; still exists at position 0
        (assert-not-found (get-token admin-request tok2-id)) ; deleted
        (let [tok3-get (get-token admin-request tok3-id)]
          (assert-ok tok3-get)
          (is (= 57 (-> tok3-get :body :token/begin)))  ; shifted left by 6
          (is (= 57 (-> tok3-get :body :token/end))))   ; still zero-width
        
        (delete-text admin-request text-id)))

    (testing "Update text - token deletion due to complete overlap"
      (let [text-res (create-text admin-request tl doc "The quick brown fox jumped over the lazy dog and then some more")
            text-id (-> text-res :body :id)
            _ (assert-created text-res)
            tok1-res (create-token admin-request tkl text-id 0 3)   ; "The"
            tok1-id (-> tok1-res :body :id)
            _ (assert-created tok1-res)
            tok2-res (create-token admin-request tkl text-id 4 9)   ; "quick"
            tok2-id (-> tok2-res :body :id)
            _ (assert-created tok2-res)
            tok3-res (create-token admin-request tkl text-id 10 15) ; "brown"
            tok3-id (-> tok3-res :body :id)
            _ (assert-created tok3-res)]
        
        ;; Delete "quick brown " - should delete tok2 and tok3
        (assert-ok (update-text admin-request text-id "The fox jumped over the lazy dog and then some more"))
        
        ;; Check tokens
        (assert-ok (get-token admin-request tok1-id))         ; still exists
        (assert-not-found (get-token admin-request tok2-id))  ; deleted
        (assert-not-found (get-token admin-request tok3-id))  ; deleted
        
        (delete-text admin-request text-id)))

    (testing "Update text - partial token overlap"
      (let [text-res (create-text admin-request tl doc "The overlapping words in this sentence are interesting to analyze")
            text-id (-> text-res :body :id)
            _ (assert-created text-res)
            tok1-res (create-token admin-request tkl text-id 4 11)   ; "overlap" (positions 4-11)
            tok1-id (-> tok1-res :body :id)
            _ (assert-created tok1-res)
            tok2-res (create-token admin-request tkl text-id 8 15)  ; "lapping" (positions 8-15)
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
          (is (= 9 (-> tok1-get :body :token/end)))    ; shrunk to "overp"
          (is (= 8 (-> tok2-get :body :token/begin)))  ; starts where deletion happened
          (is (= 12 (-> tok2-get :body :token/end))))  ; adjusted for deletion: "ping"
        
        (delete-text admin-request text-id)))

    (testing "Update text - insertion within token"
      (let [text-res (create-text admin-request tl doc "The hello world example is simple but effective for testing")
            text-id (-> text-res :body :id)
            _ (assert-created text-res)
            tok-res (create-token admin-request tkl text-id 4 9)  ; "hello"
            tok-id (-> tok-res :body :id)
            _ (assert-created tok-res)]
        
        ;; Insert "XXX" in the middle of "hello"
        (assert-ok (update-text admin-request text-id "The heXXXllo world example is simple but effective for testing"))
        
        ;; Check token expansion
        (let [tok-get (get-token admin-request tok-id)]
          (assert-ok tok-get)
          (is (= 4 (-> tok-get :body :token/begin)))
          (is (= 12 (-> tok-get :body :token/end))))  ; expanded to include insertion
        
        (delete-text admin-request text-id)))

    (testing "Update text - complex multi-token scenario"
      (let [text-res (create-text admin-request tl doc "AABBCCDDEE followed by more text to ensure proper diff behavior")
            text-id (-> text-res :body :id)
            _ (assert-created text-res)
            ;; Create tokens for each pair
            tok1-res (create-token admin-request tkl text-id 0 2)   ; "AA"
            tok1-id (-> tok1-res :body :id)
            _ (assert-created tok1-res)
            tok2-res (create-token admin-request tkl text-id 2 4)   ; "BB"
            tok2-id (-> tok2-res :body :id)
            _ (assert-created tok2-res)
            tok3-res (create-token admin-request tkl text-id 4 6)   ; "CC"
            tok3-id (-> tok3-res :body :id)
            _ (assert-created tok3-res)
            tok4-res (create-token admin-request tkl text-id 6 8)   ; "DD"
            tok4-id (-> tok4-res :body :id)
            _ (assert-created tok4-res)
            tok5-res (create-token admin-request tkl text-id 8 10)  ; "EE"
            tok5-id (-> tok5-res :body :id)
            _ (assert-created tok5-res)
            ;; Add a zero-width token in the middle
            tok6-res (create-token admin-request tkl text-id 5 5)   ; zero-width between CC
            tok6-id (-> tok6-res :body :id)
            _ (assert-created tok6-res)]
        
        ;; Replace "BBCCDD" with "X" - should affect multiple tokens
        (assert-ok (update-text admin-request text-id "AAXEE followed by more text to ensure proper diff behavior"))
        
        ;; Check results
        (assert-ok (get-token admin-request tok1-id))         ; "AA" unaffected
        (assert-not-found (get-token admin-request tok2-id))  ; deleted
        (assert-not-found (get-token admin-request tok3-id))  ; deleted
        (assert-not-found (get-token admin-request tok4-id))  ; deleted
        (assert-not-found (get-token admin-request tok6-id))  ; zero-width deleted
        
        (let [tok5-get (get-token admin-request tok5-id)]
          (assert-ok tok5-get)
          (is (= 3 (-> tok5-get :body :token/begin)))  ; shifted left significantly
          (is (= 5 (-> tok5-get :body :token/end))))   ; still "EE"
        
        (delete-text admin-request text-id)))

    (testing "Update text - token at deletion boundary"
      (let [text-res (create-text admin-request tl doc "The boundary test example shows how tokens behave at deletion boundaries")
            text-id (-> text-res :body :id)
            _ (assert-created text-res)
            tok1-res (create-token admin-request tkl text-id 4 12)   ; "boundary"
            tok1-id (-> tok1-res :body :id)
            _ (assert-created tok1-res)
            tok2-res (create-token admin-request tkl text-id 13 17)  ; "test"
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
          (is (= 12 (-> tok1-get :body :token/end)))    ; unchanged
          (is (= 12 (-> tok2-get :body :token/begin)))  ; shifted to touch tok1
          (is (= 16 (-> tok2-get :body :token/end))))   ; shifted left by 1
        
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
            tok1-res (create-token admin-request tkl text-id 4 9)   ; "first"
            tok1-id (-> tok1-res :body :id)
            _ (assert-created tok1-res)
            tok2-res (create-token admin-request tkl text-id 15 21)  ; "second"
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
        (assert-ok (get-token admin-request tok1-id))         ; still exists
        (assert-not-found (get-token admin-request tok2-id))  ; deleted
        (let [tok3-get (get-token admin-request tok3-id)]
          (assert-ok tok3-get)                               ; still exists but shifted
          (is (= 15 (-> tok3-get :body :token/begin)))       ; shifted left
          (is (= 20 (-> tok3-get :body :token/end))))        ; shifted left
        
        (assert-ok (get-span admin-request span1-id))         ; still exists
        (assert-not-found (get-span admin-request span2-id))  ; deleted with token
        (assert-ok (get-span admin-request span3-id))         ; still exists
        
        (assert-not-found (get-relation admin-request rel-id)) ; deleted with span
        
        (delete-text admin-request text-id)))))
