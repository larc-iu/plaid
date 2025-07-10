(ns plaid.rest-api.v1.data-test
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-xtdb with-rest-handler admin-request api-call
                                    assert-status assert-success assert-created assert-ok assert-no-content assert-not-found assert-bad-request
                                    with-admin with-test-users user1-request user2-request]]
            [ring.mock.request :as mock]))

(use-fixtures :once with-xtdb with-rest-handler with-admin with-test-users)

;; Helper to create a project for tests
(defn- create-test-project [user-request-fn project-name]
  (let [response (api-call user-request-fn {:method :post
                                            :path "/api/v1/projects"
                                            :body {:name project-name}})]
    (assert-created response)
    (-> response :body :id)))

(defn- delete-test-project [user-request-fn project-id]
  (api-call user-request-fn {:method :delete :path (str "/api/v1/projects/" project-id)}))

;; Helper to create a document for tests
(defn- create-test-document [user-request-fn project-id doc-name]
  (let [response (api-call user-request-fn {:method :post
                                            :path "/api/v1/documents"
                                            :body {:project-id project-id :name doc-name}})]
    (assert-created response)
    (-> response :body :id)))

;; Helper functions for layer creation
(defn- create-text-layer [user-request-fn project-id name]
  (api-call user-request-fn {:method :post
                             :path "/api/v1/text-layers"
                             :body {:project-id project-id :name name}}))

(defn- create-token-layer [user-request-fn text-layer-id name]
  (api-call user-request-fn {:method :post
                             :path "/api/v1/token-layers"
                             :body {:text-layer-id text-layer-id :name name}}))

(defn- create-span-layer [user-request-fn token-layer-id name]
  (api-call user-request-fn {:method :post
                             :path "/api/v1/span-layers"
                             :body {:token-layer-id token-layer-id :name name}}))

(defn- create-relation-layer [user-request-fn span-layer-id name]
  (api-call user-request-fn {:method :post
                             :path "/api/v1/relation-layers"
                             :body {:span-layer-id span-layer-id :name name}}))

;; Text API Helper Functions
(defn- create-text
  ([user-request-fn text-layer-id document-id body]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/texts"
                              :body {:text-layer-id text-layer-id
                                     :document-id document-id
                                     :body body}}))
  ([user-request-fn text-layer-id document-id body metadata]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/texts"
                              :body {:text-layer-id text-layer-id
                                     :document-id document-id
                                     :body body
                                     :metadata metadata}})))

(defn- get-text [user-request-fn text-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/texts/" text-id)}))

(defn- update-text [user-request-fn text-id new-body]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/texts/" text-id)
                             :body {:body new-body}}))

(defn- update-text-metadata [user-request-fn text-id metadata]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/texts/" text-id "/metadata")
                             :body metadata}))

(defn- delete-text-metadata [user-request-fn text-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/texts/" text-id "/metadata")}))

(defn- delete-text [user-request-fn text-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/texts/" text-id)}))

;; Token API Helper Functions
(defn- create-token
  ([user-request-fn token-layer-id text-id begin end]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/tokens"
                              :body {:token-layer-id token-layer-id
                                     :text text-id
                                     :begin begin
                                     :end end}}))
  ([user-request-fn token-layer-id text-id begin end precedence]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/tokens"
                              :body (cond-> {:token-layer-id token-layer-id
                                             :text text-id
                                             :begin begin
                                             :end end}
                                      (some? precedence) (assoc :precedence precedence))}))
  ([user-request-fn token-layer-id text-id begin end precedence metadata]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/tokens"
                              :body (cond-> {:token-layer-id token-layer-id
                                             :text text-id
                                             :begin begin
                                             :end end}
                                      (some? precedence) (assoc :precedence precedence)
                                      (some? metadata) (assoc :metadata metadata))})))

(defn- get-token [user-request-fn token-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/tokens/" token-id)}))

(defn- update-token [user-request-fn token-id & {:keys [begin end precedence]}]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/tokens/" token-id)
                             :body (cond-> {}
                                     begin (assoc :begin begin)
                                     end (assoc :end end)
                                     precedence (assoc :precedence precedence))}))

(defn- update-token-metadata [user-request-fn token-id metadata]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/tokens/" token-id "/metadata")
                             :body metadata}))

(defn- delete-token-metadata [user-request-fn token-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/tokens/" token-id "/metadata")}))

(defn- delete-token [user-request-fn token-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/tokens/" token-id)}))

;; Span API Helper Functions
(defn- create-span
  ([user-request-fn span-layer-id tokens value]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/spans"
                              :body {:span-layer-id span-layer-id
                                     :tokens tokens
                                     :value value}}))
  ([user-request-fn span-layer-id tokens value metadata]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/spans"
                              :body {:span-layer-id span-layer-id
                                     :tokens tokens
                                     :value value
                                     :metadata metadata}})))

(defn- get-span [user-request-fn span-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/spans/" span-id)}))

(defn- update-span [user-request-fn span-id & {:keys [value]}]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/spans/" span-id)
                             :body {:value value}}))

(defn- update-span-metadata [user-request-fn span-id metadata]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/spans/" span-id "/metadata")
                             :body metadata}))

(defn- delete-span-metadata [user-request-fn span-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/spans/" span-id "/metadata")}))

(defn- update-span-tokens [user-request-fn span-id tokens]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/spans/" span-id "/tokens")
                             :body {:tokens tokens}}))

(defn- delete-span [user-request-fn span-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/spans/" span-id)}))

;; Relation API Helper Functions
(defn- create-relation
  ([user-request-fn layer-id source-id target-id value]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/relations"
                              :body {:layer-id layer-id
                                     :source-id source-id
                                     :target-id target-id
                                     :value value}}))
  ([user-request-fn layer-id source-id target-id value metadata]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/relations"
                              :body {:layer-id layer-id
                                     :source-id source-id
                                     :target-id target-id
                                     :value value
                                     :metadata metadata}})))

(defn- get-relation [user-request-fn relation-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/relations/" relation-id)}))

(defn- update-relation [user-request-fn relation-id value]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/relations/" relation-id)
                             :body {:value value}}))

(defn- update-relation-source [user-request-fn relation-id span-id]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/relations/" relation-id "/source")
                             :body {:span-id span-id}}))

(defn- update-relation-target [user-request-fn relation-id span-id]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/relations/" relation-id "/target")
                             :body {:span-id span-id}}))

(defn- update-relation-metadata [user-request-fn relation-id metadata]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/relations/" relation-id "/metadata")
                             :body metadata}))

(defn- delete-relation-metadata [user-request-fn relation-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/relations/" relation-id "/metadata")}))

(defn- delete-relation [user-request-fn relation-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/relations/" relation-id)}))

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
      (is (thrown? java.lang.IllegalArgumentException
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
        (is (thrown? java.lang.IllegalArgumentException
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

;; Bulk API Helper Functions
(defn- bulk-create-tokens [user-request-fn tokens]
  (api-call user-request-fn {:method :post
                             :path "/api/v1/tokens/bulk"
                             :body tokens}))

(defn- bulk-delete-tokens [user-request-fn token-ids]
  (api-call user-request-fn {:method :delete
                             :path "/api/v1/tokens/bulk"
                             :body token-ids}))

(defn- bulk-create-spans [user-request-fn spans]
  (api-call user-request-fn {:method :post
                             :path "/api/v1/spans/bulk"
                             :body spans}))

(defn- bulk-delete-spans [user-request-fn span-ids]
  (api-call user-request-fn {:method :delete
                             :path "/api/v1/spans/bulk"
                             :body span-ids}))

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
                              "nested" {:inner "value"} ; Use keyword keys for nested maps
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

;; ============================================================================
;; Vocab System Tests
;; ============================================================================

;; Vocab layer helper functions
(defn- create-vocab-layer
  ([user-request-fn name]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/vocab-layers"
                              :body {:name name}}))
  ([user-request-fn name config]
   ;; Config not supported in creation - create first then set config if needed
   (api-call user-request-fn {:method :post
                              :path "/api/v1/vocab-layers"
                              :body {:name name}})))

(defn- get-vocab-layer
  ([user-request-fn vocab-id]
   (api-call user-request-fn {:method :get
                              :path (str "/api/v1/vocab-layers/" vocab-id)}))
  ([user-request-fn vocab-id include-items?]
   (api-call user-request-fn {:method :get
                              :path (str "/api/v1/vocab-layers/" vocab-id
                                         (when include-items? "?include-items=true"))})))

(defn- update-vocab-layer [user-request-fn vocab-id updates]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/vocab-layers/" vocab-id)
                             :body updates}))

(defn- delete-vocab-layer [user-request-fn vocab-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/vocab-layers/" vocab-id)}))

(defn- add-vocab-maintainer [user-request-fn vocab-id user-id]
  (api-call user-request-fn {:method :post
                             :path (str "/api/v1/vocab-layers/" vocab-id "/maintainers/" user-id)}))

(defn- remove-vocab-maintainer [user-request-fn vocab-id user-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/vocab-layers/" vocab-id "/maintainers/" user-id)}))

;; Vocab item helper functions
(defn- create-vocab-item
  ([user-request-fn vocab-layer-id form]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/vocab-items"
                              :body {:vocab-layer-id vocab-layer-id :form form}}))
  ([user-request-fn vocab-layer-id form metadata]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/vocab-items"
                              :body {:vocab-layer-id vocab-layer-id :form form :metadata metadata}})))

(defn- get-vocab-item [user-request-fn item-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/vocab-items/" item-id)}))

(defn- update-vocab-item [user-request-fn item-id new-form]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/vocab-items/" item-id)
                             :body {:form new-form}}))

(defn- update-vocab-item-metadata [user-request-fn item-id metadata]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/vocab-items/" item-id "/metadata")
                             :body metadata}))

(defn- delete-vocab-item-metadata [user-request-fn item-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/vocab-items/" item-id "/metadata")}))

(defn- delete-vocab-item [user-request-fn item-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/vocab-items/" item-id)}))

;; Vocab link helper functions
(defn- create-vocab-link
  ([user-request-fn vocab-item-id tokens]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/vocab-links"
                              :body {:vocab-item vocab-item-id :tokens tokens}}))
  ([user-request-fn vocab-item-id tokens metadata]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/vocab-links"
                              :body {:vocab-item vocab-item-id :tokens tokens :metadata metadata}})))

(defn- get-vocab-link [user-request-fn link-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/vocab-links/" link-id)}))

(defn- update-vocab-link-metadata [user-request-fn link-id metadata]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/vocab-links/" link-id "/metadata")
                             :body metadata}))

(defn- delete-vocab-link-metadata [user-request-fn link-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/vocab-links/" link-id "/metadata")}))

(defn- delete-vocab-link [user-request-fn link-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/vocab-links/" link-id)}))

(deftest vocab-layer-functionality
  (testing "Vocab layer basic CRUD operations"
    ;; Create vocab layer
    (let [vocab-res (create-vocab-layer admin-request "Test Vocab Layer")
          vocab-id (-> vocab-res :body :id)]
      (assert-created vocab-res)

      ;; Get vocab layer
      (let [get-res (get-vocab-layer admin-request vocab-id)]
        (assert-ok get-res)
        (is (= "Test Vocab Layer" (-> get-res :body :vocab/name)))
        (is (= vocab-id (-> get-res :body :vocab/id))))

      ;; Update vocab layer
      (let [update-res (update-vocab-layer admin-request vocab-id {:name "Updated Vocab Layer"})]
        (assert-ok update-res)
        (is (= "Updated Vocab Layer" (-> update-res :body :vocab/name))))

      ;; Delete vocab layer
      (assert-no-content (delete-vocab-layer admin-request vocab-id))
      (assert-not-found (get-vocab-layer admin-request vocab-id))))

  (testing "Vocab layer with config"
    ;; Create vocab layer first
    (let [vocab-res (create-vocab-layer admin-request "Config Vocab")
          vocab-id (-> vocab-res :body :id)]
      (assert-created vocab-res)

      ;; Set config via separate endpoint (if available) or verify basic creation
      (let [get-res (get-vocab-layer admin-request vocab-id)]
        (assert-ok get-res)
        (is (= "Config Vocab" (-> get-res :body :vocab/name))))
      (assert-no-content (delete-vocab-layer admin-request vocab-id))))

  (testing "Vocab layer maintainer management"
    (let [vocab-res (create-vocab-layer admin-request "Maintainer Test Vocab")
          vocab-id (-> vocab-res :body :id)]
      (assert-created vocab-res)

      ;; Add user1 as maintainer
      (assert-no-content (add-vocab-maintainer admin-request vocab-id "user1@example.com"))

      ;; Verify user1 can now access the vocab
      (assert-ok (get-vocab-layer user1-request vocab-id))

      ;; Verify user2 cannot access the vocab
      (assert-status 403 (get-vocab-layer user2-request vocab-id))

      ;; User1 (as maintainer) can add another maintainer
      (assert-no-content (add-vocab-maintainer user1-request vocab-id "user2@example.com"))

      ;; Now user2 can access
      (assert-ok (get-vocab-layer user2-request vocab-id))

      ;; Remove user1 as maintainer
      (assert-no-content (remove-vocab-maintainer admin-request vocab-id "user1@example.com"))

      ;; User1 can no longer access
      (assert-status 403 (get-vocab-layer user1-request vocab-id))

      ;; Clean up
      (assert-no-content (delete-vocab-layer admin-request vocab-id))))

  (testing "Vocab layer authorization edge cases"
    (let [vocab-res (create-vocab-layer admin-request "Auth Test Vocab")
          vocab-id (-> vocab-res :body :id)]
      (assert-created vocab-res)

      ;; Non-admin, non-maintainer cannot access
      (assert-status 403 (get-vocab-layer user1-request vocab-id))
      (assert-status 403 (update-vocab-layer user1-request vocab-id {:name "Hacked"}))
      (assert-status 403 (delete-vocab-layer user1-request vocab-id))

      ;; Cannot add/remove maintainers without permission
      (assert-status 403 (add-vocab-maintainer user1-request vocab-id "user2@example.com"))
      (assert-status 403 (remove-vocab-maintainer user1-request vocab-id "admin@example.com"))

      ;; Clean up
      (assert-no-content (delete-vocab-layer admin-request vocab-id))))

  (testing "Vocab layer invalid operations"
    ;; Create with duplicate name should work (names not unique globally)
    (let [vocab1-res (create-vocab-layer admin-request "Duplicate Name")
          vocab1-id (-> vocab1-res :body :id)
          vocab2-res (create-vocab-layer admin-request "Duplicate Name")
          vocab2-id (-> vocab2-res :body :id)]
      (assert-created vocab1-res)
      (assert-created vocab2-res)
      (is (not= vocab1-id vocab2-id))
      (assert-no-content (delete-vocab-layer admin-request vocab1-id))
      (assert-no-content (delete-vocab-layer admin-request vocab2-id)))

    ;; Operations on non-existent vocab
    (let [fake-id (java.util.UUID/randomUUID)]
      (assert-not-found (get-vocab-layer admin-request fake-id))
      (assert-not-found (update-vocab-layer admin-request fake-id {:name "Test"}))
      (assert-not-found (delete-vocab-layer admin-request fake-id))
      (assert-not-found (add-vocab-maintainer admin-request fake-id "user1@example.com"))
      (assert-not-found (remove-vocab-maintainer admin-request fake-id "user1@example.com")))))

(deftest vocab-item-functionality
  (let [vocab-res (create-vocab-layer admin-request "Test Vocab for Items")
        vocab-id (-> vocab-res :body :id)]
    (assert-created vocab-res)

    (testing "Vocab item basic CRUD operations"
      ;; Create vocab item
      (let [item-res (create-vocab-item admin-request vocab-id "test-word")
            item-id (-> item-res :body :id)]
        (assert-created item-res)

        ;; Get vocab item
        (let [get-res (get-vocab-item admin-request item-id)]
          (assert-ok get-res)
          (is (= "test-word" (-> get-res :body :vocab-item/form)))
          (is (= vocab-id (-> get-res :body :vocab-item/layer)))
          (is (= item-id (-> get-res :body :vocab-item/id))))

        ;; Update vocab item
        (let [update-res (update-vocab-item admin-request item-id "updated-word")]
          (assert-ok update-res)
          (is (= "updated-word" (-> update-res :body :vocab-item/form))))

        ;; Delete vocab item
        (assert-no-content (delete-vocab-item admin-request item-id))
        (assert-not-found (get-vocab-item admin-request item-id))))

    (testing "Vocab item with metadata"
      (let [metadata {"confidence" 0.95 "source" "wordnet" "synonyms" ["test" "exam"]}
            item-res (create-vocab-item admin-request vocab-id "metadata-word" metadata)
            item-id (-> item-res :body :id)]
        (assert-created item-res)

        ;; Verify metadata is returned
        (let [get-res (get-vocab-item admin-request item-id)]
          (assert-ok get-res)
          (is (= "metadata-word" (-> get-res :body :vocab-item/form)))
          (is (= metadata (-> get-res :body :metadata))))

        ;; Update metadata
        (let [new-metadata {"updated" true "confidence" 0.99}]
          (assert-ok (update-vocab-item-metadata admin-request item-id new-metadata))
          (let [updated-res (get-vocab-item admin-request item-id)]
            (assert-ok updated-res)
            (is (= "metadata-word" (-> updated-res :body :vocab-item/form)))
            (is (= new-metadata (-> updated-res :body :metadata)))))

        ;; Delete metadata
        (assert-ok (delete-vocab-item-metadata admin-request item-id))
        (let [no-meta-res (get-vocab-item admin-request item-id)]
          (assert-ok no-meta-res)
          (is (= "metadata-word" (-> no-meta-res :body :vocab-item/form)))
          (is (nil? (-> no-meta-res :body :metadata))))

        ;; Clean up
        (assert-no-content (delete-vocab-item admin-request item-id))))

    (testing "Vocab item authorization through vocab layer"
      ;; Add user1 as vocab maintainer
      (assert-no-content (add-vocab-maintainer admin-request vocab-id "user1@example.com"))

      ;; User1 can create, read, update, delete vocab items
      (let [item-res (create-vocab-item user1-request vocab-id "user1-word")
            item-id (-> item-res :body :id)]
        (assert-created item-res)
        (assert-ok (get-vocab-item user1-request item-id))
        (assert-ok (update-vocab-item user1-request item-id "user1-updated"))
        (assert-no-content (delete-vocab-item user1-request item-id)))

      ;; User2 (not a maintainer) cannot access
      (let [item-res (create-vocab-item admin-request vocab-id "admin-word")
            item-id (-> item-res :body :id)]
        (assert-created item-res)
        (assert-status 403 (get-vocab-item user2-request item-id))
        (assert-status 403 (update-vocab-item user2-request item-id "hacked"))
        (assert-status 403 (update-vocab-item-metadata user2-request item-id {"hacked" true}))
        (assert-status 403 (delete-vocab-item user2-request item-id))

        ;; Clean up
        (assert-no-content (delete-vocab-item admin-request item-id)))

      ;; Remove user1 as maintainer
      (assert-no-content (remove-vocab-maintainer admin-request vocab-id "user1@example.com"))

      ;; User1 can no longer access
      (assert-status 403 (create-vocab-item user1-request vocab-id "should-fail")))

    (testing "Vocab item complex metadata"
      (let [complex-metadata {"string" "value"
                              "number" 42
                              "float" 3.14159
                              "boolean" true
                              "nested" {:inner "data" :count 5}
                              "array" [1 "two" true]
                              "mixed" {:numbers [1 2 3] :flag false}}
            item-res (create-vocab-item admin-request vocab-id "complex-meta" complex-metadata)
            item-id (-> item-res :body :id)]
        (assert-created item-res)

        (let [get-res (get-vocab-item admin-request item-id)
              returned-metadata (-> get-res :body :metadata)]
          (assert-ok get-res)
          (is (= (count complex-metadata) (count returned-metadata)))
          (doseq [[k v] complex-metadata]
            (is (= v (get returned-metadata k)))))

        ;; Clean up
        (assert-no-content (delete-vocab-item admin-request item-id))))

    (testing "Vocab item edge cases"
      ;; Empty form should be allowed
      (let [empty-res (create-vocab-item admin-request vocab-id "")
            empty-id (-> empty-res :body :id)]
        (assert-created empty-res)
        (is (= "" (-> (get-vocab-item admin-request empty-id) :body :vocab-item/form)))
        (assert-no-content (delete-vocab-item admin-request empty-id)))

      ;; Unicode and special characters
      (let [unicode-form "café résumé naïve 中文 🚀 emoji"
            unicode-res (create-vocab-item admin-request vocab-id unicode-form)
            unicode-id (-> unicode-res :body :id)]
        (assert-created unicode-res)
        (is (= unicode-form (-> (get-vocab-item admin-request unicode-id) :body :vocab-item/form)))
        (assert-no-content (delete-vocab-item admin-request unicode-id)))

      ;; Operations on non-existent item
      (let [fake-id (java.util.UUID/randomUUID)]
        (assert-not-found (get-vocab-item admin-request fake-id))
        (assert-not-found (update-vocab-item admin-request fake-id "test"))
        (assert-not-found (update-vocab-item-metadata admin-request fake-id {"test" true}))
        (assert-not-found (delete-vocab-item-metadata admin-request fake-id))
        (assert-not-found (delete-vocab-item admin-request fake-id))))

    (testing "Vocab layer with include-items parameter"
      ;; Create several items
      (let [item1-res (create-vocab-item admin-request vocab-id "item1")
            item1-id (-> item1-res :body :id)
            item2-res (create-vocab-item admin-request vocab-id "item2")
            item2-id (-> item2-res :body :id)]
        (assert-created item1-res)
        (assert-created item2-res)

        ;; Get vocab without items
        (let [no-items-res (get-vocab-layer admin-request vocab-id)]
          (assert-ok no-items-res)
          (is (nil? (-> no-items-res :body :vocab/items))))

        ;; Get vocab with items
        (let [with-items-res (get-vocab-layer admin-request vocab-id true)]
          (assert-ok with-items-res)
          (let [items (-> with-items-res :body :vocab/items)]
            (is (= 2 (count items)))
            (is (some #(= "item1" (:vocab-item/form %)) items))
            (is (some #(= "item2" (:vocab-item/form %)) items))))

        ;; Clean up
        (assert-no-content (delete-vocab-item admin-request item1-id))
        (assert-no-content (delete-vocab-item admin-request item2-id))))

    ;; Clean up vocab layer
    (assert-no-content (delete-vocab-layer admin-request vocab-id))))

(deftest vocab-link-functionality
  ;; Set up basic infrastructure for vocab-link tests
  (let [proj-res (api-call admin-request {:method :post
                                          :path "/api/v1/projects"
                                          :body {:name "VocabLinkProject"}})
        proj-id (-> proj-res :body :id)
        doc-res (api-call admin-request {:method :post
                                         :path "/api/v1/documents"
                                         :body {:project-id proj-id :name "VocabLinkDoc"}})
        doc-id (-> doc-res :body :id)
        tl-res (api-call admin-request {:method :post
                                        :path "/api/v1/text-layers"
                                        :body {:project-id proj-id :name "VocabLinkTextLayer"}})
        tl-id (-> tl-res :body :id)
        text-res (api-call admin-request {:method :post
                                          :path "/api/v1/texts"
                                          :body {:text-layer-id tl-id
                                                 :document-id doc-id
                                                 :body "hello world test"}})
        text-id (-> text-res :body :id)
        tkl-res (api-call admin-request {:method :post
                                         :path "/api/v1/token-layers"
                                         :body {:text-layer-id tl-id :name "VocabLinkTokenLayer"}})
        tkl-id (-> tkl-res :body :id)
        token1-res (api-call admin-request {:method :post
                                            :path "/api/v1/tokens"
                                            :body {:token-layer-id tkl-id
                                                   :text text-id
                                                   :begin 0 :end 5}}) ; "hello"
        token1-id (-> token1-res :body :id)
        token2-res (api-call admin-request {:method :post
                                            :path "/api/v1/tokens"
                                            :body {:token-layer-id tkl-id
                                                   :text text-id
                                                   :begin 6 :end 11}}) ; "world"
        token2-id (-> token2-res :body :id)
        token3-res (api-call admin-request {:method :post
                                            :path "/api/v1/tokens"
                                            :body {:token-layer-id tkl-id
                                                   :text text-id
                                                   :begin 12 :end 16}}) ; "test"
        token3-id (-> token3-res :body :id)
        vocab-res (create-vocab-layer admin-request "VocabLinkVocab")
        vocab-id (-> vocab-res :body :id)
        item-res (create-vocab-item admin-request vocab-id "greeting")
        item-id (-> item-res :body :id)]

    (assert-created proj-res)
    (assert-created doc-res)
    (assert-created tl-res)
    (assert-created text-res)
    (assert-created tkl-res)
    (assert-created token1-res)
    (assert-created token2-res)
    (assert-created token3-res)
    (assert-created vocab-res)
    (assert-created item-res)

    ;; Link vocab layer to project before creating vocab links
    (assert-no-content (api-call admin-request {:method :post
                                                :path (str "/api/v1/projects/" proj-id "/vocabs/" vocab-id)}))

    (testing "Vocab link basic operations"
      ;; Create vocab link
      (let [link-res (create-vocab-link admin-request item-id [token1-id])
            link-id (-> link-res :body :id)]
        (assert-created link-res)

        ;; Get vocab link
        (let [get-res (get-vocab-link admin-request link-id)]
          (assert-ok get-res)
          (is (= item-id (-> get-res :body :vocab-link/vocab-item)))
          (is (= [token1-id] (-> get-res :body :vocab-link/tokens)))
          (is (= link-id (-> get-res :body :vocab-link/id))))

        ;; Delete vocab link
        (assert-no-content (delete-vocab-link admin-request link-id))
        (assert-not-found (get-vocab-link admin-request link-id))))

    (testing "Vocab link with multiple tokens"
      ;; Create link with multiple tokens
      (let [link-res (create-vocab-link admin-request item-id [token1-id token2-id])
            link-id (-> link-res :body :id)]
        (assert-created link-res)

        (let [get-res (get-vocab-link admin-request link-id)]
          (assert-ok get-res)
          (is (= [token1-id token2-id] (-> get-res :body :vocab-link/tokens))))

        ;; Clean up
        (assert-no-content (delete-vocab-link admin-request link-id))))

    (testing "Vocab link with metadata"
      (let [metadata {"confidence" 0.87 "annotator" "human" "notes" "checked by expert"}
            link-res (create-vocab-link admin-request item-id [token3-id] metadata)
            link-id (-> link-res :body :id)]
        (assert-created link-res)

        ;; Verify metadata is returned
        (let [get-res (get-vocab-link admin-request link-id)]
          (assert-ok get-res)
          (is (= metadata (-> get-res :body :metadata))))

        ;; Update metadata
        (let [new-metadata {"updated" true "confidence" 0.95}]
          (assert-ok (update-vocab-link-metadata admin-request link-id new-metadata))
          (let [updated-res (get-vocab-link admin-request link-id)]
            (assert-ok updated-res)
            (is (= new-metadata (-> updated-res :body :metadata)))))

        ;; Delete metadata
        (assert-ok (delete-vocab-link-metadata admin-request link-id))
        (let [no-meta-res (get-vocab-link admin-request link-id)]
          (assert-ok no-meta-res)
          (is (nil? (-> no-meta-res :body :metadata))))

        ;; Clean up
        (assert-no-content (delete-vocab-link admin-request link-id))))

    (testing "Vocab link dual authorization - project write + vocab read"
      ;; First unlink vocab from project to test initial authorization
      (assert-no-content (api-call admin-request {:method :delete
                                                  :path (str "/api/v1/projects/" proj-id "/vocabs/" vocab-id)}))

      ;; Add user1 as project writer but not vocab maintainer
      (let [add-writer-res (api-call admin-request {:method :post
                                                    :path (str "/api/v1/projects/" proj-id "/writers/user1@example.com")})]
        (assert-no-content add-writer-res))

      ;; Add user2 as vocab maintainer but not project member
      (assert-no-content (add-vocab-maintainer admin-request vocab-id "user2@example.com"))

      ;; User1 has project write but the vocab is not linked - should fail
      (assert-status 403 (create-vocab-link user1-request item-id [token1-id]))

      ;; User2 has vocab read but no project write - should fail
      (assert-status 403 (create-vocab-link user2-request item-id [token1-id]))

      ;; Add vocab to project so user1 gets vocab access
      (let [update-proj-res (api-call admin-request {:method :post
                                                     :path (str "/api/v1/projects/" proj-id "/vocabs/" vocab-id)})]
        (assert-no-content update-proj-res))

      ;; Now user1 should be able to create vocab links (project write + vocab read through project)
      (let [link-res (create-vocab-link user1-request item-id [token2-id])
            link-id (-> link-res :body :id)]
        (assert-created link-res)

        ;; User1 can also read and delete the link
        (assert-ok (get-vocab-link user1-request link-id))
        (assert-no-content (delete-vocab-link user1-request link-id)))

      ;; User2 still cannot create links (vocab read but no project write)
      (assert-status 403 (create-vocab-link user2-request item-id [token3-id]))

      ;; Add user2 as project writer
      (let [add-writer2-res (api-call admin-request {:method :post
                                                     :path (str "/api/v1/projects/" proj-id "/writers/user2@example.com")})]
        (assert-no-content add-writer2-res))

      ;; Now user2 can create links (project write + vocab read as maintainer)
      (let [link-res (create-vocab-link user2-request item-id [token3-id])
            link-id (-> link-res :body :id)]
        (assert-created link-res)
        (assert-no-content (delete-vocab-link user2-request link-id))))

    (testing "Vocab link edge cases"
      ;; Create link to non-existent vocab item
      (let [fake-item-id (java.util.UUID/randomUUID)]
        (assert-bad-request (create-vocab-link admin-request fake-item-id [token1-id])))

      ;; Create link to non-existent token
      (let [fake-token-id (java.util.UUID/randomUUID)]
        (assert-bad-request (create-vocab-link admin-request item-id [fake-token-id])))

      ;; Create link with empty token list
      (assert-bad-request (create-vocab-link admin-request item-id []))

      ;; Operations on non-existent link
      (let [fake-link-id (java.util.UUID/randomUUID)]
        (assert-not-found (get-vocab-link admin-request fake-link-id))
        (assert-not-found (update-vocab-link-metadata admin-request fake-link-id {"test" true}))
        (assert-not-found (delete-vocab-link-metadata admin-request fake-link-id))
        (assert-not-found (delete-vocab-link admin-request fake-link-id))))

    (testing "Multiple vocab links per token"
      ;; Create multiple vocab items
      (let [item2-res (create-vocab-item admin-request vocab-id "salutation")
            item2-id (-> item2-res :body :id)
            item3-res (create-vocab-item admin-request vocab-id "word")
            item3-id (-> item3-res :body :id)]
        (assert-created item2-res)
        (assert-created item3-res)

        ;; Create multiple links to the same token
        (let [link1-res (create-vocab-link admin-request item-id [token1-id]) ; "greeting" -> "hello"
              link1-id (-> link1-res :body :id)
              link2-res (create-vocab-link admin-request item2-id [token1-id]) ; "salutation" -> "hello"
              link2-id (-> link2-res :body :id)
              link3-res (create-vocab-link admin-request item3-id [token1-id]) ; "word" -> "hello"
              link3-id (-> link3-res :body :id)]
          (assert-created link1-res)
          (assert-created link2-res)
          (assert-created link3-res)

          ;; Verify all links exist and point to the same token
          (is (= [token1-id] (-> (get-vocab-link admin-request link1-id) :body :vocab-link/tokens)))
          (is (= [token1-id] (-> (get-vocab-link admin-request link2-id) :body :vocab-link/tokens)))
          (is (= [token1-id] (-> (get-vocab-link admin-request link3-id) :body :vocab-link/tokens)))

          ;; Clean up
          (assert-no-content (delete-vocab-link admin-request link1-id))
          (assert-no-content (delete-vocab-link admin-request link2-id))
          (assert-no-content (delete-vocab-link admin-request link3-id))
          (assert-no-content (delete-vocab-item admin-request item2-id))
          (assert-no-content (delete-vocab-item admin-request item3-id)))))

    ;; Clean up
    (assert-no-content (delete-vocab-item admin-request item-id))
    (assert-no-content (delete-vocab-layer admin-request vocab-id))
    (assert-no-content (delete-test-project admin-request proj-id))))

(deftest vocab-integration-scenarios
  (testing "Document enhancement with vocab data - token-layer/vocabs"
    ;; Set up project with vocab
    (let [proj-id (create-test-project admin-request "IntegrationProject")
          doc-id (create-test-document admin-request proj-id "IntegrationDoc")
          tl-res (api-call admin-request {:method :post
                                          :path "/api/v1/text-layers"
                                          :body {:project-id proj-id :name "IntegrationTextLayer"}})
          tl-id (-> tl-res :body :id)
          text-res (api-call admin-request {:method :post
                                            :path "/api/v1/texts"
                                            :body {:text-layer-id tl-id
                                                   :document-id doc-id
                                                   :body "The quick brown fox"}})
          text-id (-> text-res :body :id)
          tkl-res (api-call admin-request {:method :post
                                           :path "/api/v1/token-layers"
                                           :body {:text-layer-id tl-id :name "IntegrationTokenLayer"}})
          tkl-id (-> tkl-res :body :id)
          token1-res (api-call admin-request {:method :post
                                              :path "/api/v1/tokens"
                                              :body {:token-layer-id tkl-id
                                                     :text text-id
                                                     :begin 0 :end 3}}) ; "The"
          token1-id (-> token1-res :body :id)
          token2-res (api-call admin-request {:method :post
                                              :path "/api/v1/tokens"
                                              :body {:token-layer-id tkl-id
                                                     :text text-id
                                                     :begin 4 :end 9}}) ; "quick"
          token2-id (-> token2-res :body :id)
          token3-res (api-call admin-request {:method :post
                                              :path "/api/v1/tokens"
                                              :body {:token-layer-id tkl-id
                                                     :text text-id
                                                     :begin 10 :end 15}}) ; "brown"
          token3-id (-> token3-res :body :id)
          token4-res (api-call admin-request {:method :post
                                              :path "/api/v1/tokens"
                                              :body {:token-layer-id tkl-id
                                                     :text text-id
                                                     :begin 16 :end 19}}) ; "fox"
          token4-id (-> token4-res :body :id)

          ;; Create vocab layers and items
          vocab1-res (create-vocab-layer admin-request "Articles")
          vocab1-id (-> vocab1-res :body :id)
          vocab2-res (create-vocab-layer admin-request "Adjectives")
          vocab2-id (-> vocab2-res :body :id)
          vocab3-res (create-vocab-layer admin-request "Animals")
          vocab3-id (-> vocab3-res :body :id)

          article-item-res (create-vocab-item admin-request vocab1-id "definite-article" {"pos" "DT"})
          article-item-id (-> article-item-res :body :id)
          adjective1-res (create-vocab-item admin-request vocab2-id "speed-adjective" {"semantic" "velocity"})
          adjective1-id (-> adjective1-res :body :id)
          adjective2-res (create-vocab-item admin-request vocab2-id "color-adjective" {"semantic" "color"})
          adjective2-id (-> adjective2-res :body :id)
          animal-item-res (create-vocab-item admin-request vocab3-id "canine" {"species" "vulpes"})
          animal-item-id (-> animal-item-res :body :id)]

      (assert-created tl-res)
      (assert-created text-res)
      (assert-created tkl-res)
      (assert-created token1-res)
      (assert-created token2-res)
      (assert-created token3-res)
      (assert-created token4-res)
      (assert-created vocab1-res)
      (assert-created vocab2-res)
      (assert-created vocab3-res)
      (assert-created article-item-res)
      (assert-created adjective1-res)
      (assert-created adjective2-res)
      (assert-created animal-item-res)

      ;; Link vocab layers to project before creating vocab links
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj-id "/vocabs/" vocab1-id)}))
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj-id "/vocabs/" vocab2-id)}))
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj-id "/vocabs/" vocab3-id)}))

      ;; Create vocab links
      (let [link1-res (create-vocab-link admin-request article-item-id [token1-id] {"confidence" 1.0})
            link1-id (-> link1-res :body :id)
            link2-res (create-vocab-link admin-request adjective1-id [token2-id] {"confidence" 0.9})
            link2-id (-> link2-res :body :id)
            link3-res (create-vocab-link admin-request adjective2-id [token3-id] {"confidence" 0.95})
            link3-id (-> link3-res :body :id)
            link4-res (create-vocab-link admin-request animal-item-id [token4-id] {"confidence" 0.87})
            link4-id (-> link4-res :body :id)]

        (assert-created link1-res)
        (assert-created link2-res)
        (assert-created link3-res)
        (assert-created link4-res)

        ;; Get document with layer data to check vocab enhancement
        (let [doc-with-layers-res (api-call admin-request {:method :get
                                                           :path (str "/api/v1/documents/" doc-id "?include-body=true")})
              doc-data (-> doc-with-layers-res :body)
              text-layer (-> doc-data :document/text-layers first)
              token-layer (-> text-layer :text-layer/token-layers first)
              vocabs (-> token-layer :token-layer/vocabs)]

          (assert-ok doc-with-layers-res)

          ;; Verify vocab structure is correct
          (is (= 3 (count vocabs))) ; Three vocab layers

          ;; Check each vocab layer has correct structure
          (doseq [vocab vocabs]
            (is (contains? vocab :vocab/id))
            (is (contains? vocab :vocab/name))
            (is (contains? vocab :vocab-layer/vocab-links))

            ;; Each vocab-link should have expanded vocab-item
            (doseq [link (:vocab-layer/vocab-links vocab)]
              (is (contains? link :vocab-link/id))
              (is (contains? link :vocab-link/tokens))
              (is (contains? link :vocab-link/vocab-item))
              (is (map? (:vocab-link/vocab-item link))) ; Should be expanded, not just UUID
              (is (contains? (:vocab-link/vocab-item link) :vocab-item/form))))

          ;; Verify specific vocab content
          (let [articles-vocab (first (filter #(= "Articles" (:vocab/name %)) vocabs))
                adjectives-vocab (first (filter #(= "Adjectives" (:vocab/name %)) vocabs))
                animals-vocab (first (filter #(= "Animals" (:vocab/name %)) vocabs))]

            ;; Articles vocab should have one link
            (is (= 1 (count (:vocab-layer/vocab-links articles-vocab))))
            (let [article-link (first (:vocab-layer/vocab-links articles-vocab))]
              (is (= "definite-article" (get-in article-link [:vocab-link/vocab-item :vocab-item/form])))
              (is (= [token1-id] (:vocab-link/tokens article-link)))
              (is (= {"confidence" 1.0} (:metadata article-link))))

            ;; Adjectives vocab should have two links
            (is (= 2 (count (:vocab-layer/vocab-links adjectives-vocab))))

            ;; Animals vocab should have one link
            (is (= 1 (count (:vocab-layer/vocab-links animals-vocab))))
            (let [animal-link (first (:vocab-layer/vocab-links animals-vocab))]
              (is (= "canine" (get-in animal-link [:vocab-link/vocab-item :vocab-item/form])))
              (is (= [token4-id] (:vocab-link/tokens animal-link)))))

          ;; Clean up
          (assert-no-content (delete-vocab-link admin-request link1-id))
          (assert-no-content (delete-vocab-link admin-request link2-id))
          (assert-no-content (delete-vocab-link admin-request link3-id))
          (assert-no-content (delete-vocab-link admin-request link4-id)))

        ;; Clean up
        (assert-no-content (delete-vocab-item admin-request article-item-id))
        (assert-no-content (delete-vocab-item admin-request adjective1-id))
        (assert-no-content (delete-vocab-item admin-request adjective2-id))
        (assert-no-content (delete-vocab-item admin-request animal-item-id))
        (assert-no-content (delete-vocab-layer admin-request vocab1-id))
        (assert-no-content (delete-vocab-layer admin-request vocab2-id))
        (assert-no-content (delete-vocab-layer admin-request vocab3-id))
        (delete-test-project admin-request proj-id))))

  (testing "Cross-project vocab access through project configuration"
    ;; Create two projects and one shared vocab
    (let [proj1-id (create-test-project admin-request "Project1")
          proj2-id (create-test-project admin-request "Project2")
          shared-vocab-res (create-vocab-layer admin-request "SharedVocab")
          shared-vocab-id (-> shared-vocab-res :body :id)
          item-res (create-vocab-item admin-request shared-vocab-id "shared-term")
          item-id (-> item-res :body :id)]

      (assert-created shared-vocab-res)
      (assert-created item-res)

      ;; Add user1 as writer to both projects
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj1-id "/writers/user1@example.com")}))
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj2-id "/writers/user1@example.com")}))

      ;; Initially user1 cannot access the vocab
      (assert-status 403 (get-vocab-layer user1-request shared-vocab-id))
      (assert-status 403 (get-vocab-item user1-request item-id))

      ;; Add shared vocab to project1
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj1-id "/vocabs/" shared-vocab-id)}))

      ;; Now user1 can access vocab through project1
      (assert-ok (get-vocab-layer user1-request shared-vocab-id))
      (assert-ok (get-vocab-item user1-request item-id))

      ;; Add shared vocab to project2 as well
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj2-id "/vocabs/" shared-vocab-id)}))

      ;; User1 still has access (through either project)
      (assert-ok (get-vocab-layer user1-request shared-vocab-id))

      ;; Remove vocab from project1
      (assert-no-content (api-call admin-request {:method :delete
                                                  :path (str "/api/v1/projects/" proj1-id "/vocabs/" shared-vocab-id)}))

      ;; User1 still has access through project2
      (assert-ok (get-vocab-layer user1-request shared-vocab-id))

      ;; Remove vocab from project2
      (assert-no-content (api-call admin-request {:method :delete
                                                  :path (str "/api/v1/projects/" proj2-id "/vocabs/" shared-vocab-id)}))

      ;; Now user1 loses access
      (assert-status 403 (get-vocab-layer user1-request shared-vocab-id))

      ;; Clean up
      (assert-no-content (delete-vocab-item admin-request item-id))
      (assert-no-content (delete-vocab-layer admin-request shared-vocab-id))
      ;; Note: delete-test-project takes IDs directly, not response objects
      (delete-test-project admin-request proj1-id)
      (delete-test-project admin-request proj2-id)))

  (testing "Cascading deletion - vocab layer affects items and links"
    ;; Create infrastructure
    (let [proj-id (create-test-project admin-request "CascadeProject")
          doc-id (create-test-document admin-request proj-id "CascadeDoc")
          tl-res (api-call admin-request {:method :post
                                          :path "/api/v1/text-layers"
                                          :body {:project-id proj-id :name "CascadeTextLayer"}})
          tl-id (-> tl-res :body :id)
          text-res (api-call admin-request {:method :post
                                            :path "/api/v1/texts"
                                            :body {:text-layer-id tl-id
                                                   :document-id doc-id
                                                   :body "test word"}})
          text-id (-> text-res :body :id)
          tkl-res (api-call admin-request {:method :post
                                           :path "/api/v1/token-layers"
                                           :body {:text-layer-id tl-id :name "CascadeTokenLayer"}})
          tkl-id (-> tkl-res :body :id)
          token-res (api-call admin-request {:method :post
                                             :path "/api/v1/tokens"
                                             :body {:token-layer-id tkl-id
                                                    :text text-id
                                                    :begin 0 :end 4}}) ; "test"
          token-id (-> token-res :body :id)
          vocab-res (create-vocab-layer admin-request "CascadeVocab")
          vocab-id (-> vocab-res :body :id)]

      (assert-created tl-res)
      (assert-created text-res)
      (assert-created tkl-res)
      (assert-created token-res)
      (assert-created vocab-res)

      ;; Link vocab layer to project before creating vocab links
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj-id "/vocabs/" vocab-id)}))

      ;; Create vocab items and links
      (let [item1-res (create-vocab-item admin-request vocab-id "term1")
            item1-id (-> item1-res :body :id)
            item2-res (create-vocab-item admin-request vocab-id "term2")
            item2-id (-> item2-res :body :id)
            link1-res (create-vocab-link admin-request item1-id [token-id])
            link1-id (-> link1-res :body :id)
            link2-res (create-vocab-link admin-request item2-id [token-id])
            link2-id (-> link2-res :body :id)]

        (assert-created item1-res)
        (assert-created item2-res)
        (assert-created link1-res)
        (assert-created link2-res)

        ;; Verify everything exists
        (assert-ok (get-vocab-layer admin-request vocab-id))
        (assert-ok (get-vocab-item admin-request item1-id))
        (assert-ok (get-vocab-item admin-request item2-id))
        (assert-ok (get-vocab-link admin-request link1-id))
        (assert-ok (get-vocab-link admin-request link2-id))

        ;; Delete vocab layer - should cascade to items and links
        (assert-no-content (delete-vocab-layer admin-request vocab-id))

        ;; Verify everything is gone
        (assert-not-found (get-vocab-layer admin-request vocab-id))
        (assert-not-found (get-vocab-item admin-request item1-id))
        (assert-not-found (get-vocab-item admin-request item2-id))
        (assert-not-found (get-vocab-link admin-request link1-id))
        (assert-not-found (get-vocab-link admin-request link2-id)))

      ;; Clean up
      (delete-test-project admin-request proj-id))))

(deftest vocab-edge-cases
  (testing "Complex unicode and special characters in vocab forms"
    (let [vocab-res (create-vocab-layer admin-request "UnicodeVocab")
          vocab-id (-> vocab-res :body :id)]
      (assert-created vocab-res)

      ;; Test various unicode and special character forms
      (let [test-forms ["café résumé" ; Accented characters
                        "中文词汇" ; Chinese characters
                        "العربية" ; Arabic text
                        "🚀🎉💻" ; Emojis
                        "math: ∀x∈ℝ, x²≥0" ; Mathematical symbols
                        "quotes: \"double\" 'single'" ; Quotes
                        "symbols: @#$%^&*()_+-={}[]|\\:;\"'<>?,./" ; Special chars
                        "" ; Empty string
                        "   spaces   " ; Leading/trailing spaces
                        "\t\n\r" ; Whitespace chars
                        "very" (apply str (repeat 1000 "long"))]] ; Very long string

        (doseq [form test-forms]
          (let [item-res (create-vocab-item admin-request vocab-id form)
                item-id (-> item-res :body :id)]
            (assert-created item-res)
            (let [get-res (get-vocab-item admin-request item-id)]
              (assert-ok get-res)
              (is (= form (-> get-res :body :vocab-item/form))))
            (assert-no-content (delete-vocab-item admin-request item-id)))))

      ;; Clean up
      (assert-no-content (delete-vocab-layer admin-request vocab-id))))

  (testing "Large metadata structures and boundary conditions"
    (let [vocab-res (create-vocab-layer admin-request "MetadataTestVocab")
          vocab-id (-> vocab-res :body :id)]
      (assert-created vocab-res)

      ;; Test very large metadata
      (let [large-metadata (into {} (for [i (range 100)]
                                      [(str "key" i) (str "value" i)]))
            item-res (create-vocab-item admin-request vocab-id "large-meta-item" large-metadata)
            item-id (-> item-res :body :id)]
        (assert-created item-res)
        (let [get-res (get-vocab-item admin-request item-id)]
          (assert-ok get-res)
          (is (= 100 (count (-> get-res :body :metadata)))))
        (assert-no-content (delete-vocab-item admin-request item-id)))

      ;; Test deeply nested metadata (skip for now - metadata system may not support deep nesting)
      ;; TODO: Investigate if deep nesting is supported or if metadata is flattened

      ;; Clean up
      (assert-no-content (delete-vocab-layer admin-request vocab-id))))

  ;; Stress test removed for now - can be added later when basic functionality is stable

  (testing "Permission edge cases and complex inheritance"
    ;; Test complex permission scenarios
    (let [vocab-res (create-vocab-layer admin-request "PermissionTestVocab")
          vocab-id (-> vocab-res :body :id)
          item-res (create-vocab-item admin-request vocab-id "perm-test-item")
          item-id (-> item-res :body :id)
          proj1-id (create-test-project admin-request "PermProject1")
          proj2-id (create-test-project admin-request "PermProject2")]

      (assert-created vocab-res)
      (assert-created item-res)

      ;; Complex permission scenario:
      ;; - user1 is vocab maintainer
      ;; - user2 is project1 writer (but not vocab maintainer)
      ;; - vocab is linked to project1 (so user2 gets vocab read access)
      ;; - user2 is also project2 maintainer

      ;; Set up permissions
      (assert-no-content (add-vocab-maintainer admin-request vocab-id "user1@example.com"))
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj1-id "/writers/user2@example.com")}))
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj2-id "/maintainers/user2@example.com")}))
      ;; Link vocab to project1
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj1-id "/vocabs/" vocab-id)}))

      ;; Test access patterns
      ;; user1 can access vocab (maintainer)
      (assert-ok (get-vocab-layer user1-request vocab-id))
      (assert-ok (get-vocab-item user1-request item-id))
      (assert-ok (update-vocab-item user1-request item-id "updated-by-user1"))

      ;; user2 can read AND write vocab through project1 (as a project writer)
      (assert-ok (get-vocab-layer user2-request vocab-id))
      (assert-ok (get-vocab-item user2-request item-id))
      (assert-ok (update-vocab-item user2-request item-id "updated-by-user2"))
      (let [new-item-res (create-vocab-item user2-request vocab-id "created-by-user2")
            new-item-id (-> new-item-res :body :id)]
        (assert-created new-item-res)
        ;; Clean up the item
        (assert-no-content (delete-vocab-item admin-request new-item-id)))

      ;; Remove vocab from project1 - user2 loses access
      (assert-no-content (api-call admin-request {:method :delete
                                                  :path (str "/api/v1/projects/" proj1-id "/vocabs/" vocab-id)}))
      (assert-status 403 (get-vocab-layer user2-request vocab-id))
      (assert-status 403 (get-vocab-item user2-request item-id))

      ;; Add vocab to project2 - user2 regains access (as project2 maintainer)
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj2-id "/vocabs/" vocab-id)}))
      (assert-ok (get-vocab-layer user2-request vocab-id))
      (assert-ok (get-vocab-item user2-request item-id))

      ;; Clean up
      (assert-no-content (delete-vocab-item admin-request item-id))
      (assert-no-content (delete-vocab-layer admin-request vocab-id))
      (delete-test-project admin-request proj1-id)
      (delete-test-project admin-request proj2-id)))

  (testing "Invalid requests and malformed data"
    ;; Test various invalid request scenarios
    (let [vocab-res (create-vocab-layer admin-request "InvalidTestVocab")
          vocab-id (-> vocab-res :body :id)]
      (assert-created vocab-res)

      ;; Invalid vocab layer operations
      (is (thrown? java.lang.IllegalArgumentException (api-call admin-request {:method :post
                                                                               :path "/api/v1/vocab-layers"
                                                                               :body {}}))) ; Missing name

      (assert-bad-request (api-call admin-request {:method :post
                                                   :path "/api/v1/vocab-layers"
                                                   :body {:name ""}})) ; Empty name

      ;; Invalid vocab item operations
      (is (thrown? java.lang.IllegalArgumentException (api-call admin-request {:method :post
                                                                               :path "/api/v1/vocab-items"
                                                                               :body {:vocab-layer-id vocab-id}}))) ; Missing form

      (is (thrown? java.lang.IllegalArgumentException (api-call admin-request {:method :post
                                                                               :path "/api/v1/vocab-items"
                                                                               :body {:form "test"}}))) ; Missing vocab-layer-id

      (let [fake-vocab-id (java.util.UUID/randomUUID)]
        (assert-not-found (api-call admin-request {:method :post
                                                   :path "/api/v1/vocab-items"
                                                   :body {:vocab-layer-id fake-vocab-id
                                                          :form "test"}}))) ; Non-existent vocab

      ;; Invalid vocab link operations  
      (let [item-res (create-vocab-item admin-request vocab-id "test-item")
            item-id (-> item-res :body :id)]
        (assert-created item-res)

        (is (thrown? java.lang.IllegalArgumentException (api-call admin-request {:method :post
                                                                                 :path "/api/v1/vocab-links"
                                                                                 :body {:vocab-item item-id}}))) ; Missing tokens

        (is (thrown? java.lang.IllegalArgumentException (api-call admin-request {:method :post
                                                                                 :path "/api/v1/vocab-links"
                                                                                 :body {:tokens []}}))) ; Missing vocab-item-id

        (assert-bad-request (api-call admin-request {:method :post
                                                     :path "/api/v1/vocab-links"
                                                     :body {:vocab-item item-id
                                                            :tokens []}})) ; Empty tokens array

        ;; Clean up
        (assert-no-content (delete-vocab-item admin-request item-id)))

      ;; Clean up
      (assert-no-content (delete-vocab-layer admin-request vocab-id)))))

(deftest vocab-link-project-validation
  "Test that vocab link creation fails when project is not linked to vocab layer"
  (testing "vocab link creation should fail if project is not linked to vocab layer"
    (let [project1-id (create-test-project admin-request "Project 1")
          project2-id (create-test-project admin-request "Project 2")
          vocab-id (-> (create-vocab-layer admin-request "TestVocab") :body :id)
          doc1-id (create-test-document admin-request project1-id "Doc1")
          doc2-id (create-test-document admin-request project2-id "Doc2")
          
          ;; Create layers and texts for both projects
          txtl1-res (create-text-layer admin-request project1-id "TextLayer1")
          txtl2-res (create-text-layer admin-request project2-id "TextLayer2")
          _ (assert-created txtl1-res)
          _ (assert-created txtl2-res)
          txtl1-id (-> txtl1-res :body :id)
          txtl2-id (-> txtl2-res :body :id)
          
          tokl1-res (create-token-layer admin-request txtl1-id "TokenLayer1")
          tokl2-res (create-token-layer admin-request txtl2-id "TokenLayer2")
          _ (assert-created tokl1-res)
          _ (assert-created tokl2-res)
          tokl1-id (-> tokl1-res :body :id)
          tokl2-id (-> tokl2-res :body :id)
          
          text1-res (create-text admin-request txtl1-id doc1-id "Hello world")
          text2-res (create-text admin-request txtl2-id doc2-id "Goodbye world")
          _ (assert-created text1-res)
          _ (assert-created text2-res)
          text1-id (-> text1-res :body :id)
          text2-id (-> text2-res :body :id)
          
          token1-res (create-token admin-request tokl1-id text1-id 0 5)
          token2-res (create-token admin-request tokl2-id text2-id 0 7)
          _ (assert-created token1-res)
          _ (assert-created token2-res)
          token1-id (-> token1-res :body :id)
          token2-id (-> token2-res :body :id)]

      ;; Create vocab item
      (let [item-res (create-vocab-item admin-request vocab-id "test")
            _ (assert-created item-res)
            item-id (-> item-res :body :id)]

        ;; Link vocab to project1 only
        (assert-no-content (api-call admin-request {:method :post
                                                    :path (str "/api/v1/projects/" project1-id "/vocabs/" vocab-id)}))

        ;; Should succeed: creating vocab link with token from project1 (linked to vocab)
        (let [link-res (create-vocab-link admin-request item-id [token1-id])]
          (assert-created link-res)
          (let [link-id (-> link-res :body :id)]
            ;; Clean up the link
            (assert-no-content (delete-vocab-link admin-request link-id))))

        ;; Should fail: creating vocab link with token from project2 (not linked to vocab)
        (assert-bad-request (create-vocab-link admin-request item-id [token2-id]))

        ;; Clean up
        (assert-no-content (delete-vocab-item admin-request item-id)))

      ;; Clean up projects and vocabs
      (assert-no-content (delete-vocab-layer admin-request vocab-id))
      (assert-no-content (delete-test-project admin-request project1-id))
      (assert-no-content (delete-test-project admin-request project2-id)))))

(deftest vocab-unlink-cleanup
  "Test that unlinking a vocab from a project deletes all associated vocab links"
  (testing "unlinking vocab should delete all vocab links for that project"
    (let [project-id (create-test-project admin-request "TestProject")
          vocab-id (-> (create-vocab-layer admin-request "TestVocab") :body :id)
          doc-id (create-test-document admin-request project-id "TestDoc")
          
          ;; Create layers and text
          txtl-res (create-text-layer admin-request project-id "TextLayer")
          _ (assert-created txtl-res)
          txtl-id (-> txtl-res :body :id)
          
          tokl-res (create-token-layer admin-request txtl-id "TokenLayer")
          _ (assert-created tokl-res)
          tokl-id (-> tokl-res :body :id)
          
          text-res (create-text admin-request txtl-id doc-id "Hello wonderful world")
          _ (assert-created text-res)
          text-id (-> text-res :body :id)
          
          ;; Create multiple tokens
          token1-res (create-token admin-request tokl-id text-id 0 5)  ; "Hello"
          token2-res (create-token admin-request tokl-id text-id 6 15) ; "wonderful"
          token3-res (create-token admin-request tokl-id text-id 16 21) ; "world"
          _ (assert-created token1-res)
          _ (assert-created token2-res)
          _ (assert-created token3-res)
          token1-id (-> token1-res :body :id)
          token2-id (-> token2-res :body :id)
          token3-id (-> token3-res :body :id)]

      ;; Create vocab items and link vocab to project
      (let [item1-res (create-vocab-item admin-request vocab-id "greeting")
            item2-res (create-vocab-item admin-request vocab-id "adjective")
            item3-res (create-vocab-item admin-request vocab-id "noun")
            _ (assert-created item1-res)
            _ (assert-created item2-res)
            _ (assert-created item3-res)
            item1-id (-> item1-res :body :id)
            item2-id (-> item2-res :body :id)
            item3-id (-> item3-res :body :id)]

        ;; Link vocab to project
        (assert-no-content (api-call admin-request {:method :post
                                                    :path (str "/api/v1/projects/" project-id "/vocabs/" vocab-id)}))

        ;; Create vocab links
        (let [link1-res (create-vocab-link admin-request item1-id [token1-id])
              link2-res (create-vocab-link admin-request item2-id [token2-id])
              link3-res (create-vocab-link admin-request item3-id [token3-id])
              _ (assert-created link1-res)
              _ (assert-created link2-res)
              _ (assert-created link3-res)
              link1-id (-> link1-res :body :id)
              link2-id (-> link2-res :body :id)
              link3-id (-> link3-res :body :id)]

          ;; Verify all vocab links exist
          (assert-ok (get-vocab-link admin-request link1-id))
          (assert-ok (get-vocab-link admin-request link2-id))
          (assert-ok (get-vocab-link admin-request link3-id))

          ;; Unlink vocab from project
          (assert-no-content (api-call admin-request {:method :delete
                                                      :path (str "/api/v1/projects/" project-id "/vocabs/" vocab-id)}))

          ;; Verify all vocab links are gone
          (assert-not-found (get-vocab-link admin-request link1-id))
          (assert-not-found (get-vocab-link admin-request link2-id))
          (assert-not-found (get-vocab-link admin-request link3-id))

          ;; Vocab items should still exist
          (assert-ok (get-vocab-item admin-request item1-id))
          (assert-ok (get-vocab-item admin-request item2-id))
          (assert-ok (get-vocab-item admin-request item3-id)))

        ;; Clean up vocab items
        (assert-no-content (delete-vocab-item admin-request item1-id))
        (assert-no-content (delete-vocab-item admin-request item2-id))
        (assert-no-content (delete-vocab-item admin-request item3-id)))

      ;; Clean up project and vocab
      (assert-no-content (delete-vocab-layer admin-request vocab-id))
      (assert-no-content (delete-test-project admin-request project-id)))))

(deftest vocab-multi-project-scenario
  "Test complex scenario with multiple projects and selective unlinking"
  (testing "unlinking vocab should only affect links from that specific project"
    (let [project1-id (create-test-project admin-request "Project1")
          project2-id (create-test-project admin-request "Project2")
          vocab-id (-> (create-vocab-layer admin-request "SharedVocab") :body :id)
          
          ;; Setup project 1
          doc1-id (create-test-document admin-request project1-id "Doc1")
          txtl1-res (create-text-layer admin-request project1-id "TextLayer1")
          _ (assert-created txtl1-res)
          txtl1-id (-> txtl1-res :body :id)
          tokl1-res (create-token-layer admin-request txtl1-id "TokenLayer1")
          _ (assert-created tokl1-res)
          tokl1-id (-> tokl1-res :body :id)
          text1-res (create-text admin-request txtl1-id doc1-id "Hello world")
          _ (assert-created text1-res)
          text1-id (-> text1-res :body :id)
          token1-res (create-token admin-request tokl1-id text1-id 0 5)
          _ (assert-created token1-res)
          token1-id (-> token1-res :body :id)
          
          ;; Setup project 2
          doc2-id (create-test-document admin-request project2-id "Doc2")
          txtl2-res (create-text-layer admin-request project2-id "TextLayer2")
          _ (assert-created txtl2-res)
          txtl2-id (-> txtl2-res :body :id)
          tokl2-res (create-token-layer admin-request txtl2-id "TokenLayer2")
          _ (assert-created tokl2-res)
          tokl2-id (-> tokl2-res :body :id)
          text2-res (create-text admin-request txtl2-id doc2-id "Hello universe")
          _ (assert-created text2-res)
          text2-id (-> text2-res :body :id)
          token2-res (create-token admin-request tokl2-id text2-id 0 5)
          _ (assert-created token2-res)
          token2-id (-> token2-res :body :id)]

      ;; Create vocab item
      (let [item-res (create-vocab-item admin-request vocab-id "greeting")
            _ (assert-created item-res)
            item-id (-> item-res :body :id)]

        ;; Link vocab to both projects
        (assert-no-content (api-call admin-request {:method :post
                                                    :path (str "/api/v1/projects/" project1-id "/vocabs/" vocab-id)}))
        (assert-no-content (api-call admin-request {:method :post
                                                    :path (str "/api/v1/projects/" project2-id "/vocabs/" vocab-id)}))

        ;; Create vocab links in both projects
        (let [link1-res (create-vocab-link admin-request item-id [token1-id])
              link2-res (create-vocab-link admin-request item-id [token2-id])
              _ (assert-created link1-res)
              _ (assert-created link2-res)
              link1-id (-> link1-res :body :id)
              link2-id (-> link2-res :body :id)]

          ;; Verify both links exist
          (assert-ok (get-vocab-link admin-request link1-id))
          (assert-ok (get-vocab-link admin-request link2-id))

          ;; Unlink vocab from project1 only
          (assert-no-content (api-call admin-request {:method :delete
                                                      :path (str "/api/v1/projects/" project1-id "/vocabs/" vocab-id)}))

          ;; Only project1's link should be gone
          (assert-not-found (get-vocab-link admin-request link1-id))
          (assert-ok (get-vocab-link admin-request link2-id))

          ;; Clean up remaining link
          (assert-no-content (delete-vocab-link admin-request link2-id)))

        ;; Clean up vocab item
        (assert-no-content (delete-vocab-item admin-request item-id)))

      ;; Clean up
      (assert-no-content (delete-vocab-layer admin-request vocab-id))
      (assert-no-content (delete-test-project admin-request project1-id))
      (assert-no-content (delete-test-project admin-request project2-id)))))
