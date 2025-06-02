(ns plaid.rest-api.v1.layers-test
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

;; Text Layer API Helper Functions
(defn- create-text-layer [user-request-fn project-id name]
  (api-call user-request-fn {:method :post
                             :path   "/api/v1/text-layers"
                             :body   {:project-id project-id :name name}}))

(defn- get-text-layer [user-request-fn text-layer-id]
  (api-call user-request-fn {:method :get
                             :path   (str "/api/v1/text-layers/" text-layer-id)}))

(defn- update-text-layer [user-request-fn text-layer-id new-name]
  (api-call user-request-fn {:method :patch
                             :path   (str "/api/v1/text-layers/" text-layer-id)
                             :body   {:name new-name}}))

(defn- delete-text-layer [user-request-fn text-layer-id]
  (api-call user-request-fn {:method :delete
                             :path   (str "/api/v1/text-layers/" text-layer-id)}))

(defn- shift-text-layer [user-request-fn text-layer-id direction]
  (api-call user-request-fn {:method :post
                             :path   (str "/api/v1/text-layers/" text-layer-id "/shift")
                             :body   {:direction direction}}))

;; Token Layer API Helper Functions
(defn- create-token-layer [user-request-fn text-layer-id name]
  (api-call user-request-fn {:method :post
                             :path   "/api/v1/token-layers"
                             :body   {:text-layer-id text-layer-id :name name}}))

(defn- get-token-layer [user-request-fn token-layer-id]
  (api-call user-request-fn {:method :get
                             :path   (str "/api/v1/token-layers/" token-layer-id)}))

(defn- update-token-layer [user-request-fn token-layer-id new-name]
  (api-call user-request-fn {:method :patch
                             :path   (str "/api/v1/token-layers/" token-layer-id)
                             :body   {:name new-name}}))

(defn- delete-token-layer [user-request-fn token-layer-id]
  (api-call user-request-fn {:method :delete
                             :path   (str "/api/v1/token-layers/" token-layer-id)}))

(defn- shift-token-layer [user-request-fn token-layer-id direction]
  (api-call user-request-fn {:method :post
                             :path   (str "/api/v1/token-layers/" token-layer-id "/shift")
                             :body   {:direction direction}}))

;; Span Layer API Helper Functions
(defn- create-span-layer [user-request-fn token-layer-id name]
  (api-call user-request-fn {:method :post
                             :path   "/api/v1/span-layers"
                             :body   {:token-layer-id token-layer-id :name name}}))

(defn- get-span-layer [user-request-fn span-layer-id]
  (api-call user-request-fn {:method :get
                             :path   (str "/api/v1/span-layers/" span-layer-id)}))

(defn- update-span-layer [user-request-fn span-layer-id new-name]
  (api-call user-request-fn {:method :patch
                             :path   (str "/api/v1/span-layers/" span-layer-id)
                             :body   {:name new-name}}))

(defn- delete-span-layer [user-request-fn span-layer-id]
  (api-call user-request-fn {:method :delete
                             :path   (str "/api/v1/span-layers/" span-layer-id)}))

(defn- shift-span-layer [user-request-fn span-layer-id direction]
  (api-call user-request-fn {:method :post
                             :path   (str "/api/v1/span-layers/" span-layer-id "/shift")
                             :body   {:direction direction}}))

;; Relation Layer API Helper Functions
(defn- create-relation-layer [user-request-fn span-layer-id name]
  (api-call user-request-fn {:method :post
                             :path   "/api/v1/relation-layers"
                             :body   {:span-layer-id span-layer-id :name name}}))

(defn- get-relation-layer [user-request-fn relation-layer-id]
  (api-call user-request-fn {:method :get
                             :path   (str "/api/v1/relation-layers/" relation-layer-id)}))

(defn- update-relation-layer [user-request-fn relation-layer-id new-name]
  (api-call user-request-fn {:method :patch
                             :path   (str "/api/v1/relation-layers/" relation-layer-id)
                             :body   {:name new-name}}))

(defn- delete-relation-layer [user-request-fn relation-layer-id]
  (api-call user-request-fn {:method :delete
                             :path   (str "/api/v1/relation-layers/" relation-layer-id)}))

(defn- shift-relation-layer [user-request-fn relation-layer-id direction]
  (api-call user-request-fn {:method :post
                             :path   (str "/api/v1/relation-layers/" relation-layer-id "/shift")
                             :body   {:direction direction}}))


(deftest layer-crud-and-shift-operations
  (let [project-id (create-test-project admin-request "Layer Test Project")]
    (try
      (testing "TextLayer operations"
        (let [create-res (create-text-layer admin-request project-id "Test Text Layer")
              text-layer-id (-> create-res :body :id)
              _ (assert-created create-res)
              _ (is (uuid? text-layer-id) "TextLayer ID should be a UUID")]

          (testing "Get TextLayer"
            (let [get-res (get-text-layer admin-request text-layer-id)]
              (assert-ok get-res)
              (is (= (-> get-res :body :text-layer/name) "Test Text Layer"))))

          (testing "Update TextLayer"
            (let [update-res (update-text-layer admin-request text-layer-id "Updated Text Layer")]
              (assert-ok update-res)
              (is (= (-> update-res :body :text-layer/name) "Updated Text Layer"))))

          (testing "Shift TextLayer"
            (let [text-layer-id-2 (-> (create-text-layer admin-request project-id "Second Text Layer") :body :id)
                  shift-res (shift-text-layer admin-request text-layer-id "down")]
              (assert-no-content shift-res)
              (delete-text-layer admin-request text-layer-id-2))) ; Cleanup

          (testing "Delete TextLayer"
            (assert-no-content (delete-text-layer admin-request text-layer-id))
            (assert-not-found (get-text-layer admin-request text-layer-id)))))

      (testing "TokenLayer operations"
        (let [parent-text-layer-id (-> (create-text-layer admin-request project-id "Parent Text For Token") :body :id)
              create-res (create-token-layer admin-request parent-text-layer-id "Test Token Layer")
              token-layer-id (-> create-res :body :id)
              _ (assert-created create-res)
              _ (is (uuid? token-layer-id) "TokenLayer ID should be a UUID")]

          (testing "Get TokenLayer"
            (let [get-res (get-token-layer admin-request token-layer-id)]
              (assert-ok get-res)
              (is (= (-> get-res :body :token-layer/name) "Test Token Layer"))))

          (testing "Update TokenLayer"
            (let [update-res (update-token-layer admin-request token-layer-id "Updated Token Layer")]
              (assert-ok update-res)
              (is (= (-> update-res :body :token-layer/name) "Updated Token Layer"))))

          (testing "Shift TokenLayer"
            (let [token-layer-id-2 (-> (create-token-layer admin-request parent-text-layer-id "Second Token Layer") :body :id)
                  shift-res (shift-token-layer admin-request token-layer-id "down")]
              (assert-no-content shift-res)
              (delete-token-layer admin-request token-layer-id-2)))

          (testing "Delete TokenLayer"
            (assert-no-content (delete-token-layer admin-request token-layer-id))
            (assert-not-found (get-token-layer admin-request token-layer-id)))
          
          (delete-text-layer admin-request parent-text-layer-id))) ; Cleanup parent

      (testing "SpanLayer operations"
        (let [parent-text-layer-id (-> (create-text-layer admin-request project-id "Parent Text For Span") :body :id)
              parent-token-layer-id (-> (create-token-layer admin-request parent-text-layer-id "Parent Token For Span") :body :id)
              create-res (create-span-layer admin-request parent-token-layer-id "Test Span Layer")
              span-layer-id (-> create-res :body :id)
              _ (assert-created create-res)
              _ (is (uuid? span-layer-id) "SpanLayer ID should be a UUID")]

          (testing "Get SpanLayer"
            (let [get-res (get-span-layer admin-request span-layer-id)]
              (assert-ok get-res)
              (is (= (-> get-res :body :span-layer/name) "Test Span Layer"))))

          (testing "Update SpanLayer"
            (let [update-res (update-span-layer admin-request span-layer-id "Updated Span Layer")]
              (assert-ok update-res)
              (is (= (-> update-res :body :span-layer/name) "Updated Span Layer"))))

          (testing "Shift SpanLayer"
             (let [span-layer-id-2 (-> (create-span-layer admin-request parent-token-layer-id "Second Span Layer") :body :id)
                  shift-res (shift-span-layer admin-request span-layer-id "down")]
              (assert-no-content shift-res)
              (delete-span-layer admin-request span-layer-id-2)))

          (testing "Delete SpanLayer"
            (assert-no-content (delete-span-layer admin-request span-layer-id))
            (assert-not-found (get-span-layer admin-request span-layer-id)))

          (delete-token-layer admin-request parent-token-layer-id) ; Cleanup parents
          (delete-text-layer admin-request parent-text-layer-id)))

      (testing "RelationLayer operations"
        (let [parent-text-layer-id (-> (create-text-layer admin-request project-id "Parent Text For Relation") :body :id)
              parent-token-layer-id (-> (create-token-layer admin-request parent-text-layer-id "Parent Token For Relation") :body :id)
              parent-span-layer-id (-> (create-span-layer admin-request parent-token-layer-id "Parent Span For Relation") :body :id)
              create-res (create-relation-layer admin-request parent-span-layer-id "Test Relation Layer")
              relation-layer-id (-> create-res :body :id)
              _ (assert-created create-res)
              _ (is (uuid? relation-layer-id) "RelationLayer ID should be a UUID")]

          (testing "Get RelationLayer"
            (let [get-res (get-relation-layer admin-request relation-layer-id)]
              (assert-ok get-res)
              (is (= (-> get-res :body :relation-layer/name) "Test Relation Layer"))))

          (testing "Update RelationLayer"
            (let [update-res (update-relation-layer admin-request relation-layer-id "Updated Relation Layer")]
              (assert-ok update-res)
              (is (= (-> update-res :body :relation-layer/name) "Updated Relation Layer"))))
          
          (testing "Shift RelationLayer"
            (let [relation-layer-id-2 (-> (create-relation-layer admin-request parent-span-layer-id "Second Relation Layer") :body :id)
                  shift-res (shift-relation-layer admin-request relation-layer-id "down")]
              (assert-no-content shift-res)
              (delete-relation-layer admin-request relation-layer-id-2)))

          (testing "Delete RelationLayer"
            (assert-no-content (delete-relation-layer admin-request relation-layer-id))
            (assert-not-found (get-relation-layer admin-request relation-layer-id)))

          (delete-span-layer admin-request parent-span-layer-id) ; Cleanup parents
          (delete-token-layer admin-request parent-token-layer-id)
          (delete-text-layer admin-request parent-text-layer-id)))
      (finally
        (delete-test-project admin-request project-id))))) 