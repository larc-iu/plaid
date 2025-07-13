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

;; Operation coordinator using core.async which provides a global write mutex for batch operations
;; The operation-coordinator is a coordinator that ensures database operations are executed without
;; conflicts. It manages two types of operations:
;; 1. Regular operations: Individual database writes that can run concurrently
;; 2. Batch operations: Multi-step operations that require exclusive write access
;;
;; The coordinator uses a core.async thread to maintain a global write mutex, ensuring that:
;; - Only one batch operation can run at a time
;; - Regular operations are queued while a batch is in progress
;; - Batch operations wait for all active regular operations to complete before beginning
;; - Proper cleanup occurs on timeout or shutdown
;;
;; This prevents race conditions and maintains data integrity.
(defn- handle-regular-start [state request]
  (let [{:keys [active-ops batch-in-progress? queued-batches queued-regulars]} state]
    (if (or batch-in-progress? (seq queued-batches))
      ;; Queue it until batch completes (either active batch or queued batches)
      {:state (assoc state :queued-regulars (conj queued-regulars (:response-chan request)))
       :responses []}
      ;; Allow it to proceed
      {:state (assoc state :active-ops (inc active-ops))
       :responses [{:chan (:response-chan request) :response {:status :proceed}}]})))

(defn- handle-regular-complete [state]
  (let [{:keys [active-ops batch-in-progress? queued-batches queued-regulars]} state
        new-active (max 0 (dec active-ops))]
    (if (and (zero? new-active) (seq queued-batches) (not batch-in-progress?))
      ;; No more active ops and batches are waiting - start next batch
      (let [next-batch (first queued-batches)]
        {:state (assoc state
                  :active-ops 0
                  :batch-in-progress? true
                  :queued-batches (vec (rest queued-batches)))
         :responses [{:chan (:response-chan next-batch) :response {:status :proceed}}]})
      {:state (assoc state :active-ops new-active)
       :responses []})))

(defn- handle-batch-start [state request]
  (let [{:keys [active-ops batch-in-progress? queued-batches]} state]
    (if (or batch-in-progress? (pos? active-ops))
      ;; Queue the batch request
      {:state (assoc state :queued-batches (conj queued-batches request))
       :responses []}
      ;; Start batch immediately
      {:state (assoc state :batch-in-progress? true)
       :responses [{:chan (:response-chan request) :response {:status :proceed}}]})))

(defn- handle-batch-complete [state]
  (let [{:keys [queued-batches queued-regulars]} state]
    (cond
      ;; If there are queued batches but no queued regulars, start next batch
      (and (seq queued-batches) (empty? queued-regulars))
      (let [next-batch (first queued-batches)]
        {:state (assoc state
                  :active-ops 0
                  :batch-in-progress? true
                  :queued-batches (vec (rest queued-batches)))
         :responses [{:chan (:response-chan next-batch) :response {:status :proceed}}]})

      ;; If there are queued regulars, release them and set up for potential batch start
      (seq queued-regulars)
      (let [regular-responses (mapv (fn [chan] {:chan chan :response {:status :proceed}}) queued-regulars)
            new-active-ops (count queued-regulars)]
        {:state (assoc state
                  :active-ops new-active-ops
                  :batch-in-progress? false
                  :queued-regulars [])
         :responses regular-responses
         :internal-events (repeat new-active-ops {:type :regular-complete})})

      ;; No queued operations at all
      :else
      {:state (assoc state
                :active-ops 0
                :batch-in-progress? false)
       :responses []})))

(defn- process-state-changes [initial-state initial-responses initial-events]
  (loop [state initial-state
         all-responses initial-responses
         events (or initial-events [])]
    (if-let [event (first events)]
      (let [result (case (:type event)
                     :regular-complete (handle-regular-complete state))]
        (recur (:state result)
               (into all-responses (:responses result))
               (into (vec (rest events)) (:internal-events result))))
      {:state state :responses all-responses})))

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
              ;; Clean shutdown - fail any queued operations
              (when-let [first-batch (first queued-batches)]
                (async/>!! (:response-chan first-batch)
                           {:status :error :message "Server shutting down"}))
              (doseq [resp-chan queued-regulars]
                (async/>!! resp-chan {:status :error :message "Server shutting down"})))

            ;; Timeout occurred - fail any queued batch and continue
            (= port timeout-chan)
            (do
              (when-let [first-batch (first queued-batches)]
                (async/>!! (:response-chan first-batch)
                           {:status :timeout :message "Timeout waiting for operations to complete"}))
              (recur active-ops batch-in-progress? (rest queued-batches) queued-regulars))

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

                  final-result (process-state-changes
                                 (:state transition-result)
                                 (:responses transition-result)
                                 (:internal-events transition-result))

                  new-state (:state final-result)]

              ;; Send all responses
              (doseq [{:keys [chan response]} (:responses final-result)]
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
  (let [response-chan (async/chan)
        request {:type :regular-start :response-chan response-chan}]
    (async/>!! (:request-chan operation-coordinator) request)
    (let [response (async/<!! response-chan)]
      (= (:status response) :proceed))))

(defn signal-operation-complete!
  "Signal that a regular operation has completed"
  []
  (async/>!! (:request-chan operation-coordinator) {:type :regular-complete}))

(defn request-batch-start!
  "Request permission to start a batch operation. Returns status map."
  [batch-id]
  (let [response-chan (async/chan)
        request {:type :batch-start :response-chan response-chan :batch-id batch-id}]
    (async/>!! (:request-chan operation-coordinator) request)
    (async/<!! response-chan)))

(defn signal-batch-complete!
  "Signal that a batch operation has completed"
  []
  (async/>!! (:request-chan operation-coordinator) {:type :batch-complete}))

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
