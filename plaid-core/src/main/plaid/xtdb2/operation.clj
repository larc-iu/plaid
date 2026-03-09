(ns plaid.xtdb2.operation
  (:require [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.operation-coordinator :as op-coord]
            [plaid.server.locks :as locks]
            [plaid.server.events :as events]
            [taoensso.timbre :as log]))

(def ^:dynamic *user-agent* nil)
(def ^:dynamic *current-batch-id* nil)

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
  "Build tx-ops to store operations and audit log entry.
  In v2 we keep :op/tx-ops on stored op records (for potential future inspection).
  Returns {:tx-ops [...] :audit-id uuid :affected-documents #{...}}."
  [operations user-id]
  (let [audit-id (random-uuid)
        op-put-txs (mapv #(vector :put-docs :operations
                                  (cond-> % *current-batch-id* (assoc :op/batch-id *current-batch-id*)))
                         operations)
        op-ids (mapv :op/id operations)
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
                             :audit/time (java.time.Instant/now)
                             :audit/projects affected-projects
                             :audit/documents affected-documents}
                      *user-agent* (assoc :audit/user-agent *user-agent*)
                      *current-batch-id* (assoc :audit/batch-id *current-batch-id*))]
    {:tx-ops (conj op-put-txs [:put-docs :audits audit-entry])
     :audit-id audit-id
     :affected-documents affected-documents}))

(defn submit-operations*
  "Core submit logic. Does not catch errors from operation building.
  Returns {:success true :document-versions {doc-id audit-id ...} :operations [...] :audit-entry {...}}
  or {:success false :error msg :code code}."
  ([xt-map operations user-id]
   (submit-operations* xt-map operations user-id nil))
  ([xt-map operations user-id extras-fn]
   (let [node (pxc/->node xt-map)
         entity-ops (vec (mapcat :op/tx-ops operations))
         {:keys [tx-ops audit-id affected-documents] :as store-result} (store-operations operations user-id)
         audit-entry (-> tx-ops last last) ;; audit entry is the last put-docs value
         all-tx (into entity-ops tx-ops)
         result (pxc/submit! node all-tx
                             (when extras-fn (fn [_] (extras-fn entity-ops))))]
     (if (:success result)
       (assoc result
              :document-versions (into {} (map (fn [doc-id] [doc-id audit-id])) affected-documents)
              :operations operations
              :audit-entry audit-entry)
       result))))

(defn check-locks! [operations user-id]
  (let [doc-ids (->> operations
                     (keep :op/document)
                     distinct)]
    (when (seq doc-ids)
      (let [result (locks/check-document-locks doc-ids user-id)]
        (when (not= :ok result)
          (let [lock-holder (:user-id result)]
            (throw (ex-info (str "Document " (:document-id result) " is locked by " lock-holder)
                            {:code 423
                             :document-id (:document-id result)
                             :locked-by lock-holder}))))))))

(defn post-submit! [result user-id]
  (when (:success result)
    (let [{:keys [operations audit-entry]} result
          doc-ids (->> operations (keep :op/document) distinct)]
      (try
        (events/publish-audit-event! audit-entry operations user-id)
        (catch Exception e
          (log/warn "Failed to publish audit event:" (ex-message e))))
      (try
        (when (seq doc-ids)
          (locks/refresh-locks! doc-ids user-id))
        (catch Exception e
          (log/warn "Failed to refresh locks:" (ex-message e)))))))

(defmacro submit-operations!
  "Submit operations, catching errors from both operation building and the transaction.
  Returns {:success true/false ...}.
  extras-fn, if provided, is called with the entity-ops vector to extract a return value."
  ([xt-map operations-expr user-id]
   `(submit-operations! ~xt-map ~operations-expr ~user-id nil))
  ([xt-map operations-expr user-id extras-fn]
   `(try
      (let [ops# ~operations-expr]
        (check-locks! ops# ~user-id)
        (when-not *current-batch-id*
          (when-not (op-coord/request-operation-start!)
            (throw (ex-info "Timeout waiting for batch operation to complete"
                            {:code 408}))))
        (try
          (let [result# (submit-operations* ~xt-map ops# ~user-id ~extras-fn)]
            (post-submit! result# ~user-id)
            (dissoc result# :operations :audit-entry))
          (finally
            (when-not *current-batch-id*
              (op-coord/signal-operation-complete!)))))
      (catch clojure.lang.ExceptionInfo e#
        (log/warn e# "Operation failed")
        {:success false
         :error (ex-message e#)
         :code (:code (ex-data e#))})
      (catch Exception e#
        (log/error e# "Operation failed")
        {:success false :error (ex-message e#)}))))
