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
(defn- create-span [user-request-fn span-layer-id tokens value]
  (api-call user-request-fn {:method :post
                             :path   "/api/v1/spans"
                             :body   {:span-layer-id span-layer-id
                                      :tokens        tokens
                                      :value         value}}))

(defn- get-span [user-request-fn span-id]
  (api-call user-request-fn {:method :get
                             :path   (str "/api/v1/spans/" span-id)}))

(defn- update-span [user-request-fn span-id value]
  (api-call user-request-fn {:method :patch
                             :path   (str "/api/v1/spans/" span-id)
                             :body   {:value value}}))

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
    (assert-ok (update-span admin-request sid "w"))
    (assert-ok (update-span-tokens admin-request sid [id2]))
    (let [r3 (get-span admin-request sid)]
      (assert-ok r3)
      (is (= [id2] (-> r3 :body :span/tokens))))
    (assert-no-content (delete-span admin-request sid))
    (assert-not-found (get-span admin-request sid))))

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
