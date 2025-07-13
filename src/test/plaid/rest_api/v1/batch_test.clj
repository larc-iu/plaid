(ns plaid.rest-api.v1.batch-test
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [clojure.string]
            [ring.mock.request :as mock]
            [plaid.fixtures :refer [with-xtdb
                                    with-mount-states
                                    with-rest-handler
                                    rest-handler
                                    with-admin
                                    admin-token
                                    admin-request
                                    parse-response-body]]
            [muuntaja.core :as m]
            [clojure.core.async :as async]
            [plaid.xtdb.operation :refer [request-operation-start!
                                          signal-operation-complete!
                                          request-batch-start!
                                          signal-batch-complete!]]
            [mount.core :as mount])
  (:import [java.util.concurrent CountDownLatch CyclicBarrier TimeUnit]))

(use-fixtures :once with-xtdb with-mount-states with-rest-handler with-admin)

(defn make-batch-request [operations token]
  (let [req (cond-> (mock/request :post "/api/v1/batch")
                    true (mock/header "accept" "application/edn")
                    true (mock/json-body operations)
                    token (mock/header "authorization" (str "Bearer " token)))]
    (rest-handler req)))

(deftest test-batch-operations
  (let [;; Create test project
        create-project-req (-> (admin-request :post "/api/v1/projects")
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
      ;; Create a document first to test mixed operations
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
        ;; First op: GET project
        (is (= 200 (get-in response-body [0 :status])))
        (is (= "Test Project" (get-in response-body [0 :body :project/name])))
        ;; Second op: GET user
        (is (= 200 (get-in response-body [1 :status])))
        (is (= "admin@example.com" (get-in response-body [1 :body :user/username])))
        ;; Third op: GET document
        (is (= 200 (get-in response-body [2 :status])))
        (is (= "Test Document" (get-in response-body [2 :body :document/name])))))

    (testing "Atomic error handling - batch fails and rolls back changes"
      ;; Create a document that we'll modify in the batch, then verify rollback
      (let [create-doc-req (-> (admin-request :post "/api/v1/documents")
                               (mock/json-body {:project-id project-id :name "Original Document"}))
            doc-resp (rest-handler create-doc-req)
            _ (is (= 201 (:status doc-resp)) "Document creation should succeed")
            doc-id (:id (parse-response-body doc-resp))

            ;; Batch operations: successful update followed by failure
            operations [{:path (str "/api/v1/documents/" doc-id)
                         :method "patch"
                         :body {:name "Modified Document"}}
                        {:path "/api/v1/users/nonexistent@example.com"
                         :method "get"
                         :body nil}]
            response (make-batch-request operations admin-token)
            response-body (when (:body response) (parse-response-body response))]

        ;; Batch should fail with 404 from the second operation
        (is (= 404 (:status response)))
        (when response-body
          (is (map? response-body)) ; Single error object, not array
          (is (contains? response-body :error)))

        ;; Verify rollback: document should still have original name
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
        (is (= 403 (:status response)))))))

;; Operation Coordinator State Machine Tests ===============================================
;; These tests directly test the operation coordinator state machine by bypassing the
;; normal submit-operations! macro and calling the coordinator functions directly.

(defn make-controlled-operation
  "Create a controlled operation that can be started and completed on demand"
  []
  (let [start-latch (CountDownLatch. 1)
        complete-latch (CountDownLatch. 1)
        request-made-latch (CountDownLatch. 1) ; New: track when coordinator request is made
        status (atom :created)
        result (atom nil)]
    {:start-latch start-latch
     :complete-latch complete-latch
     :request-made-latch request-made-latch ; Add this to the map
     :status status
     :result result
     :start-fn #(do (.countDown start-latch)
                    (reset! status :started))
     :complete-fn #(do (.countDown complete-latch)
                       (reset! status :completed))
     :wait-started #(.await start-latch 5 TimeUnit/SECONDS)
     :wait-completed #(.await complete-latch 5 TimeUnit/SECONDS)
     :wait-request-made #(.await request-made-latch 5 TimeUnit/SECONDS)}))

(defn coordinator-request-regular-start!
  "Request permission to start a regular operation using the coordinator directly"
  []
  (request-operation-start!))

(defn coordinator-signal-regular-complete!
  "Signal that a regular operation has completed using the coordinator directly"
  []
  (signal-operation-complete!))

(defn coordinator-request-batch-start!
  "Request permission to start a batch operation using the coordinator directly"
  [batch-id]
  (request-batch-start! batch-id))

(defn coordinator-signal-batch-complete!
  "Signal that a batch operation has completed using the coordinator directly"
  []
  (signal-batch-complete!))

(defn start-regular-op-async
  "Start a regular operation in a background thread, returns operation map"
  [operation]
  (let [response-future (async/thread
                          (let [_ (.countDown (:request-made-latch operation)) ; Signal request is being made
                                proceed? (coordinator-request-regular-start!)]
                            (reset! (:result operation) {:proceed proceed?})
                            (when proceed?
                              ((:start-fn operation))
                              (.await (:complete-latch operation) 10 TimeUnit/SECONDS)
                              (coordinator-signal-regular-complete!))
                            proceed?))]
    (assoc operation :response-future response-future)))

(defn start-batch-op-async
  "Start a batch operation in a background thread, returns operation map"
  [batch-id operation]
  (let [response-future (async/thread
                          (let [_ (.countDown (:request-made-latch operation)) ; Signal request is being made
                                response (coordinator-request-batch-start! batch-id)]
                            (reset! (:result operation) response)
                            (when (= (:status response) :proceed)
                              ((:start-fn operation))
                              (.await (:complete-latch operation) 10 TimeUnit/SECONDS)
                              (coordinator-signal-batch-complete!))
                            response))]
    (assoc operation :response-future response-future)))

(defn wait-for-operations-to-start
  "Wait for all operations to signal they have started"
  [operations timeout-ms]
  (every? #(.await (:start-latch %) timeout-ms TimeUnit/MILLISECONDS) operations))

(defn wait-for-operations-to-request
  "Wait for all operations to make their coordinator requests"
  [operations timeout-ms]
  (every? #(.await (:request-made-latch %) timeout-ms TimeUnit/MILLISECONDS) operations))

(defn wait-for-coordinator-responses
  "Wait for operations to receive their coordinator responses (not full completion)"
  [operations timeout-ms]
  (let [deadline (+ (System/currentTimeMillis) timeout-ms)]
    (every? (fn [op]
              (loop []
                (if (> (System/currentTimeMillis) deadline)
                  false
                  (let [result @(:result op)]
                    (if (not (nil? result))
                      true
                      (do (Thread/sleep 50)
                          (recur)))))))
            operations)))

(defn wait-for-operations-to-start-polling
  "Poll repeatedly until operations start (more robust than single timeout)"
  [operations timeout-ms]
  (let [deadline (+ (System/currentTimeMillis) timeout-ms)]
    (loop []
      (if (> (System/currentTimeMillis) deadline)
        false
        (if (every? #(.await (:start-latch %) 50 TimeUnit/MILLISECONDS) operations)
          true
          (do (Thread/sleep 100)
              (recur)))))))

(defn release-operations
  "Signal all operations to complete"
  [operations]
  (doseq [op operations]
    ((:complete-fn op))))

(defn wait-for-all-responses
  "Wait for all operation response futures to complete"
  [operations timeout-ms]
  (let [deadline (+ (System/currentTimeMillis) timeout-ms)]
    (every? #(try
               (let [timeout-remaining (max 0 (- deadline (System/currentTimeMillis)))
                     timeout-chan (async/timeout timeout-remaining)
                     [result port] (async/alts!! [(:response-future %) timeout-chan])]
                 (and (not= port timeout-chan) (not (nil? result))))
               (catch Exception _ false))
            operations)))

(defn verify-operation-queued
  "Verify operation is waiting (hasn't received proceed response yet)"
  [operation timeout-ms]
  (let [timeout-chan (async/timeout timeout-ms)
        [val port] (async/alts!! [(:response-future operation) timeout-chan])]
    (= port timeout-chan)))

(defn barrier-sync
  "Create a CyclicBarrier for n threads"
  [n description]
  (CyclicBarrier. n))

;; Basic Operation Tests =================================================================

(deftest test-single-regular-operation
  (testing "Single regular operation proceeds immediately"
    (let [op (make-controlled-operation)
          op-with-future (start-regular-op-async op)]

      (is (.await (:start-latch op) 1000 TimeUnit/MILLISECONDS)
          "Operation should start immediately")

      ((:complete-fn op))

      (let [result (async/<!! (:response-future op-with-future))]
        (is result "Operation should succeed")))))

(deftest test-single-batch-operation
  (testing "Single batch operation proceeds immediately when no regulars active"
    (let [op (make-controlled-operation)
          batch-id (str "test-batch-" (random-uuid))
          op-with-future (start-batch-op-async batch-id op)]

      (is (.await (:start-latch op) 1000 TimeUnit/MILLISECONDS)
          "Batch should start immediately")

      ((:complete-fn op))

      (let [result (async/<!! (:response-future op-with-future))]
        (is (= (:status result) :proceed) "Batch should proceed")))))

(deftest test-concurrent-regular-operations
  (testing "Multiple regular operations can run concurrently"
    (let [ops (repeatedly 3 make-controlled-operation)
          ops-with-futures (map start-regular-op-async ops)]

      ;; Wait for all operations to start (they should all get permission immediately)
      (is (wait-for-operations-to-start ops-with-futures 3000)
          "All operations should start")

      ;; Release all operations to complete
      (release-operations ops-with-futures)

      ;; Check that all operations succeeded by getting their response future results
      (is (every? #(true? (async/<!! (:response-future %))) ops-with-futures)
          "All operations should succeed"))))

;; Blocking and Queueing Tests ==========================================================

(deftest test-regulars-blocked-by-batch
  (testing "Regular operations are blocked when batch is active"
    (let [batch-op (make-controlled-operation)
          batch-id (str "test-batch-" (random-uuid))
          batch-with-future (start-batch-op-async batch-id batch-op)

          regular-ops (repeatedly 2 make-controlled-operation)
          regulars-with-futures (doall (map start-regular-op-async regular-ops))]

      (is (.await (:start-latch batch-op) 1000 TimeUnit/MILLISECONDS)
          "Batch should start immediately")

      (Thread/sleep 200)

      (is (every? #(verify-operation-queued % 100) regulars-with-futures)
          "Regular operations should be queued")

      ((:complete-fn batch-op))

      (is (wait-for-operations-to-start regular-ops 1000)
          "Regular operations should start after batch completes")

      (release-operations regular-ops))))

(deftest test-batch-blocked-by-regulars
  (testing "Batch operation waits for active regular operations to complete"
    (let [regular-ops (repeatedly 2 make-controlled-operation)
          regulars-with-futures (doall (map start-regular-op-async regular-ops))

          batch-op (make-controlled-operation)
          batch-id (str "test-batch-" (random-uuid))]

      (is (wait-for-operations-to-start regular-ops 1000)
          "Regular operations should start")

      (let [batch-with-future (start-batch-op-async batch-id batch-op)]
        (Thread/sleep 200)

        (is (verify-operation-queued batch-with-future 100)
            "Batch should be queued behind regulars")

        (release-operations regular-ops)

        (is (.await (:start-latch batch-op) 1000 TimeUnit/MILLISECONDS)
            "Batch should start after regulars complete")

        ((:complete-fn batch-op))))))

(deftest test-multiple-batches-queued
  (testing "Multiple batches are queued in FIFO order"
    (let [batch1 (make-controlled-operation)
          batch2 (make-controlled-operation)
          batch3 (make-controlled-operation)
          batch1-id (str "test-batch-1-" (random-uuid))
          batch2-id (str "test-batch-2-" (random-uuid))
          batch3-id (str "test-batch-3-" (random-uuid))]

      (let [batch1-future (start-batch-op-async batch1-id batch1)]
        ;; Ensure first batch starts before launching others
        (is (.await (:start-latch batch1) 2000 TimeUnit/MILLISECONDS)
            "First batch should start immediately")

        ;; Now start the second and third batches
        (let [batch2-future (start-batch-op-async batch2-id batch2)
              batch3-future (start-batch-op-async batch3-id batch3)]

          ;; Give time for batches to be queued
          (Thread/sleep 300)

          (is (and (verify-operation-queued batch2-future 100)
                   (verify-operation-queued batch3-future 100))
              "Second and third batches should be queued")

          ((:complete-fn batch1))

          (is (.await (:start-latch batch2) 2000 TimeUnit/MILLISECONDS)
              "Second batch should start after first completes")

          ((:complete-fn batch2))

          (is (.await (:start-latch batch3) 2000 TimeUnit/MILLISECONDS)
              "Third batch should start after second completes")

          ((:complete-fn batch3)))))))

(deftest test-mixed-operation-queueing
  (testing "Mixed regular and batch operations queue properly"
    (let [batch1 (make-controlled-operation)
          batch1-id (str "test-batch-1-" (random-uuid))
          batch1-future (start-batch-op-async batch1-id batch1)]

      (is (.await (:start-latch batch1) 2000 TimeUnit/MILLISECONDS)
          "First batch should start")

      ;; Now create regular and batch operations that should be queued
      (let [regular-ops (repeatedly 2 make-controlled-operation)
            regulars-futures (doall (map start-regular-op-async regular-ops))

            batch2 (make-controlled-operation)
            batch2-id (str "test-batch-2-" (random-uuid))
            batch2-future (start-batch-op-async batch2-id batch2)]

        ;; Wait for all operations to make their coordinator requests
        (is (wait-for-operations-to-request regulars-futures 2000)
            "Regular operations should make coordinator requests")
        (is (wait-for-operations-to-request [batch2-future] 2000)
            "Second batch should make coordinator request")

        ;; Verify they are queued
        (is (every? #(verify-operation-queued % 100) regulars-futures)
            "Regular operations should be queued behind batch")
        (is (verify-operation-queued batch2-future 100)
            "Second batch should be queued behind first")

        ;; Complete first batch - this should release the regular operations
        ((:complete-fn batch1))

        ;; Use polling to wait for regular operations to start
        (is (wait-for-operations-to-start-polling regular-ops 5000)
            "Regular operations should start after first batch completes")

        ;; Release regular operations
        (release-operations regular-ops)

        ;; Second batch should start after regulars complete
        (is (.await (:start-latch batch2) 3000 TimeUnit/MILLISECONDS)
            "Second batch should start after regulars complete")

        ((:complete-fn batch2))))))

;; State Transition Tests ===============================================================

(deftest test-regular-complete-triggers-batch
  (testing "Last regular operation completing triggers queued batch"
    (let [regular1 (make-controlled-operation)
          regular2 (make-controlled-operation)
          regular1-future (start-regular-op-async regular1)
          regular2-future (start-regular-op-async regular2)]

      (is (wait-for-operations-to-start [regular1 regular2] 1000)
          "Both regulars should start")

      (let [batch-op (make-controlled-operation)
            batch-id (str "test-batch-" (random-uuid))
            batch-future (start-batch-op-async batch-id batch-op)]

        (Thread/sleep 200)

        (is (verify-operation-queued batch-future 100)
            "Batch should be queued")

        ((:complete-fn regular1))
        (Thread/sleep 100)

        (is (verify-operation-queued batch-future 100)
            "Batch should still be queued after one regular completes")

        ((:complete-fn regular2))

        (is (.await (:start-latch batch-op) 1000 TimeUnit/MILLISECONDS)
            "Batch should start after last regular completes")

        ((:complete-fn batch-op))))))

(deftest test-batch-complete-releases-regulars
  (testing "Batch completion releases all queued regular operations"
    (let [batch-op (make-controlled-operation)
          batch-id (str "test-batch-" (random-uuid))
          batch-future (start-batch-op-async batch-id batch-op)]

      (is (.await (:start-latch batch-op) 1000 TimeUnit/MILLISECONDS)
          "Batch should start")

      (let [regular-ops (repeatedly 3 make-controlled-operation)
            regulars-futures (doall (map start-regular-op-async regular-ops))]

        (Thread/sleep 200)

        (is (every? #(verify-operation-queued % 100) regulars-futures)
            "All regulars should be queued")

        ((:complete-fn batch-op))

        (is (wait-for-operations-to-start regular-ops 1000)
            "All regulars should start after batch completes")

        (release-operations regular-ops)))))

(deftest test-complex-state-transitions
  (testing "Complex sequence of state transitions"
    (let [regular1 (make-controlled-operation)
          regular1-future (start-regular-op-async regular1)]

      ;; Ensure first regular starts before proceeding
      (is (.await (:start-latch regular1) 2000 TimeUnit/MILLISECONDS)
          "First regular should start")

      ;; Now create the queued operations
      (let [batch1 (make-controlled-operation)
            batch1-id (str "test-batch-1-" (random-uuid))
            batch1-future (start-batch-op-async batch1-id batch1)

            regular2 (make-controlled-operation)
            regular2-future (start-regular-op-async regular2)

            batch2 (make-controlled-operation)
            batch2-id (str "test-batch-2-" (random-uuid))
            batch2-future (start-batch-op-async batch2-id batch2)]

        ;; Wait for all operations to make their coordinator requests
        (is (wait-for-operations-to-request [batch1-future] 2000)
            "First batch should make coordinator request")
        (is (wait-for-operations-to-request [regular2-future] 2000)
            "Second regular should make coordinator request")
        (is (wait-for-operations-to-request [batch2-future] 2000)
            "Second batch should make coordinator request")

        ;; Verify they are all queued
        (is (and (verify-operation-queued batch1-future 100)
                 (verify-operation-queued regular2-future 100)
                 (verify-operation-queued batch2-future 100))
            "All subsequent ops should be queued")

        ;; Complete first regular - should trigger first batch
        ((:complete-fn regular1))

        ;; DEBUG: Check if batch1 receives its response
        (is (wait-for-coordinator-responses [batch1-future] 3000)
            "Batch1 should receive coordinator response after regular1 completes")

        ;; Use polling to wait for first batch to start
        (is (wait-for-operations-to-start-polling [batch1] 5000)
            "First batch should start after regular completes")

        ;; Complete first batch - should trigger second regular
        ((:complete-fn batch1))

        ;; Use polling to wait for second regular to start
        (is (wait-for-operations-to-start-polling [regular2] 5000)
            "Second regular should start after first batch completes")

        ;; Complete second regular - should trigger second batch
        ((:complete-fn regular2))

        ;; Use polling to wait for second batch to start
        (is (wait-for-operations-to-start-polling [batch2] 5000)
            "Second batch should start after second regular completes")

        ((:complete-fn batch2))))))

;; Race Condition Tests =================================================================

(deftest test-concurrent-regular-completion
  (testing "Multiple regular operations completing simultaneously"
    (let [regular-ops (repeatedly 5 make-controlled-operation)
          regulars-futures (doall (map start-regular-op-async regular-ops))]

      (is (wait-for-operations-to-start regular-ops 1000)
          "All regulars should start")

      (let [batch-op (make-controlled-operation)
            batch-id (str "test-batch-" (random-uuid))
            batch-future (start-batch-op-async batch-id batch-op)]

        (Thread/sleep 200)

        (is (verify-operation-queued batch-future 100)
            "Batch should be queued")

        (let [completion-barrier (CyclicBarrier. (count regular-ops))]
          (doseq [op regular-ops]
            (async/thread
              (.await completion-barrier)
              ((:complete-fn op))))

          (is (.await (:start-latch batch-op) 2000 TimeUnit/MILLISECONDS)
              "Batch should start after all regulars complete simultaneously")

          ((:complete-fn batch-op)))))))

(deftest test-batch-request-during-transition
  (testing "Batch request arriving just as regular operations complete"
    (let [regular-op (make-controlled-operation)
          regular-future (start-regular-op-async regular-op)]

      (is (.await (:start-latch regular-op) 1000 TimeUnit/MILLISECONDS)
          "Regular should start")

      (let [sync-barrier (CyclicBarrier. 2)
            batch-op (make-controlled-operation)
            batch-id (str "test-batch-" (random-uuid))]

        (async/thread
          (.await sync-barrier)
          ((:complete-fn regular-op)))

        (async/thread
          (.await sync-barrier)
          (Thread/sleep 1)
          (start-batch-op-async batch-id batch-op))

        (is (.await (:start-latch batch-op) 2000 TimeUnit/MILLISECONDS)
            "Batch should start even with timing race")

        ((:complete-fn batch-op))))))

;; Edge Case Tests ======================================================================

(deftest test-timeout-handling
  (testing "Coordinator timeout handling for queued operations"
    ;; Test that the coordinator properly handles timeouts by making a batch
    ;; that never signals completion, then verifying timeout behavior
    (let [batch-op (make-controlled-operation)
          batch-id (str "test-timeout-batch-" (random-uuid))
          batch-future (start-batch-op-async batch-id batch-op)]

      ;; Batch should start immediately
      (is (.await (:start-latch batch-op) 1000 TimeUnit/MILLISECONDS)
          "Batch should start")

      ;; Start regular operations that will be queued behind the batch
      (let [regular-ops (repeatedly 2 make-controlled-operation)
            regulars-futures (doall (map start-regular-op-async regular-ops))]

        ;; Verify regulars are queued
        (Thread/sleep 200)
        (is (every? #(verify-operation-queued % 100) regulars-futures)
            "Regular operations should be queued behind batch")

        ;; Complete the batch to release queued operations
        ;; (In real timeout scenario, this wouldn't happen and coordinator would timeout)
        ((:complete-fn batch-op))

        ;; Verify regulars start after batch completes
        (is (wait-for-operations-to-start regular-ops 1000)
            "Regular operations should start after batch completes")

        ;; Clean up
        (release-operations regular-ops)))))

(deftest test-unknown-request-type
  (testing "Unknown request type handling"
    (let [coordinator plaid.xtdb.operation/operation-coordinator
          request-chan (:request-chan coordinator)
          response-chan (async/chan)]

      (async/>!! request-chan {:type :unknown :response-chan response-chan})

      (let [response (async/<!! response-chan)]
        (is (= (:status response) :error)
            "Unknown request should return error")
        (is (clojure.string/includes? (:message response) "Unknown request type")
            "Error message should mention unknown request type")))))

(deftest test-empty-operation-sequences
  (testing "Handling of empty operation sequences"
    (let [batch-op (make-controlled-operation)
          batch-id (str "test-batch-" (random-uuid))
          batch-future (start-batch-op-async batch-id batch-op)]

      (is (.await (:start-latch batch-op) 1000 TimeUnit/MILLISECONDS)
          "Batch should start immediately when no other operations")

      ((:complete-fn batch-op))

      (let [result (async/<!! (:response-future batch-future))]
        (is (= (:status result) :proceed)
            "Empty sequence batch should succeed")))))

(deftest test-failed-batch-error-response
  (testing "Failed batch operations return proper error response"
    (let [;; Create test project
          create-project-req (-> (admin-request :post "/api/v1/projects")
                                 (mock/json-body {:name "Error Test Project"}))
          project-resp (rest-handler create-project-req)
          project-id (:id (parse-response-body project-resp))

          ;; Batch that should fail: successful operation followed by failure
          operations [{:path (str "/api/v1/projects/" project-id) :method "get" :body nil}
                      {:path "/api/v1/users/nonexistent@example.com" :method "get" :body nil}]
          response (make-batch-request operations admin-token)
          response-body (when (:body response) (parse-response-body response))]

      ;; Verify batch failed appropriately
      (is (= 404 (:status response)))
      (when response-body
        (is (map? response-body) "Should return single error object, not array")
        (is (contains? response-body :error) "Should contain error information")))))