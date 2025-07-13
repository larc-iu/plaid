(ns plaid.xtdb.operation
  (:require [xtdb.api :as xt]
            [clojure.core.async :as async]
            [plaid.xtdb.common :as pxc]
            [plaid.server.events :as events]
            [plaid.server.locks :as locks]
            [mount.core :refer [defstate]]
            [taoensso.timbre :as log]))

(def ^:dynamic *user-agent* nil)

(defn make-operation
  "Create an operation data structure"
  [{:keys [type description tx-ops project document]}]
  (let [op-id (random-uuid)]
    {:xt/id op-id
     :op/id op-id
     :op/type type
     :op/project project
     :op/document document
     :op/description description
     :op/tx-ops tx-ops}))

(defn store-operations
  "Store operations and create an audit log entry referencing them"
  [{:keys [db node]} operations user-id]
  (let [audit-id (random-uuid)
        ;; Store operations without their tx-ops (which are executed separately)
        storable-ops (mapv #(dissoc % :op/tx-ops) operations)
        op-put-txs (mapv #(vector ::xt/put %) storable-ops)
        op-ids (mapv :op/id operations)
        ;; Determine project/document from operations (use first non-nil values)
        affected-projects (->> operations
                               (map :op/project)
                               (filter some?)
                               set)
        affected-documents (->> operations
                                (map :op/document)
                                (filter some?)
                                set)
        audit-entry (cond-> {:xt/id audit-id
                             :audit/id audit-id
                             :audit/ops op-ids
                             :audit/user user-id
                             :audit/projects affected-projects
                             :audit/documents affected-documents}
                      *user-agent* (assoc :audit/user-agent *user-agent*))
        audit-tx [::xt/put audit-entry]]
    (into op-put-txs [audit-tx])))

;; Begin machinery for atomic batch writing ------------------------------------------------------------
(def ^:dynamic *in-batch-context* false)

 ;; State machine predicate functions for readability
(defn idle?
  "True when no operations are running and no operations are queued"
  [state]
  (and (zero? (:active-ops state))
       (not (:batch-in-progress? state))
       (empty? (:queued-batches state))
       (empty? (:queued-regulars state))))

(defn batch-active?
  "True when a batch operation is currently running"
  [state]
  (:batch-in-progress? state))

(defn regulars-active?
  "True when regular operations are currently running"
  [state]
  (pos? (:active-ops state)))

(defn has-queued-regulars?
  "True when regular operations are waiting in queue"
  [state]
  (seq (:queued-regulars state)))

(defn has-queued-batches?
  "True when batch operations are waiting in queue"
  [state]
  (seq (:queued-batches state)))

(defn should-queue-regular?
  "True when a regular operation should be queued (batch active or batches queued)"
  [state]
  (or (batch-active? state)
      (has-queued-batches? state)))

(defn should-queue-batch?
  "True when a batch operation should be queued"
  [state]
  (or (batch-active? state)
      (regulars-active? state)))

(defn should-start-queued-batch?
  "True when we should start the next queued batch"
  [state]
  (and (not (batch-active? state))
       (not (regulars-active? state))
       (has-queued-batches? state)))

(defn current-state-name
  "Returns a human-readable name for the current state (for logging/debugging)"
  [state]
  (cond
    (idle? state) :idle
    (and (batch-active? state) (has-queued-regulars? state)) :batch-active-regulars-queued
    (and (batch-active? state) (has-queued-batches? state)) :batch-active-batches-queued
    (batch-active? state) :batch-active
    (and (regulars-active? state) (has-queued-batches? state)) :regulars-active-batches-queued
    (regulars-active? state) :regulars-active
    (has-queued-regulars? state) :regulars-queued
    (has-queued-batches? state) :batches-queued
    :else :unknown))

(defn log-state-transition
  "Log a state transition for debugging purposes"
  [event-type old-state new-state]
  (let [old-state-name (current-state-name old-state)
        new-state-name (current-state-name new-state)]
    (when (not= old-state-name new-state-name)
      (log/debug "State transition:" event-type
                 old-state-name "→" new-state-name
                 {:active-ops (:active-ops new-state)
                  :batch-in-progress? (:batch-in-progress? new-state)
                  :queued-batches (count (:queued-batches new-state))
                  :queued-regulars (count (:queued-regulars new-state))}))))

;; ===================================================================================
;; OPERATION COORDINATOR STATE MACHINE DOCUMENTATION
;; ===================================================================================
;;
;; The operation coordinator manages concurrent database operations using a finite state machine
;; to prevent race conditions and maintain data integrity. It coordinates two types of operations:
;;
;; 1. REGULAR OPERATIONS: Individual database writes that can run concurrently
;; 2. BATCH OPERATIONS: Multi-step operations requiring exclusive database access
;;
;; The coordinator maintains the following state variables:
;; • active-ops: Number of currently running regular operations (0+)
;; • batch-in-progress?: Boolean indicating if a batch is currently running
;; • queued-batches: Vector of batch operations waiting to start
;; • queued-regulars: Vector of regular operations waiting to start
;;
;; Key invariants:
;; 1. Only one batch can be active at a time (batch-in-progress? = true)
;; 2. Batches cannot start while regulars are active (active-ops > 0)
;; 3. Regular operations have priority when a batch completes
;; 4. Operations are processed in FIFO order within their type
;;
;; regular-start:
;;   • can-start-regular? → increment active-ops, proceed
;;   • should-queue-regular? → add to queued-regulars
(defn- handle-regular-start [state request]
  (if (should-queue-regular? state)
    ;; Queue it until batch completes (either active batch or queued batches)
    {:state (assoc state :queued-regulars (conj (:queued-regulars state) (:response-chan request)))
     :responses []}
    ;; Allow it to proceed
    {:state (assoc state :active-ops (inc (:active-ops state)))
     :responses [{:chan (:response-chan request) :response {:status :proceed}}]}))

;; regular-complete:
;;   • decrement active-ops
;;   • if active-ops=0 AND queued-batches → start next batch
(defn- handle-regular-complete [state]
  (let [new-active-ops (max 0 (dec (:active-ops state)))
        new-state (assoc state :active-ops new-active-ops)]
    (if (should-start-queued-batch? new-state)
      ;; No more active ops and batches are waiting - start next batch
      (let [next-batch (first (:queued-batches new-state))]
        {:state (assoc new-state
                       :active-ops 0
                       :batch-in-progress? true
                       :queued-batches (vec (rest (:queued-batches new-state))))
         :responses [{:chan (:response-chan next-batch) :response {:status :proceed}}]})
      ;; Just update the active ops count
      {:state new-state
       :responses []})))

;; batch-start:
;;   • can-start-batch? → set batch-in-progress=true, proceed
;;   • should-queue-batch? → add to queued-batches
(defn- handle-batch-start [state request]
  (if (should-queue-batch? state)
    ;; Queue the batch request
    {:state (assoc state :queued-batches (conj (:queued-batches state) request))
     :responses []}
    ;; Start batch immediately
    {:state (assoc state :batch-in-progress? true)
     :responses [{:chan (:response-chan request) :response {:status :proceed}}]}))

;; batch-complete:
;;   • has-queued-regulars? → release ALL queued regulars (priority)
;;   • has-queued-batches? AND no-queued-regulars → start next batch
;;   • else → return to idle state
(defn- handle-batch-complete [state]
  (cond
    ;; If there are queued regulars, release them (priority)
    (has-queued-regulars? state)
    (let [regular-responses (mapv (fn [chan] {:chan chan :response {:status :proceed}})
                                  (:queued-regulars state))
          new-active-ops (count (:queued-regulars state))]
      {:state (assoc state
                     :active-ops new-active-ops
                     :batch-in-progress? false
                     :queued-regulars [])
       :responses regular-responses})

    ;; If there are queued batches but no queued regulars, start next batch
    (has-queued-batches? state)
    (let [next-batch (first (:queued-batches state))]
      {:state (assoc state
                     :active-ops 0
                     :batch-in-progress? true
                     :queued-batches (vec (rest (:queued-batches state))))
       :responses [{:chan (:response-chan next-batch) :response {:status :proceed}}]})

    ;; No queued operations at all - return to idle
    :else
    {:state (assoc state
                   :active-ops 0
                   :batch-in-progress? false)
     :responses []}))

(defstate operation-coordinator
  :start
  (let [request-chan (async/chan)
        timeout-ms 30000 ; 30 seconds timeout
        stop-chan (async/chan)] ; Channel to signal shutdown
    (async/thread
      (loop [active-ops 0
             batch-in-progress? false
             queued-batches []
             queued-regulars []]
        (let [timeout-chan (async/timeout timeout-ms)
              [request port] (async/alts!! [request-chan timeout-chan stop-chan])
              current-state {:active-ops active-ops
                             :batch-in-progress? batch-in-progress?
                             :queued-batches queued-batches
                             :queued-regulars queued-regulars}]
          (cond
            ;; Stop signal received
            (= port stop-chan)
            (do
              ;; Clean shutdown - fail all queued operations
              (doseq [batch queued-batches]
                (async/>!! (:response-chan batch)
                           {:status :error :message "Server shutting down"}))
              (doseq [resp-chan queued-regulars]
                (async/>!! resp-chan {:status :error :message "Server shutting down"})))

            ;; Timeout occurred - fail all queued operations
            (= port timeout-chan)
            (do
              ;; Notify all queued batches about timeout
              (doseq [batch queued-batches]
                (async/>!! (:response-chan batch)
                           {:status :timeout :message "Timeout waiting for operations to complete"}))
              ;; Notify all queued regulars about timeout
              (doseq [resp-chan queued-regulars]
                (async/>!! resp-chan {:status :timeout :message "Timeout waiting for operations to complete"}))
              ;; Continue with empty queues
              (recur active-ops batch-in-progress? [] []))

            ;; Process the request
            :else
            (let [transition-result (case (:type request)
                                      :regular-start (handle-regular-start current-state request)
                                      :regular-complete (handle-regular-complete current-state)
                                      :batch-start (handle-batch-start current-state request)
                                      :batch-complete (handle-batch-complete current-state)
                                      ;; Unknown request type
                                      {:state current-state
                                       :responses [{:chan (:response-chan request)
                                                    :response {:status :error :message "Unknown request type"}}]})

                  new-state (:state transition-result)]

              ;; Log state transition for debugging
              (log-state-transition (:type request) current-state new-state)

              ;; Send all responses
              (doseq [{:keys [chan response]} (:responses transition-result)]
                (async/>!! chan response))

              ;; Continue with new state
              (recur (:active-ops new-state)
                     (:batch-in-progress? new-state)
                     (:queued-batches new-state)
                     (:queued-regulars new-state)))))))
    {:request-chan request-chan
     :stop-chan stop-chan})
  :stop
  (when operation-coordinator
    (async/>!! (:stop-chan operation-coordinator) :stop)
    (async/close! (:request-chan operation-coordinator))))

;; Helper functions for async coordination
(defn request-operation-start!
  "Request permission to start a regular operation. Returns true if granted, false if timeout."
  []
  (if operation-coordinator
    (let [response-chan (async/chan)
          request {:type :regular-start :response-chan response-chan}]
      (async/>!! (:request-chan operation-coordinator) request)
      (let [response (async/<!! response-chan)]
        (= (:status response) :proceed)))
    false))

(defn signal-operation-complete!
  "Signal that a regular operation has completed"
  []
  (when operation-coordinator
    (async/>!! (:request-chan operation-coordinator) {:type :regular-complete})))

(defn request-batch-start!
  "Request permission to start a batch operation. Returns status map."
  [batch-id]
  (if operation-coordinator
    (let [response-chan (async/chan)
          request {:type :batch-start :response-chan response-chan :batch-id batch-id}]
      (async/>!! (:request-chan operation-coordinator) request)
      (async/<!! response-chan))
    {:status :error :message "Operation coordinator not available"}))

(defn signal-batch-complete!
  "Signal that a batch operation has completed"
  []
  (when operation-coordinator
    (async/>!! (:request-chan operation-coordinator) {:type :batch-complete})))

;; Batch progress markers for crash recovery
(defn create-batch-marker
  "Create a batch progress marker document for crash recovery"
  [batch-id start-tx-id]
  {:xt/id (str "batch-in-progress-" batch-id)
   :batch/id batch-id
   :batch/start-tx-id start-tx-id
   :batch/timestamp (java.time.Instant/now)
   :batch/type :in-progress})

(defn write-batch-marker!
  "Write a batch progress marker to XTDB"
  [node batch-id start-tx-id]
  (let [marker (create-batch-marker batch-id start-tx-id)]
    (pxc/submit! node [[::xt/put marker]])))

(defn delete-batch-marker!
  "Delete a batch progress marker from XTDB"
  [node batch-id]
  (let [marker-id (str "batch-in-progress-" batch-id)]
    (pxc/submit! node [[::xt/delete marker-id]])))

(defn find-orphaned-batch-markers
  "Find all orphaned batch progress markers in the database"
  [db]
  (xt/q db
        '{:find [?marker-id ?batch-id ?start-tx-id ?timestamp]
          :where [[?e :batch/type :in-progress]
                  [?e :xt/id ?marker-id]
                  [?e :batch/id ?batch-id]
                  [?e :batch/start-tx-id ?start-tx-id]
                  [?e :batch/timestamp ?timestamp]]}))

;; Transaction log utilities for rollback
(defn fetch-tx-ops
  "Fetch transaction operations from the transaction log starting from tx-id"
  [node from-tx-id]
  (iterator-seq (xt/open-tx-log node from-tx-id true)))

(defn current-tx-id
  "Get the current (latest completed) transaction ID"
  [node]
  (::xt/tx-id (xt/latest-completed-tx node)))

(defn generate-rollback-ops
  "Generate rollback operations for all transactions between start-tx-id and end-tx-id"
  [node start-tx-id end-tx-id initial-db]
  (let [batch-txs (take-while #(<= (::xt/tx-id %) end-tx-id)
                              (fetch-tx-ops node (inc start-tx-id)))
        all-ops (mapcat ::xt/tx-ops batch-txs)]

    (filter some?
            (for [op all-ops]
              (case (first op)
                ::xt/put (let [entity-id (-> op second :xt/id)
                               original-entity (xt/entity initial-db entity-id)]
                           (if original-entity
                             [::xt/put original-entity] ; Restore original state
                             [::xt/delete entity-id])) ; Delete if it was new

                ::xt/delete (let [entity-id (second op)
                                  original-entity (xt/entity initial-db entity-id)]
                              (when original-entity
                                [::xt/put original-entity])) ; Restore deleted entity

                ;; Skip other operation types
                nil)))))

(defn rollback-batch!
  "Rollback all transactions committed during a batch operation"
  [node start-tx-id]
  (let [end-tx-id (current-tx-id node)]
    (when (> end-tx-id start-tx-id)
      ;; Get database state before the batch started by using the previous transaction
      (let [prev-tx-id (dec start-tx-id)
            initial-time (::xt/tx-time (first (iterator-seq (xt/open-tx-log node prev-tx-id false))))
            initial-db (xt/db node initial-time)
            rollback-ops (generate-rollback-ops node start-tx-id end-tx-id initial-db)]
        (when (seq rollback-ops)
          (pxc/submit! node rollback-ops))))))

(defn recover-orphaned-batches!
  "Recover from orphaned batch operations by rolling them back"
  [node]
  (let [db (xt/db node)
        orphaned-markers (find-orphaned-batch-markers db)]
    (doseq [[marker-id batch-id start-tx-id timestamp] orphaned-markers]
      (log/warn "Found orphaned batch" batch-id "started at" timestamp ". Rolling back...")
      (try
        ;; Rollback the orphaned batch
        (rollback-batch! node start-tx-id)
        ;; Clean up the marker
        (pxc/submit! node [[::xt/delete marker-id]])
        (log/info "Successfully recovered orphaned batch" batch-id)
        (catch Exception e
          (log/error e "Failed to recover orphaned batch" batch-id))))))
;; End machinery for atomic batch writing ------------------------------------------------------------

(defmacro submit-operations!
  "Submit operations: store them in the audit log, execute their tx-ops,
  and optionally return extra data from the transaction.
  The operations-expr is deferred to allow for exception handling."
  ([xt-map operations-expr user-id]
   `(submit-operations! ~xt-map ~operations-expr ~user-id nil))
  ([xt-map operations-expr user-id extras-fn]
   `(let [xt-map# ~xt-map
          node# (:node xt-map#)
          operations-vol# (volatile! nil)
          audit-entry-vol# (volatile! nil)
          extras-fn# ~extras-fn]

      ;; Only request coordination if not in a batch context
      (when-not *in-batch-context*
        (when-not (request-operation-start!)
          (throw (ex-info "Timeout waiting for batch operation to complete"
                          {:code 408}))))

      (try
        (let [result# (pxc/submit! node#
                                   (let [operations# ~operations-expr
                                         audit-txs# (store-operations xt-map# operations# ~user-id)
                                         all-tx-ops# (mapcat :op/tx-ops operations#)
                                         audit-entry# (first (filter #(contains? % :audit/id)
                                                                     (map second audit-txs#)))
                                         affected-documents# (:audit/documents audit-entry#)
                                         lock-check# (when (seq affected-documents#)
                                                       (locks/check-document-locks affected-documents# ~user-id))]
                                     (when (and lock-check# (not= lock-check# :ok))
                                       (let [user-id# (:user-id lock-check#)
                                             username# (:user/username (pxc/entity (xt/db node#) user-id#))
                                             locked-document-id# (:document-id lock-check#)]
                                         (throw (ex-info (str "Document locked by another user: " username#)
                                                         {:code 423
                                                          :locked-document-id locked-document-id#
                                                          :lock-holder user-id#}))))
                                     (vreset! operations-vol# operations#)
                                     (vreset! audit-entry-vol# audit-entry#)
                                     (into audit-txs# all-tx-ops#))
                                   extras-fn#)]

          (when (:success result#)
            (let [operations# @operations-vol#
                  audit-entry# @audit-entry-vol#]
              (when (and operations# audit-entry#)
                (events/publish-audit-event! audit-entry# operations# ~user-id))
              (when (seq (:audit/documents audit-entry#))
                (locks/refresh-locks! (:audit/documents audit-entry#) ~user-id))))

          (let [val# @audit-entry-vol#]
            (-> result#
                (cond-> (and (:audit/id val#) (seq (:audit/documents val#)))
                  (assoc :document-versions (into {} (for [doc-id# (:audit/documents val#)]
                                                       [doc-id# (:audit/id val#)])))))))

        (finally
          (when-not *in-batch-context*
            (signal-operation-complete!)))))))
