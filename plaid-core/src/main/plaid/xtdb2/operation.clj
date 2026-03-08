(ns plaid.xtdb2.operation
  (:require [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.operation-coordinator :as op-coord]
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
  In v2 we keep :op/tx-ops on stored op records (for potential future inspection)."
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
    (conj op-put-txs [:put-docs :audits audit-entry])))

(defn submit-operations*
  "Core submit logic. Does not catch errors from operation building.
  Returns {:success true} or {:success false :error msg :code code}."
  ([xt-map operations user-id]
   (submit-operations* xt-map operations user-id nil))
  ([xt-map operations user-id extras-fn]
   (let [node (pxc/->node xt-map)
         entity-ops (vec (mapcat :op/tx-ops operations))
         store-ops (store-operations operations user-id)
         all-tx (into entity-ops store-ops)]
     (pxc/submit! node all-tx
                  (when extras-fn (fn [_] (extras-fn entity-ops)))))))

(defmacro submit-operations!
  "Submit operations, catching errors from both operation building and the transaction.
  Returns {:success true/false ...}.
  extras-fn, if provided, is called with the entity-ops vector to extract a return value."
  ([xt-map operations-expr user-id]
   `(submit-operations! ~xt-map ~operations-expr ~user-id nil))
  ([xt-map operations-expr user-id extras-fn]
   `(try
      ;; Intentional fail-open: if the coordinator is unavailable or returns
      ;; a non-proceed status, we still attempt the operation rather than
      ;; blocking writes. The coordinator is advisory for serialization.
      (when-not *current-batch-id*
        (op-coord/request-operation-start!))
      (try
        (submit-operations* ~xt-map ~operations-expr ~user-id ~extras-fn)
        (finally
          (when-not *current-batch-id*
            (op-coord/signal-operation-complete!))))
      (catch clojure.lang.ExceptionInfo e#
        (log/warn "Operation failed: " (ex-message e#))
        {:success false
         :error (ex-message e#)
         :code (:code (ex-data e#))})
      (catch Exception e#
        (log/warn "Operation failed: " (ex-message e#))
        {:success false :error (ex-message e#)}))))
