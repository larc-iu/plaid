(ns plaid.xtdb2.operation-coordinator
  (:require [clojure.core.async :as async]
            [clojure.string :as str]
            [mount.core :refer [defstate]]
            [taoensso.timbre :as log]
            [xtdb.api :as xt]))

;; State machine predicate functions -----------------------------------------------

(defn idle? [state]
  (and (zero? (:active-ops state))
       (not (:batch-in-progress? state))
       (empty? (:queued-batches state))
       (empty? (:queued-regulars state))))

(defn batch-active? [state]
  (:batch-in-progress? state))

(defn regulars-active? [state]
  (pos? (:active-ops state)))

(defn has-queued-regulars? [state]
  (seq (:queued-regulars state)))

(defn has-queued-batches? [state]
  (seq (:queued-batches state)))

(defn should-queue-regular? [state]
  (or (batch-active? state)
      (has-queued-batches? state)))

(defn should-queue-batch? [state]
  (or (batch-active? state)
      (regulars-active? state)))

(defn should-start-queued-batch? [state]
  (and (not (batch-active? state))
       (not (regulars-active? state))
       (has-queued-batches? state)))

(defn current-state-name [state]
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

(defn log-state-transition [event-type old-state new-state]
  (let [old-name (current-state-name old-state)
        new-name (current-state-name new-state)]
    (when (not= old-name new-name)
      (log/debug "State transition:" event-type old-name "→" new-name
                 {:active-ops (:active-ops new-state)
                  :batch-in-progress? (:batch-in-progress? new-state)
                  :queued-batches (count (:queued-batches new-state))
                  :queued-regulars (count (:queued-regulars new-state))}))))

;; Transition handlers --------------------------------------------------------------

(defn- handle-regular-start [state request]
  (if (should-queue-regular? state)
    {:state (assoc state :queued-regulars (conj (:queued-regulars state) (:response-chan request)))
     :responses []}
    {:state (assoc state :active-ops (inc (:active-ops state)))
     :responses [{:chan (:response-chan request) :response {:status :proceed}}]}))

(defn- handle-regular-complete [state]
  (let [new-active-ops (max 0 (dec (:active-ops state)))
        new-state (assoc state :active-ops new-active-ops)]
    (if (should-start-queued-batch? new-state)
      (let [next-batch (first (:queued-batches new-state))]
        {:state (assoc new-state
                       :active-ops 0
                       :batch-in-progress? true
                       :queued-batches (vec (rest (:queued-batches new-state))))
         :responses [{:chan (:response-chan next-batch) :response {:status :proceed}}]})
      {:state new-state
       :responses []})))

(defn- handle-batch-start [state request]
  (if (should-queue-batch? state)
    {:state (assoc state :queued-batches (conj (:queued-batches state) request))
     :responses []}
    {:state (assoc state :batch-in-progress? true)
     :responses [{:chan (:response-chan request) :response {:status :proceed}}]}))

(defn- handle-batch-complete [state]
  (cond
    (has-queued-regulars? state)
    (let [regular-responses (mapv (fn [chan] {:chan chan :response {:status :proceed}})
                                  (:queued-regulars state))
          new-active-ops (count (:queued-regulars state))]
      {:state (assoc state
                     :active-ops new-active-ops
                     :batch-in-progress? false
                     :queued-regulars [])
       :responses regular-responses})

    (has-queued-batches? state)
    (let [next-batch (first (:queued-batches state))]
      {:state (assoc state
                     :active-ops 0
                     :batch-in-progress? true
                     :queued-batches (vec (rest (:queued-batches state))))
       :responses [{:chan (:response-chan next-batch) :response {:status :proceed}}]})

    :else
    {:state (assoc state :active-ops 0 :batch-in-progress? false)
     :responses []}))

;; Mount state ----------------------------------------------------------------------

(defstate operation-coordinator
  :start
  (let [request-chan (async/chan)
        timeout-ms 30000
        stop-chan (async/chan)]
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
            (= port stop-chan)
            (do
              (doseq [batch queued-batches]
                (async/>!! (:response-chan batch) {:status :error :message "Server shutting down"}))
              (doseq [resp-chan queued-regulars]
                (async/>!! resp-chan {:status :error :message "Server shutting down"})))

            (= port timeout-chan)
            (do
              (when (or (pos? active-ops) batch-in-progress?)
                (log/warn "Coordinator timeout: resetting stale state"
                          {:active-ops active-ops :batch-in-progress? batch-in-progress?}))
              (doseq [batch queued-batches]
                (async/>!! (:response-chan batch) {:status :timeout :message "Timeout waiting for operations to complete"}))
              (doseq [resp-chan queued-regulars]
                (async/>!! resp-chan {:status :timeout :message "Timeout waiting for operations to complete"}))
              (recur 0 false [] []))

            :else
            (let [transition-result (case (:type request)
                                      :regular-start (handle-regular-start current-state request)
                                      :regular-complete (handle-regular-complete current-state)
                                      :batch-start (handle-batch-start current-state request)
                                      :batch-complete (handle-batch-complete current-state)
                                      {:state current-state
                                       :responses [{:chan (:response-chan request)
                                                    :response {:status :error :message "Unknown request type"}}]})
                  new-state (:state transition-result)]
              (log-state-transition (:type request) current-state new-state)
              (doseq [{:keys [chan response]} (:responses transition-result)]
                (async/>!! chan response))
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

;; Public API -----------------------------------------------------------------------

(defn request-operation-start! []
  (if operation-coordinator
    (let [response-chan (async/chan 1)
          request {:type :regular-start :response-chan response-chan}]
      (async/>!! (:request-chan operation-coordinator) request)
      (let [response (async/<!! response-chan)]
        (= (:status response) :proceed)))
    false))

(defn signal-operation-complete! []
  (when operation-coordinator
    (async/>!! (:request-chan operation-coordinator) {:type :regular-complete})))

(defn request-batch-start! [batch-id]
  (if operation-coordinator
    (let [response-chan (async/chan 1)
          request {:type :batch-start :response-chan response-chan :batch-id batch-id}]
      (async/>!! (:request-chan operation-coordinator) request)
      (async/<!! response-chan))
    {:status :error :message "Operation coordinator not available"}))

(defn signal-batch-complete! []
  (when operation-coordinator
    (async/>!! (:request-chan operation-coordinator) {:type :batch-complete})))

;; Batch rollback ---------------------------------------------------------------

(defn- entity-before-batch
  "Returns entity state at start-instant (pre-batch), or nil if it didn't exist then."
  [node table entity-id start-instant]
  (let [table-name (str/replace (name table) "-" "_")]
    (first (xt/q node
                 [(str "SELECT * FROM " table-name " WHERE _id = ?") entity-id]
                 {:snapshot-time start-instant}))))

(defn rollback-batch!
  "Rollback all operations tagged with batch-id by restoring each affected entity
  to its state at start-instant, then deleting the batch's op and audit records.
  Returns true on success, false on failure."
  [node batch-id start-instant]
  (if-not (and node batch-id start-instant)
    false
    (try
      (let [batch-ops (xt/q node ["SELECT * FROM operations WHERE op$batch_id = ?" batch-id])
            batch-audits (xt/q node ["SELECT * FROM audits WHERE audit$batch_id = ?" batch-id])
            affected-entities
            (distinct
             (mapcat (fn [op]
                       (mapcat (fn [tx-op]
                                 (when (vector? tx-op)
                                   (case (first tx-op)
                                     :put-docs [{:table (second tx-op)
                                                 :id (:xt/id (nth tx-op 2))}]
                                     :delete-docs (mapv #(hash-map :table (second tx-op) :id %)
                                                        (drop 2 tx-op))
                                     nil)))
                               (:op/tx-ops op)))
                     batch-ops))
            restore-ops
            (mapcat (fn [{:keys [table id]}]
                      (when (and table id)
                        (let [pre-batch (entity-before-batch node table id start-instant)]
                          (if pre-batch
                            [[:put-docs table (dissoc pre-batch
                                                      :xt/system-from :xt/system-to
                                                      :xt/valid-from :xt/valid-to)]]
                            [[:delete-docs table id]]))))
                    affected-entities)
            op-cleanup (mapv #(vector :delete-docs :operations (:op/id %)) batch-ops)
            audit-cleanup (mapv #(vector :delete-docs :audits (:audit/id %)) batch-audits)
            all-ops (into [] (concat restore-ops op-cleanup audit-cleanup))]
        (when (seq all-ops)
          (log/info "Rolling back batch" batch-id ":"
                    (count restore-ops) "entity restorations,"
                    (count op-cleanup) "op records,"
                    (count audit-cleanup) "audit records")
          (xt/execute-tx node all-ops))
        true)
      (catch Exception e
        (log/error e "Failed to rollback batch" batch-id)
        false))))

(defn recover-crashed-batches!
  "On startup, find any batch-marker records left from crashed batches and roll them back.
  Should be called once after the XTDB node starts, before serving requests."
  [node]
  (when node
    (try
      (let [markers (xt/q node ["SELECT * FROM batch_markers"])]
        (when (seq markers)
          (log/warn "Found" (count markers) "in-progress batch(es) from a previous crash. Rolling back...")
          (let [results (mapv (fn [marker]
                                {:marker marker
                                 :success (rollback-batch! node (:batch/id marker) (:batch/start-instant marker))})
                              markers)
                succeeded (filter :success results)
                failed (remove :success results)]
            (when (seq succeeded)
              (xt/execute-tx node (mapv #(vector :delete-docs :batch-markers (-> % :marker :xt/id)) succeeded))
              (log/info "Successfully rolled back" (count succeeded) "batch(es)."))
            (when (seq failed)
              (log/error "Failed to roll back" (count failed) "batch(es):"
                         (mapv #(-> % :marker :batch/id) failed))))))
      (catch Exception e
        (log/error e "Failed to recover crashed batches")))))
