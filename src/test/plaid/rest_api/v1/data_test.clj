(ns plaid.rest-api.v1.data-test
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-xtdb with-rest-handler with-admin with-test-users admin-request api-call assert-status assert-created assert-ok assert-no-content assert-not-found assert-bad-request]]))

(use-fixtures :once with-xtdb with-rest-handler with-admin with-test-users)

;; Helper functions for creating layers and documents
(defn- create-test-project [request-fn name]
  (let [res (api-call request-fn {:method :post :path "/api/v1/projects" :body {:name name}})]
    (assert-created res)
    (-> res :body :id)))

(defn- create-document [request-fn project-id name]
  (let [res (api-call request-fn {:method :post :path "/api/v1/documents" :body {:project-id project-id :name name}})]
    (assert-created res)
    (-> res :body :id)))

(defn- create-text-layer [request-fn project-id name]
  (let [res (api-call request-fn {:method :post :path "/api/v1/text-layers" :body {:project-id project-id :name name}})]
    (assert-created res)
    (-> res :body :id)))

(defn- create-token-layer [request-fn text-layer-id name]
  (let [res (api-call request-fn {:method :post :path "/api/v1/token-layers" :body {:text-layer-id text-layer-id :name name}})]
    (assert-created res)
    (-> res :body :id)))

(defn- create-span-layer [request-fn token-layer-id name]
  (let [res (api-call request-fn {:method :post :path "/api/v1/span-layers" :body {:token-layer-id token-layer-id :name name}})]
    (assert-created res)
    (-> res :body :id)))

(defn- create-relation-layer [request-fn span-layer-id name]
  (let [res (api-call request-fn {:method :post :path "/api/v1/relation-layers" :body {:span-layer-id span-layer-id :name name}})]
    (assert-created res)
    (-> res :body :id)))

(deftest text-crud-and-uniqueness
  (let [proj (create-test-project admin-request "DataProj")
        doc (create-document admin-request proj "Doc1")
        tl (create-text-layer admin-request proj "TL1")
        ;; create text
        res1 (api-call admin-request {:method :post :path "/api/v1/texts" :body {:text-layer-id tl :document-id doc :body "foo"}})
        tid (-> res1 :body :id)]
    (assert-created res1)
    ;; cannot create second text on same layer+doc
    (let [res2 (api-call admin-request {:method :post :path "/api/v1/texts" :body {:text-layer-id tl :document-id doc :body "bar"}})]
      (assert-status 409 res2))
    ;; get, patch, delete
    (assert-ok (api-call admin-request {:method :get :path (str "/api/v1/texts/" tid)}))
    (assert-ok (api-call admin-request {:method :patch :path (str "/api/v1/texts/" tid) :body {:body "baz"}}))
    (let [res3 (api-call admin-request {:method :get :path (str "/api/v1/texts/" tid)})]
      (assert-ok res3)
      (is (= "baz" (-> res3 :body :text/body))))
    (assert-no-content (api-call admin-request {:method :delete :path (str "/api/v1/texts/" tid)}))
    (assert-not-found (api-call admin-request {:method :get :path (str "/api/v1/texts/" tid)}))))

(deftest token-crud-and-validation
  (let [proj (create-test-project admin-request "TknProj")
        doc (create-document admin-request proj "Doc2")
        tl (create-text-layer admin-request proj "TL2")
        tr (api-call admin-request {:method :post :path "/api/v1/texts" :body {:text-layer-id tl :document-id doc :body "hello"}})
        tid (-> tr :body :id)
        tkl (create-token-layer admin-request tl "TokenL")
        ;; valid token
        r1 (api-call admin-request {:method :post :path "/api/v1/tokens" :body {:token-layer-id tkl :text-id tid :begin 0 :end 5}})
        tokid (-> r1 :body :id)]
    (assert-created r1)
    ;; invalid begin > end
    (let [r2 (api-call admin-request {:method :post :path "/api/v1/tokens" :body {:token-layer-id tkl :text-id tid :begin 6 :end 1}})]
      (assert-bad-request r2))
    ;; get, patch, delete
    (assert-ok (api-call admin-request {:method :get :path (str "/api/v1/tokens/" tokid)}))
    (assert-ok (api-call admin-request {:method :patch :path (str "/api/v1/tokens/" tokid) :body {:begin 1 :end 4}}))
    (let [r3 (api-call admin-request {:method :get :path (str "/api/v1/tokens/" tokid)})]
      (assert-ok r3)
      (is (= 1 (-> r3 :body :token/begin)))
      (is (= 4 (-> r3 :body :token/end))))
    (assert-no-content (api-call admin-request {:method :delete :path (str "/api/v1/tokens/" tokid)}))
    (assert-not-found (api-call admin-request {:method :get :path (str "/api/v1/tokens/" tokid)}))))

(deftest span-crud-and-invariants
  (let [proj (create-test-project admin-request "SpanProj")
        doc (create-document admin-request proj "Doc3")
        tl (create-text-layer admin-request proj "TL3")
        tr (api-call admin-request {:method :post :path "/api/v1/texts" :body {:text-layer-id tl :document-id doc :body "abc"}})
        tid (-> tr :body :id)
        tkl (create-token-layer admin-request tl "TokenL2")
        tk1 (api-call admin-request {:method :post :path "/api/v1/tokens" :body {:token-layer-id tkl :text-id tid :begin 0 :end 1}})
        id1 (-> tk1 :body :id)
        tk2 (api-call admin-request {:method :post :path "/api/v1/tokens" :body {:token-layer-id tkl :text-id tid :begin 1 :end 3}})
        id2 (-> tk2 :body :id)
        sl (create-span-layer admin-request tkl "SL2")
        ;; valid span
        r1 (api-call admin-request {:method :post :path "/api/v1/spans" :body {:span-layer-id sl :tokens [id1 id2] :value "v"}})
        sid (-> r1 :body :id)]
    (assert-created r1)
    ;; invalid: empty tokens
    (let [r2 (api-call admin-request {:method :post :path "/api/v1/spans" :body {:span-layer-id sl :tokens [] :value "v"}})]
      (assert-bad-request r2))
    ;; get, patch, replace tokens, delete
    (assert-ok (api-call admin-request {:method :get :path (str "/api/v1/spans/" sid)}))
    (assert-ok (api-call admin-request {:method :patch :path (str "/api/v1/spans/" sid) :body {:value "w"}}))
    (assert-ok (api-call admin-request {:method :put :path (str "/api/v1/spans/" sid "/tokens") :body {:tokens [id2]}}))
    (let [r3 (api-call admin-request {:method :get :path (str "/api/v1/spans/" sid)})]
      (assert-ok r3)
      (is (= [id2] (-> r3 :body :span/tokens))))
    (assert-no-content (api-call admin-request {:method :delete :path (str "/api/v1/spans/" sid)}))
    (assert-not-found (api-call admin-request {:method :get :path (str "/api/v1/spans/" sid)}))))

(deftest relation-crud-and-invariants
  (let [proj (create-test-project admin-request "RelProj")
        doc (create-document admin-request proj "Doc4")
        tl (create-text-layer admin-request proj "TL4")
        tr (api-call admin-request {:method :post :path "/api/v1/texts" :body {:text-layer-id tl :document-id doc :body "abcdef"}})
        tid (-> tr :body :id)
        tkl (create-token-layer admin-request tl "TokenL3")
        id1 (-> (api-call admin-request {:method :post :path "/api/v1/tokens" :body {:token-layer-id tkl :text-id tid :begin 0 :end 2}}) :body :id)
        id2 (-> (api-call admin-request {:method :post :path "/api/v1/tokens" :body {:token-layer-id tkl :text-id tid :begin 2 :end 4}}) :body :id)
        sl (create-span-layer admin-request tkl "SL3")
        sid1 (-> (api-call admin-request {:method :post :path "/api/v1/spans" :body {:span-layer-id sl :tokens [id1] :value "A"}}) :body :id)
        sid2 (-> (api-call admin-request {:method :post :path "/api/v1/spans" :body {:span-layer-id sl :tokens [id2] :value "B"}}) :body :id)
        rl (create-relation-layer admin-request sl "RL3")
        ;; valid relation
        r1 (api-call admin-request {:method :post :path "/api/v1/relations" :body {:layer-id rl :source-id sid1 :target-id sid2 :value "R"}})
        rid (-> r1 :body :id)]
    (assert-created r1)
    ;; get, patch value, update source/target, delete
    (assert-ok (api-call admin-request {:method :get :path (str "/api/v1/relations/" rid)}))
    (assert-ok (api-call admin-request {:method :patch :path (str "/api/v1/relations/" rid) :body {:value "X"}}))
    (assert-ok (api-call admin-request {:method :put :path (str "/api/v1/relations/" rid "/source") :body {:span-id sid2}}))
    (assert-ok (api-call admin-request {:method :put :path (str "/api/v1/relations/" rid "/target") :body {:span-id sid1}}))
    (assert-no-content (api-call admin-request {:method :delete :path (str "/api/v1/relations/" rid)}))
    (assert-not-found (api-call admin-request {:method :get :path (str "/api/v1/relations/" rid)}))))