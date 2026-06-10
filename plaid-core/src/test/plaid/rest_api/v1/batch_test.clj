(ns plaid.rest-api.v1.batch-test
  "REST-level tests for the batch endpoint. The v2-era coordinator state-machine
  tests have been deleted along with the coordinator itself; atomic batch
  semantics now come from JDBC tx scoping, exercised here through the
  /api/v1/batch endpoint."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [clojure.string]
            [ring.mock.request :as mock]
            [plaid.rest-api.v1.batch :as batch]
            [plaid.server.events :as events]
            [plaid.sql.common :as psc]
            [plaid.fixtures :as fixtures
             :refer [with-db
                     with-mount-states
                     with-rest-handler
                     rest-handler
                     with-admin
                     admin-token
                     admin-request
                     parse-response-body with-clean-db]]
            [plaid.test-helpers :as h]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn make-batch-request [operations token]
  (let [req (cond-> (mock/request :post "/api/v1/batch")
              true (mock/header "accept" "application/edn")
              true (mock/json-body operations)
              token (mock/header "authorization" (str "Bearer " token)))]
    (rest-handler req)))

(deftest test-batch-operations
  (let [create-project-req (-> (admin-request :post "/api/v1/projects")
                               (mock/json-body {:name "Test Project"}))
        project-resp (rest-handler create-project-req)
        project-id (:id (parse-response-body project-resp))]

    (testing "Multiple GET requests"
      (let [operations [{:path "/api/v1/users/admin@example.com" :method "get" :body nil}
                        {:path (str "/api/v1/projects/" project-id) :method "get" :body nil}]
            response (make-batch-request operations admin-token)
            response-body (parse-response-body response)]
        (is (= 200 (:status response)))
        (is (= 2 (count response-body)))
        (is (= 200 (get-in response-body [0 :status])))
        (is (= "admin@example.com" (get-in response-body [0 :body :user/username])))
        (is (= 200 (get-in response-body [1 :status])))
        (is (= "Test Project" (get-in response-body [1 :body :project/name])))))

    (testing "Mixed GET and POST operations"
      (let [create-doc-req (-> (admin-request :post "/api/v1/documents")
                               (mock/json-body {:project-id project-id :name "Test Document"}))
            doc-resp (rest-handler create-doc-req)
            _ (is (= 201 (:status doc-resp)) "Document creation should succeed")
            doc-id (:id (parse-response-body doc-resp))
            operations [{:path (str "/api/v1/projects/" project-id) :method "get" :body nil}
                        {:path "/api/v1/users/admin@example.com" :method "get" :body nil}
                        {:path (str "/api/v1/documents/" doc-id) :method "get" :body nil}]
            response (make-batch-request operations admin-token)
            response-body (parse-response-body response)]
        (is (= 200 (:status response)))
        (is (= 3 (count response-body)))
        (is (= 200 (get-in response-body [0 :status])))
        (is (= "Test Project" (get-in response-body [0 :body :project/name])))
        (is (= 200 (get-in response-body [1 :status])))
        (is (= "admin@example.com" (get-in response-body [1 :body :user/username])))
        (is (= 200 (get-in response-body [2 :status])))
        (is (= "Test Document" (get-in response-body [2 :body :document/name])))))

    (testing "Atomic error handling - batch fails and rolls back changes"
      (let [create-doc-req (-> (admin-request :post "/api/v1/documents")
                               (mock/json-body {:project-id project-id :name "Original Document"}))
            doc-resp (rest-handler create-doc-req)
            _ (is (= 201 (:status doc-resp)) "Document creation should succeed")
            doc-id (:id (parse-response-body doc-resp))
            operations [{:path (str "/api/v1/documents/" doc-id)
                         :method "patch"
                         :body {:name "Modified Document"}}
                        {:path "/api/v1/users/nonexistent@example.com"
                         :method "get"
                         :body nil}]
            response (make-batch-request operations admin-token)]
        (is (>= (:status response) 400))
        (is (some? (:body response)) "Failed batch should return an error body")
        (let [response-body (parse-response-body response)]
          (is (map? response-body) "Single error object, not array")
          (is (contains? response-body :error)))
        (let [check-doc-req (admin-request :get (str "/api/v1/documents/" doc-id))
              check-resp (rest-handler check-doc-req)
              doc-data (parse-response-body check-resp)]
          (is (= 200 (:status check-resp)))
          (is (= "Original Document" (:document/name doc-data))
              "Document should be rolled back to original name"))))

    (testing "Empty batch request"
      (let [response (make-batch-request [] admin-token)
            response-body (parse-response-body response)]
        (is (= 200 (:status response)))
        (is (= [] response-body))))

    (testing "Invalid method"
      (let [operations [{:path "/api/v1/users/admin@example.com" :method "invalid" :body nil}]
            response (make-batch-request operations admin-token)]
        (is (= 400 (:status response)))))

    (testing "Unauthenticated request"
      (let [operations [{:path "/api/v1/users/admin@example.com" :method "get" :body nil}]
            response (make-batch-request operations nil)]
        ;; 401 (auth failure), aligned with the 401 a malformed/expired token
        ;; gets — see auth/wrap-login-required. 403 is for an authenticated
        ;; user lacking permission.
        (is (= 401 (:status response)))))))

(deftest test-failed-batch-error-response
  (testing "Failed batch operations return proper error response"
    (let [create-project-req (-> (admin-request :post "/api/v1/projects")
                                 (mock/json-body {:name "Error Test Project"}))
          project-resp (rest-handler create-project-req)
          project-id (:id (parse-response-body project-resp))
          operations [{:path (str "/api/v1/projects/" project-id) :method "get" :body nil}
                      {:path "/api/v1/users/nonexistent@example.com" :method "get" :body nil}]
          response (make-batch-request operations admin-token)]
      (is (>= (:status response) 400))
      (is (some? (:body response)) "Failed batch should return an error body")
      (let [response-body (parse-response-body response)]
        (is (map? response-body) "Should return single error object, not array")
        (is (contains? response-body :error) "Should contain error information")))))

(deftest test-batch-rollback-comprehensive
  (testing "Multiple document updates are rolled back on failure"
    (let [create-project-req (-> (admin-request :post "/api/v1/projects")
                                 (mock/json-body {:name "Rollback Test Project"}))
          project-resp (rest-handler create-project-req)
          project-id (:id (parse-response-body project-resp))
          doc1-resp (rest-handler (-> (admin-request :post "/api/v1/documents")
                                      (mock/json-body {:project-id project-id :name "Doc1 Original"})))
          doc1-id (:id (parse-response-body doc1-resp))
          doc2-resp (rest-handler (-> (admin-request :post "/api/v1/documents")
                                      (mock/json-body {:project-id project-id :name "Doc2 Original"})))
          doc2-id (:id (parse-response-body doc2-resp))
          operations [{:path (str "/api/v1/documents/" doc1-id)
                       :method "patch"
                       :body {:name "Doc1 Modified"}}
                      {:path (str "/api/v1/documents/" doc2-id)
                       :method "patch"
                       :body {:name "Doc2 Modified"}}
                      {:path "/api/v1/documents/non-existent-id"
                       :method "delete"
                       :body nil}]
          response (make-batch-request operations admin-token)]
      (is (>= (:status response) 400))
      (let [check-doc1 (rest-handler (admin-request :get (str "/api/v1/documents/" doc1-id)))
            doc1-data (parse-response-body check-doc1)
            check-doc2 (rest-handler (admin-request :get (str "/api/v1/documents/" doc2-id)))
            doc2-data (parse-response-body check-doc2)]
        (is (= "Doc1 Original" (:document/name doc1-data))
            "First document should be rolled back")
        (is (= "Doc2 Original" (:document/name doc2-data))
            "Second document should be rolled back"))))

  (testing "Created documents are deleted on rollback"
    (let [create-project-req (-> (admin-request :post "/api/v1/projects")
                                 (mock/json-body {:name "Creation Rollback Test"}))
          project-resp (rest-handler create-project-req)
          project-id (:id (parse-response-body project-resp))
          operations [{:path "/api/v1/documents"
                       :method "post"
                       :body {:project-id project-id :name "Should Not Exist"}}
                      {:path "/api/v1/users/nonexistent@example.com"
                       :method "get"
                       :body nil}]
          response (make-batch-request operations admin-token)]
      (is (>= (:status response) 400))
      (let [list-docs-req (admin-request :get (str "/api/v1/projects/" project-id "/documents"))
            list-resp (rest-handler list-docs-req)
            all-docs (if (= 200 (:status list-resp)) (:entries (parse-response-body list-resp)) [])]
        (is (or (nil? all-docs) (empty? all-docs))
            "No documents should exist after rollback")))))

(deftest test-batch-events-deferred-to-post-commit
  ;; Sub-ops used to publish their audit events while the outer batch tx
  ;; was still open: a failing batch had already broadcast events for
  ;; writes that then rolled back (phantom events — listeners refetch and
  ;; act on changes that never existed), and even on success a listener
  ;; that refetched on receipt read the pre-batch snapshot with no
  ;; further notification. Events now buffer under op/*deferred-events*
  ;; and the batch handler flushes them only after the outer tx commits.
  (let [create-project-req (-> (admin-request :post "/api/v1/projects")
                               (mock/json-body {:name "Batch Event Project"}))
        project-resp (rest-handler create-project-req)
        project-id (:id (parse-response-body project-resp))
        published (atom [])]
    (with-redefs [events/publish-audit-event!
                  (fn [op _audits user-id]
                    (swap! published conj {:op op :user-id user-id}))]
      (testing "failed batch publishes NO events for rolled-back sub-ops"
        (reset! published [])
        (let [operations [{:path "/api/v1/documents"
                           :method "post"
                           :body {:project-id project-id :name "WillRollBack"}}
                          {:path "/api/v1/users/nonexistent@example.com"
                           :method "get"
                           :body nil}]
              response (make-batch-request operations admin-token)]
          (is (>= (:status response) 400) "batch failed and rolled back")
          (is (empty? @published)
              "no phantom events — the create's write never committed")))
      (testing "successful batch publishes one event per mutating sub-op, after commit"
        (reset! published [])
        (let [operations [{:path "/api/v1/documents"
                           :method "post"
                           :body {:project-id project-id :name "BatchDoc1"}}
                          {:path "/api/v1/documents"
                           :method "post"
                           :body {:project-id project-id :name "BatchDoc2"}}]
              response (make-batch-request operations admin-token)]
          (is (= 200 (:status response)))
          (is (= 2 (count @published))
              "both sub-ops' events flushed post-commit")
          (is (= #{:document/create} (set (map #(get-in % [:op :op/type]) @published))))))
      (testing "a non-batch operation still publishes immediately"
        (reset! published [])
        (let [resp (rest-handler (-> (admin-request :post "/api/v1/documents")
                                     (mock/json-body {:project-id project-id :name "SoloDoc"})))]
          (is (= 201 (:status resp)))
          (is (= 1 (count @published))
              "single ops publish without batch deferral"))))))

(deftest test-bulk-create-chunked-insert-over-parameter-limit
  ;; Fix-4 smoke test: psc/insert-many! and psc/fetch-ids-as-map both used
  ;; to build single statements whose parameter count grew linearly with
  ;; the input size. With SQLITE_MAX_VARIABLE_NUMBER = 32766 in
  ;; sqlite-jdbc 3.50.x and tokens taking ~7 columns each, a bulk-create
  ;; of more than ~4680 tokens crashed with "too many SQL variables".
  ;; Both helpers now chunk in batches of ~4000 rows; this test inserts
  ;; 5000 tokens and asserts no crash + all rows present.
  (testing "bulk-create of 5000 tokens succeeds (chunked insert + chunked IN-list)"
    (let [proj (h/create-test-project admin-request "BulkChunkProj")
          doc  (h/create-test-document admin-request proj "BulkChunkDoc")
          tl   (-> (h/create-text-layer admin-request proj "TL") :body :id)
          ;; A single-char text body is enough — every token is a 1-char span.
          ;; bulk-create requires all tokens to share the same text id.
          body (apply str (repeat 5000 \a))
          tid  (-> (h/create-text admin-request tl doc body) :body :id)
          tokl (-> (h/create-token-layer admin-request tl "TKL") :body :id)
          tokens (vec (for [i (range 5000)]
                        {:token-layer-id tokl
                         :text tid
                         :begin i
                         :end (inc i)}))
          response (h/bulk-create-tokens admin-request tokens)]
      (is (= 201 (:status response))
          "bulk-create must not crash on >4680 tokens")
      (let [ids (-> response :body :ids)]
        (is (= 5000 (count ids)) "all 5000 ids returned")))))

(deftest test-preprocess-batch-keyed-by-doc-id-and-version
  ;; #109 regression: before the fix, `preprocess-batch-operations` dedupes
  ;; document-version values by the bare version string, so two ops
  ;; touching different documents with the same numeric version (e.g.
  ;; the very-common case of two docs both at version 1) would have the
  ;; second op silently stripped of its `?document-version=` param,
  ;; bypassing OCC entirely. The fix keys the dedupe map by
  ;; [doc-id, version] instead. This test exercises the real entity-
  ;; resolution path via the live DB and asserts both sub-ops retain
  ;; their version param.
  (testing "Two ops touching different docs with the same version both keep their version param"
    (let [proj  (h/create-test-project admin-request "BatchOccDedupeProj")
          doc-a (h/create-test-document admin-request proj "DocA")
          doc-b (h/create-test-document admin-request proj "DocB")
          tl    (-> (h/create-text-layer admin-request proj "TL") :body :id)
          text-a (-> (h/create-text admin-request tl doc-a "a") :body :id)
          text-b (-> (h/create-text admin-request tl doc-b "b") :body :id)
          ;; Both docs are at version 1 (or whatever their post-create
          ;; version is); the original implementation would dedupe by the
          ;; raw "1" string and drop op-2's version param.
          ops  [{:path (str "/api/v1/texts/" text-a "?document-version=1")
                 :method "patch" :body {:body "x"}}
                {:path (str "/api/v1/texts/" text-b "?document-version=1")
                 :method "patch" :body {:body "y"}}]
          processed (batch/preprocess-batch-operations ops fixtures/db)
          paths (mapv :path processed)]
      (is (clojure.string/includes? (nth paths 0) "document-version=1")
          "First sub-op keeps its document-version")
      (is (clojure.string/includes? (nth paths 1) "document-version=1")
          "Second sub-op (different doc) MUST also keep its document-version
          — otherwise OCC silently bypasses for doc-b"))))

(deftest test-preprocess-batch-still-dedupes-same-doc-same-version
  ;; The fix must preserve the original good behavior of suppressing a
  ;; duplicate (same-doc, same-version) sibling. Otherwise two writes
  ;; to the same doc inside one batch would both carry the same version
  ;; → the second OCC check trivially fires (version already bumped by
  ;; the first sub-op) → spurious 409. We assert that only the FIRST op
  ;; keeps the param when the (doc-id, version) key collides.
  (testing "Two ops touching the SAME doc with the same version still dedupe"
    (let [proj  (h/create-test-project admin-request "BatchOccDedupeSameDocProj")
          doc   (h/create-test-document admin-request proj "Doc")
          tl    (-> (h/create-text-layer admin-request proj "TL") :body :id)
          text  (-> (h/create-text admin-request tl doc "hello world") :body :id)
          ops  [{:path (str "/api/v1/texts/" text "?document-version=1")
                 :method "patch" :body {:body "x"}}
                {:path (str "/api/v1/texts/" text "?document-version=1")
                 :method "patch" :body {:body "y"}}]
          processed (batch/preprocess-batch-operations ops fixtures/db)
          paths (mapv :path processed)]
      (is (clojure.string/includes? (nth paths 0) "document-version=1")
          "First sub-op keeps its document-version")
      (is (not (clojure.string/includes? (nth paths 1) "document-version="))
          "Second sub-op (same doc, same version) has document-version stripped"))))

(deftest test-batch-rollback-when-body-throws-ex-info
  ;; Fix-3 regression test: when a sub-op's body throws ExceptionInfo,
  ;; submit-operation* catches it and returns {:success false :code ...}.
  ;; The REST handler converts that to a non-200 response; the batch
  ;; handler then sees status>=300 and throws to roll back the outer tx.
  ;; This test exercises the full chain and asserts that:
  ;;   - sub-op-1's writes (operations + audit_writes + the doc itself)
  ;;     are NOT visible after the batch fails (outer tx rolled back).
  ;;   - sub-op-3 was never reached.
  ;;
  ;; The trigger for the inner ExceptionInfo is a token POST with begin>end
  ;; (check-token-bounds! throws inside submit-operation*'s body); the
  ;; auth middleware passes because the project / token-layer exist.
  (testing "Outer tx rolls back when a sub-op body raises ExceptionInfo inside submit-operation*"
    (let [proj (h/create-test-project admin-request "BodyThrowProj")
          doc1 (h/create-test-document admin-request proj "ExistingDoc")
          tl   (-> (h/create-text-layer admin-request proj "TL") :body :id)
          text (-> (h/create-text admin-request tl doc1 "abcdef") :body :id)
          tokl (-> (h/create-token-layer admin-request tl "TKL") :body :id)
          ops-before (count (psc/q fixtures/db {:select [:id] :from [:operations]}))
          aw-before (count (psc/q fixtures/db {:select [:id] :from [:audit_writes]}))
          ;; The batch:
          ;;   1) create a brand-new document   — would succeed if the batch
          ;;      committed; its operations row + insert audit + bumped
          ;;      version on the doc all live in the outer tx.
          ;;   2) create a token with end<begin — passes auth (real layer)
          ;;      but throws ExceptionInfo inside submit-operation*'s body
          ;;      (check-token-bounds!). submit-operation* catches and
          ;;      returns {:success false :code 400}.
          ;;   3) a third op (never reached if the chain works).
          operations [{:path "/api/v1/documents"
                       :method "post"
                       :body {:project-id proj :name "Tx Rollback Sentinel"}}
                      {:path "/api/v1/tokens"
                       :method "post"
                       :body {:token-layer-id tokl
                              :text text
                              :begin 4
                              :end 2}}
                      {:path "/api/v1/documents"
                       :method "post"
                       :body {:project-id proj :name "Unreached Doc"}}]
          response (make-batch-request operations admin-token)]
      ;; The batch as a whole failed.
      (is (>= (:status response) 400))
      ;; The sentinel document was rolled back.
      (let [list-docs (rest-handler (admin-request :get (str "/api/v1/projects/" proj "/documents")))
            docs (when (= 200 (:status list-docs)) (parse-response-body list-docs))
            names (set (map :document/name docs))]
        (is (not (contains? names "Tx Rollback Sentinel"))
            "First sub-op's document insert must be rolled back")
        (is (not (contains? names "Unreached Doc"))
            "Third sub-op's document must not exist (loop never reached it)"))
      ;; The operation/audit rows from sub-op-1 must be gone.
      ;; sub-op-2 also inserts an operations row before its body throws;
      ;; that too gets rolled back with the outer tx.
      (let [ops-after (count (psc/q fixtures/db {:select [:id] :from [:operations]}))
            aw-after (count (psc/q fixtures/db {:select [:id] :from [:audit_writes]}))]
        (is (= ops-before ops-after)
            "No operations rows should be added by a rolled-back batch")
        (is (= aw-before aw-after)
            "No audit_writes rows should be added by a rolled-back batch")))))
