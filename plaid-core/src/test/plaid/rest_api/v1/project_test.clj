(ns plaid.rest-api.v1.project-test
  (:require [clojure.test :refer :all]
            [clojure.string]
            [ring.mock.request :as mock]
            [plaid.fixtures :refer [with-db
                                    with-mount-states
                                    with-rest-handler
                                    rest-handler
                                    with-admin
                                    with-test-users
                                    admin-token
                                    user1-token
                                    user2-token
                                    admin-request
                                    user1-request
                                    user2-request
                                    ;; API helpers
                                    parse-response-body
                                    api-call
                                    ;; Assertion helpers
                                    assert-status
                                    assert-success
                                    assert-created
                                    assert-ok
                                    assert-no-content
                                    assert-not-found
                                    assert-forbidden
                                    assert-bad-request with-clean-db]]
            [plaid.test-helpers :refer [create-test-project delete-test-project
                                        create-test-document
                                        create-text-layer create-token-layer
                                        create-span-layer create-relation-layer]]
            [plaid.fixtures :as fix]
            [plaid.sql.project :as prj]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

;; Project API Endpoint Functions
(defn create-project
  "Create a new project"
  [user-request-fn project-data]
  (api-call user-request-fn {:method :post
                             :path "/api/v1/projects"
                             :body project-data}))

(defn list-projects
  "List all projects"
  [user-request-fn]
  (api-call user-request-fn {:method :get
                             :path "/api/v1/projects"}))

(defn get-project
  "Get a project by ID"
  [user-request-fn project-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/projects/" project-id)}))

(defn update-project
  "Update a project"
  [user-request-fn project-id project-data]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/projects/" project-id)
                             :body project-data}))

(defn delete-project
  "Delete a project"
  [user-request-fn project-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/projects/" project-id)}))

;; Project Access Management Functions
(defn add-reader
  "Add reader access to a project"
  [user-request-fn project-id user-id]
  (api-call user-request-fn {:method :post
                             :path (str "/api/v1/projects/" project-id "/readers/" user-id)}))

(defn remove-reader
  "Remove reader access from a project"
  [user-request-fn project-id user-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/projects/" project-id "/readers/" user-id)}))

(defn add-writer
  "Add writer access to a project"
  [user-request-fn project-id user-id]
  (api-call user-request-fn {:method :post
                             :path (str "/api/v1/projects/" project-id "/writers/" user-id)}))

(defn remove-writer
  "Remove writer access from a project"
  [user-request-fn project-id user-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/projects/" project-id "/writers/" user-id)}))

(defn add-maintainer
  "Add maintainer access to a project"
  [user-request-fn project-id user-id]
  (api-call user-request-fn {:method :post
                             :path (str "/api/v1/projects/" project-id "/maintainers/" user-id)}))

(defn remove-maintainer
  "Remove maintainer access from a project"
  [user-request-fn project-id user-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/projects/" project-id "/maintainers/" user-id)}))

;; Layer Configuration Functions
(defn set-layer-config
  "Set layer configuration"
  [user-request-fn layer-id editor key value]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/projects/layers/" layer-id "/config/" editor "/" key)
                             :body value}))

(defn remove-layer-config
  "Remove layer configuration"
  [user-request-fn layer-id editor key]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/projects/layers/" layer-id "/config/" editor "/" key)}))

(deftest creator-registered-as-maintainer
  ;; Regression: the SQL port's project/create dropped the
  ;; :project/maintainers grant, so a non-admin who created a project was
  ;; NOT made its maintainer and got 403 adding layers to their own
  ;; project. Existing tests missed it because they build via admin
  ;; (admin bypasses ACL). The route summary promises "also registers the
  ;; user as a maintainer".
  (testing "a non-admin creator becomes maintainer and can add layers"
    (let [pid (create-test-project user1-request "User1OwnedProject")]
      (testing "creator can create a text layer in their own project (was 403)"
        (assert-created (create-text-layer user1-request pid "TL")))
      (testing "project reports the creator as a maintainer"
        (let [proj (prj/get fix/db pid)]
          (is (contains? (set (:project/maintainers proj)) "user1@example.com"))
          (is (empty? (:project/readers proj)))
          (is (empty? (:project/writers proj))))))))

(deftest project-crud-operations
  (testing "Project creation and retrieval"
    (testing "Create project succeeds"
      (let [response (create-project admin-request {:name "Test Project"})]
        (assert-created response)
        (is (contains? (:body response) :id))
        (is (uuid? (-> response :body :id)))))

    (testing "List all projects"
      ;; Create a couple test projects first
      (create-project admin-request {:name "List Test Project 1"})
      (create-project admin-request {:name "List Test Project 2"})
      (let [response (list-projects admin-request)]
        (assert-ok response)
        (is (vector? (:entries (:body response))))
        (is (>= (count (:entries (:body response))) 2))))

    (testing "Get project by ID"
      (let [create-response (create-project admin-request {:name "Get Test Project"})
            project-id (-> create-response :body :id)
            get-response (get-project admin-request project-id)]
        (assert-ok get-response)
        (is (= (-> get-response :body :project/name) "Get Test Project"))
        (is (= (-> get-response :body :project/id) project-id))
        ;; The `?include-documents` param was removed; GET /projects/:id must
        ;; NOT carry an embedded document list anymore (documents live at the
        ;; dedicated GET /projects/:id/documents endpoint).
        (is (not (contains? (:body get-response) :project/documents))
            "single-project GET must not embed :project/documents")))

    (testing "Get project by invalid ID returns 404"
      (let [fake-id (str (java.util.UUID/randomUUID))
            response (get-project admin-request fake-id)]
        (assert-not-found response)))

    (testing "Update project name"
      (let [create-response (create-project admin-request {:name "Original Name"})
            project-id (-> create-response :body :id)
            update-response (update-project admin-request project-id {:name "Updated Name"})]
        (assert-ok update-response)
        (is (= "Updated Name" (-> update-response :body :project/name))
            "PATCH response body should reflect the new name")
        ;; Confirm the change actually persisted via an independent read-back
        (let [get-response (get-project admin-request project-id)]
          (assert-ok get-response)
          (is (= "Updated Name" (-> get-response :body :project/name))
              "Updated name should persist across a fresh GET"))))

    (testing "Delete project"
      (let [create-response (create-project admin-request {:name "To Be Deleted"})
            project-id (-> create-response :body :id)
            delete-response (delete-project admin-request project-id)
            get-response (get-project admin-request project-id)]
        (assert-no-content delete-response)
        (assert-not-found get-response)))

    (testing "Delete non-existent project returns 404"
      (let [fake-id (str (java.util.UUID/randomUUID))
            response (delete-project admin-request fake-id)]
        (assert-not-found response)))))

(deftest access-management-operations
  (let [create-response (create-project admin-request {:name "Access Test Project"})
        project-id (-> create-response :body :id)]

    (testing "Add reader access"
      (let [response (add-reader admin-request project-id "user1@example.com")]
        (assert-no-content response)))

    (testing "Remove reader access"
      (let [response (remove-reader admin-request project-id "user1@example.com")]
        (assert-no-content response)))

    (testing "Add writer access"
      (let [response (add-writer admin-request project-id "user1@example.com")]
        (assert-no-content response)))

    (testing "Remove writer access"
      (let [response (remove-writer admin-request project-id "user1@example.com")]
        (assert-no-content response)))

    (testing "Add maintainer access"
      (let [response (add-maintainer admin-request project-id "user1@example.com")]
        (assert-no-content response)))

    (testing "Remove maintainer access"
      ;; Task #100 V4: removing user1 here would leave the project
      ;; with zero maintainers, which is now blocked. Add user2 as a
      ;; co-maintainer first so the removal is non-orphaning.
      (assert-no-content
       (add-maintainer admin-request project-id "user2@example.com"))
      (let [response (remove-maintainer admin-request project-id "user1@example.com")]
        (assert-no-content response)))

    (testing "Access management fails with invalid user ID"
      (let [response (add-reader admin-request project-id "nonexistent@example.com")]
        (assert-status 400 response)))

    (testing "Access management fails with invalid project ID"
      (let [fake-id (str (java.util.UUID/randomUUID))
            response (add-reader admin-request fake-id "user1@example.com")]
        (assert-status 400 response)))))

(deftest cross-user-access-tests
  (testing "User access permissions"
    (let [create-response (create-project admin-request {:name "Cross User Test Project"})
          project-id (-> create-response :body :id)]

      (testing "User1 cannot access project without permissions"
        (let [response (get-project user1-request project-id)]
          (assert-forbidden response)))

      (testing "Grant User1 reader access"
        (let [response (add-reader admin-request project-id "user1@example.com")]
          (assert-no-content response)))

      (testing "User1 can now read project"
        (let [response (get-project user1-request project-id)]
          (assert-ok response)
          (is (= (-> response :body :project/name) "Cross User Test Project"))))

      (testing "User1 cannot update project with only reader access"
        (let [response (update-project user1-request project-id {:name "Attempted Update"})]
          (assert-forbidden response)))

      (testing "Grant User1 maintainer access"
        (let [response (add-maintainer admin-request project-id "user1@example.com")]
          (assert-no-content response)))

      (testing "User1 can now update project"
        (let [response (update-project user1-request project-id {:name "User1 Updated"})]
          (assert-ok response)))

      (testing "User1 cannot manage access with only writer permission"
        (let [_ (add-writer admin-request project-id "user1@example.com")
              response (add-reader user1-request project-id "user2@example.com")]
          (assert-forbidden response)))

      (testing "Grant User1 maintainer access"
        (let [response (add-maintainer admin-request project-id "user1@example.com")]
          (assert-no-content response)))

      (testing "User1 can now manage access"
        ;; user1 is a maintainer (granted just above), so adding user2 as a
        ;; reader must succeed — and user2 must actually land in the readers list.
        (let [response (add-reader user1-request project-id "user2@example.com")]
          (assert-no-content response)
          (let [project (get-project admin-request project-id)]
            (assert-ok project)
            (is (contains? (set (-> project :body :project/readers)) "user2@example.com")
                "user2 should appear in the project's readers after the grant")))))))

(deftest layer-config-operations
  (testing "Layer configuration management"
    (let [fake-layer-id (str (java.util.UUID/randomUUID))]

      (testing "Set layer config fails with invalid layer ID"
        (let [response (set-layer-config admin-request fake-layer-id "test-editor" "test-key" "test-value")]
          (assert-not-found response)))

      (testing "Remove layer config fails with invalid layer ID"
        (let [response (remove-layer-config admin-request fake-layer-id "test-editor" "test-key")]
          (assert-not-found response))))))

(defn- get-text-layer [user-request-fn text-layer-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/text-layers/" text-layer-id)}))

(defn- get-token-layer [user-request-fn token-layer-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/token-layers/" token-layer-id)}))

(defn- get-span-layer [user-request-fn span-layer-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/span-layers/" span-layer-id)}))

(defn- get-relation-layer [user-request-fn relation-layer-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/relation-layers/" relation-layer-id)}))

(defn- set-typed-layer-config
  "Set config on a specific layer type. Config endpoints are nested under each layer type's path."
  [user-request-fn layer-type layer-id editor key value]
  (let [base-path (case layer-type
                    :text-layer (str "/api/v1/text-layers/" layer-id)
                    :token-layer (str "/api/v1/token-layers/" layer-id)
                    :span-layer (str "/api/v1/span-layers/" layer-id)
                    :relation-layer (str "/api/v1/relation-layers/" layer-id)
                    :vocab-layer (str "/api/v1/vocab-layers/" layer-id)
                    :project (str "/api/v1/projects/" layer-id))]
    (api-call user-request-fn {:method :put
                               :path (str base-path "/config/" editor "/" key)
                               :body value})))

(defn- remove-typed-layer-config
  "Remove config from a specific layer type."
  [user-request-fn layer-type layer-id editor key]
  (let [base-path (case layer-type
                    :text-layer (str "/api/v1/text-layers/" layer-id)
                    :token-layer (str "/api/v1/token-layers/" layer-id)
                    :span-layer (str "/api/v1/span-layers/" layer-id)
                    :relation-layer (str "/api/v1/relation-layers/" layer-id)
                    :vocab-layer (str "/api/v1/vocab-layers/" layer-id)
                    :project (str "/api/v1/projects/" layer-id))]
    (api-call user-request-fn {:method :delete
                               :path (str base-path "/config/" editor "/" key)})))

(deftest layer-config-round-trip
  (testing "Config with mixed-case keys round-trips correctly through all layer types"
    (let [project-id (create-test-project admin-request "Config Round Trip Project")
          txtl-id (-> (create-text-layer admin-request project-id "CfgTxtL") :body :id)
          tokl-id (-> (create-token-layer admin-request txtl-id "CfgTokL") :body :id)
          sl-id (-> (create-span-layer admin-request tokl-id "CfgSL") :body :id)
          rl-id (-> (create-relation-layer admin-request sl-id "CfgRL") :body :id)]

      (testing "Set config with mixed-case keys on each layer type"
        ;; Use camelCase and PascalCase keys — these would be lowercased
        ;; by XTDB v2 if not serialized as JSON strings
        (assert-no-content (set-typed-layer-config admin-request :text-layer txtl-id "MyEditor" "tokenMode" "word"))
        (assert-no-content (set-typed-layer-config admin-request :token-layer tokl-id "AnnotationTool" "displayName" "Morpheme"))
        (assert-no-content (set-typed-layer-config admin-request :span-layer sl-id "SpanViewer" "colorScheme" "dark"))
        (assert-no-content (set-typed-layer-config admin-request :relation-layer rl-id "RelGraph" "layoutMode" "hierarchical")))

      (testing "Config preserved when reading individual layers"
        (let [txtl-body (-> (get-text-layer admin-request txtl-id) :body)
              tokl-body (-> (get-token-layer admin-request tokl-id) :body)
              sl-body (-> (get-span-layer admin-request sl-id) :body)
              rl-body (-> (get-relation-layer admin-request rl-id) :body)]
          (is (= "word" (get-in txtl-body [:config "MyEditor" "tokenMode"]))
              "TextLayer config should preserve camelCase keys")
          (is (= "Morpheme" (get-in tokl-body [:config "AnnotationTool" "displayName"]))
              "TokenLayer config should preserve PascalCase editor name and camelCase key")
          (is (= "dark" (get-in sl-body [:config "SpanViewer" "colorScheme"]))
              "SpanLayer config should preserve mixed-case keys")
          (is (= "hierarchical" (get-in rl-body [:config "RelGraph" "layoutMode"]))
              "RelationLayer config should preserve mixed-case keys")))

      (testing "Config preserved in nested project GET response"
        (let [project-body (-> (get-project admin-request project-id) :body)
              nested-txtl (first (:project/text-layers project-body))
              nested-tokl (first (:text-layer/token-layers nested-txtl))
              nested-sl (first (:token-layer/span-layers nested-tokl))
              nested-rl (first (:span-layer/relation-layers nested-sl))]
          (is (= "word" (get-in nested-txtl [:config "MyEditor" "tokenMode"]))
              "Nested text layer config should preserve key casing")
          (is (= "Morpheme" (get-in nested-tokl [:config "AnnotationTool" "displayName"]))
              "Nested token layer config should preserve key casing")
          (is (= "dark" (get-in nested-sl [:config "SpanViewer" "colorScheme"]))
              "Nested span layer config should preserve key casing")
          (is (= "hierarchical" (get-in nested-rl [:config "RelGraph" "layoutMode"]))
              "Nested relation layer config should preserve key casing")))

      (testing "Config survives set, remove, set cycle on project"
        (assert-no-content (set-typed-layer-config admin-request :project project-id "TestEditor" "camelKey" "value1"))
        (assert-no-content (set-typed-layer-config admin-request :project project-id "TestEditor" "secondKey" "value2"))
        (assert-no-content (remove-typed-layer-config admin-request :project project-id "TestEditor" "camelKey"))
        (let [project-body (-> (get-project admin-request project-id) :body)]
          (is (nil? (get-in project-body [:config "TestEditor" "camelKey"]))
              "Removed key should be gone")
          (is (= "value2" (get-in project-body [:config "TestEditor" "secondKey"]))
              "Other key should still be present")))

      (delete-test-project admin-request project-id))))

(deftest access-management-edge-cases
  (let [create-response (create-project admin-request {:name "Edge Case Project"})
        project-id (-> create-response :body :id)]

    (testing "Adding duplicate reader access is idempotent"
      (let [response1 (add-reader admin-request project-id "user1@example.com")
            response2 (add-reader admin-request project-id "user1@example.com")]
        (assert-no-content response1)
        (assert-no-content response2)))

    (testing "Removing access for a non-existent user returns 400"
      (let [response (remove-reader admin-request project-id "nonexistent@example.com")]
        (assert-status 400 response)))

    (testing "Removing reader access from a valid non-member is idempotent (204)"
      ;; user2 was never granted any role on this project, so removing it is a
      ;; harmless no-op that should still succeed.
      (let [response (remove-reader admin-request project-id "user2@example.com")]
        (assert-no-content response)))

    (testing "Access operations require maintainer permissions"
      ;; Grant user1 only writer access, not maintainer
      (add-writer admin-request project-id "user1@example.com")
      (let [response (add-reader user1-request project-id "user2@example.com")]
        (assert-forbidden response)))))

(deftest authorization-edge-cases
  (testing "Non-maintainer cannot perform CRUD operations on projects they don't own"
    (let [create-response (create-project admin-request {:name "Admin Project"})
          project-id (-> create-response :body :id)]

      (testing "User1 cannot delete project without permissions"
        (let [response (delete-project user1-request project-id)]
          (assert-forbidden response)))

      (testing "User1 cannot update project without permissions"
        (let [response (update-project user1-request project-id {:name "Hacked Name"})]
          (assert-forbidden response))))))

(deftest get-accessible-shape-matches-get
  ;; Regression guard for Task #54: `get-accessible` was rewritten from
  ;; an N+1 `(mapv #(get db %) ids)` into a batched hydrator. The REST
  ;; consumer iterates the hydrated records and serializes them, so any
  ;; shape drift breaks `GET /projects`. Build a project with the full
  ;; layer stack + multi-role ACL + vocab grant, then assert that the
  ;; batched hydrator returns the *exact* per-id map shape that `get`
  ;; returns.
  (testing "batched get-accessible per-project entry equals (get db id)"
    (let [;; Create a project with text/token/span/relation layers
          project-id (-> (create-project admin-request {:name "Shape Parity Project"})
                         :body :id)
          text-layer-id (-> (create-text-layer admin-request project-id "TL")
                            :body :id)
          token-layer-id (-> (create-token-layer admin-request text-layer-id "TokL")
                             :body :id)
          span-layer-id (-> (create-span-layer admin-request token-layer-id "SL")
                            :body :id)
          _ (-> (create-relation-layer admin-request span-layer-id "RL") :body :id)
          ;; ACL: user1 reader, user2 writer (admin retains implicit access)
          _ (add-reader admin-request project-id "user1@example.com")
          _ (add-writer admin-request project-id "user2@example.com")
          _ (add-maintainer admin-request project-id "user1@example.com")
          db fix/db
          ;; The single-id read path
          single (prj/get db project-id)
          ;; The batched read path — admin sees everything, so this
          ;; project must appear in the result.
          batched-list (prj/get-accessible db "admin@example.com")
          batched (first (filter #(= (:project/id %) project-id) batched-list))]
      (is (some? single)
          "single-id get should return a project map")
      (is (some? batched)
          "batched get-accessible should include the project")
      ;; Shape equality — keys, ACL vectors, layer tree, vocab grants,
      ;; config blob. Layer vectors are order-sensitive (order_idx).
      (is (= (set (keys single))
             (disj (set (keys batched)) :project/document-count :project/last-modified))
          "batched list keys = single-get keys plus the list-view summary fields")
      (is (= (:project/id single) (:project/id batched)))
      (is (= (:project/name single) (:project/name batched)))
      (is (= (:config single) (:config batched)))
      (is (= (set (:project/readers single)) (set (:project/readers batched))))
      (is (= (set (:project/writers single)) (set (:project/writers batched))))
      (is (= (set (:project/maintainers single)) (set (:project/maintainers batched))))
      (is (= (:project/text-layers single) (:project/text-layers batched))
          "nested layer tree must be identical (order_idx preserved)")
      (is (= (:project/vocabs single) (:project/vocabs batched)))))

  (testing "get-accessible always returns a vector"
    ;; The empty-ids early-out must preserve the vector return type so the
    ;; REST consumer can iterate / serialize without lazy-seq surprises.
    (let [db fix/db
          result (prj/get-accessible db "user2@example.com")]
      (is (vector? result)
          "get-accessible must return a vector (not a lazy seq)"))))

(deftest list-view-summary-fields
  (testing "get-accessible carries per-project document-count + last-modified"
    (let [db fix/db
          pid (create-test-project admin-request "ListSummary")
          _ (create-test-document admin-request pid "doc-a")
          _ (create-test-document admin-request pid "doc-b")
          proj (->> (prj/get-accessible db "admin@example.com")
                    (filter #(= (:project/id %) pid)) first)
          empty-proj-id (create-test-project admin-request "NoDocs")
          empty-proj (->> (prj/get-accessible db "admin@example.com")
                          (filter #(= (:project/id %) empty-proj-id)) first)]
      (is (= 2 (:project/document-count proj)) "two documents")
      (is (some? (:project/last-modified proj)) "last-modified is set")
      (is (= 0 (:project/document-count empty-proj)) "no docs -> count 0")
      (is (nil? (:project/last-modified empty-proj)) "no docs -> nil last-modified")))
  (testing "get-documents-page stubs carry version + timestamps"
    (let [db fix/db
          pid (create-test-project admin-request "DocStubs")
          _ (create-test-document admin-request pid "only-doc")
          page (prj/get-documents-page db pid {:limit 10 :cursor-vals nil})
          stub (first (:entries page))]
      (is (contains? stub :document/version))
      (is (contains? stub :document/time-created))
      (is (contains? stub :document/time-modified))
      (is (= "only-doc" (:document/name stub))))))

(deftest validation-routes-through-submit-operation-catch
  ;; Regression test for task #47: pre-flight validations (valid-name?,
  ;; validate-atomic-value!, body-shape checks, etc.) used to throw OUTSIDE
  ;; the submit-operation! macro body, escaping past its catch and producing
  ;; raw 500s at the REST layer. Now the outer try/catch in
  ;; submit-operation* — combined with validations moved INTO the macro
  ;; body — projects them to {:success false :code 400}.
  (testing "Project create with empty name returns 400, not 500"
    ;; valid-name? rejects empty strings. Before #47, this threw past the
    ;; macro and surfaced as Ring's default 500.
    (let [response (create-project admin-request {:name ""})]
      (assert-bad-request response)))

  (testing "Project create with non-string name returns 400, not 500"
    ;; valid-name? rejects non-strings with code 400. We have to bypass the
    ;; coercion layer to hit this — call the function directly.
    (let [db fix/db
          result (prj/create db {:project/name 42} "admin@example.com")]
      (is (= false (:success result)))
      (is (= 400 (:code result)))
      (is (string? (:error result)))))

  (testing "Project merge with empty name returns 400, not 500"
    (let [create-resp (create-project admin-request {:name "validation-merge-test"})
          pid (-> create-resp :body :id)
          db fix/db
          result (prj/merge db pid {:project/name ""} "admin@example.com")]
      (is (= false (:success result)))
      (is (= 400 (:code result))))))
