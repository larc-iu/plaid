(ns plaid.xtdb.operation
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.server.events :as events]
            [plaid.server.locks :as locks]))

(defn make-operation
  "Create an operation data structure"
  [{:keys [type description tx-ops project document]}]
  (let [op-id (random-uuid)]
    {:xt/id          op-id
     :op/id          op-id
     :op/type        type
     :op/project     project
     :op/document    document
     :op/description description
     :op/tx-ops      tx-ops}))

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
        audit-entry {:xt/id           audit-id
                     :audit/id        audit-id
                     :audit/ops       op-ids
                     :audit/user      user-id
                     :audit/projects  affected-projects
                     :audit/documents affected-documents}
        audit-tx [::xt/put audit-entry]]
    (into op-put-txs [audit-tx])))

(defmacro submit-operations!
  "Submit operations: store them in audit log and execute all their tx-ops.
  The operations-expr is deferred to allow exception handling."
  [xt-map operations-expr user-id]
  `(let [xt-map# ~xt-map
         node# (:node xt-map#)
         operations-vol# (volatile! nil)
         audit-entry-vol# (volatile! nil)]
     (let [result# (pxc/submit! node#
                                (let [operations# ~operations-expr
                                      audit-txs# (store-operations xt-map# operations# ~user-id)
                                      all-tx-ops# (mapcat :op/tx-ops operations#)
                                      audit-entry# (first (filter #(contains? % :audit/id)
                                                                  (map second audit-txs#)))
                                      ;; Check document locks before executing
                                      affected-documents# (:audit/documents audit-entry#)
                                      lock-check# (when (seq affected-documents#)
                                                    (locks/check-document-locks affected-documents# ~user-id))]
                                  ;; If there's a lock conflict, don't execute the transaction
                                  (when (and lock-check# (not= lock-check# :ok))
                                    (let [user-id# (:user-id lock-check#)
                                          username# (:user/username (pxc/entity (xt/db node#) (:user-id lock-check#)))
                                          locked-document-id# (:document-id lock-check#)]
                                      (throw (ex-info (str "Document locked by another user: " username#)
                                                      {:code 409
                                                       :locked-document-id locked-document-id#
                                                       :lock-holder user-id#}))))
                                  ;; Store for later use
                                  (vreset! operations-vol# operations#)
                                  (vreset! audit-entry-vol# audit-entry#)
                                  (into audit-txs# all-tx-ops#)))]
       ;; Publish audit event if transaction succeeded
       (when (:success result#)
         (let [operations# @operations-vol#
               audit-entry# @audit-entry-vol#]
           (when (and operations# audit-entry#)
             (events/publish-audit-event! audit-entry# operations# ~user-id))
           ;; Refresh locks for affected documents
           (when (seq (:audit/documents audit-entry#))
             (locks/refresh-locks! (:audit/documents audit-entry#) ~user-id))))
       (let [val# (deref audit-entry-vol#)]
         (-> result#
             ;; Include `:document-versions` for all affected documents, mapping document IDs to versions
             (cond-> (and (:audit/id val#)
                          (seq (:audit/documents val#)))
               (assoc :document-versions (into {} (for [doc-id# (:audit/documents val#)]
                                                    [doc-id# (:audit/id val#)])))))))))

(defmacro submit-operations-with-extras!
  "Submit operations and return extra data from the transaction.
  The operations-expr is deferred to allow exception handling."
  [xt-map operations-expr user-id extras-fn]
  `(let [xt-map# ~xt-map
         node# (:node xt-map#)
         operations-vol# (volatile! nil)
         audit-entry-vol# (volatile! nil)]
     (let [result# (pxc/submit-with-extras! node#
                                            (let [operations# ~operations-expr
                                                  audit-txs# (store-operations xt-map# operations# ~user-id)
                                                  all-tx-ops# (mapcat :op/tx-ops operations#)
                                                  audit-entry# (first (filter #(contains? % :audit/id)
                                                                              (map second audit-txs#)))
                                                  ;; Check document locks before executing
                                                  affected-documents# (:audit/documents audit-entry#)
                                                  lock-check# (when (seq affected-documents#)
                                                                (locks/check-document-locks affected-documents# ~user-id))]
                                              ;; If there's a lock conflict, don't execute the transaction
                                              (when (and lock-check# (not= lock-check# :ok))
                                                (let [user-id# (:user-id lock-check#)
                                                      username# (:user/username (pxc/entity (xt/db node#) (:user-id lock-check#)))
                                                      locked-document-id# (:document-id lock-check#)]
                                                  (throw (ex-info (str "Document locked by another user: " username#)
                                                                  {:code 409
                                                                   :locked-document-id locked-document-id#
                                                                   :lock-holder user-id#}))))
                                              ;; Store for later use
                                              (vreset! operations-vol# operations#)
                                              (vreset! audit-entry-vol# audit-entry#)
                                              (into audit-txs# all-tx-ops#))
                                            ~extras-fn)]
       ;; Publish audit event if transaction succeeded
       (when (:success result#)
         (let [operations# @operations-vol#
               audit-entry# @audit-entry-vol#]
           (when (and operations# audit-entry#)
             (events/publish-audit-event! audit-entry# operations# ~user-id))
           ;; Refresh locks for affected documents
           (when (seq (:audit/documents audit-entry#))
             (locks/refresh-locks! (:audit/documents audit-entry#) ~user-id))))

       (let [val# (deref audit-entry-vol#)]
         (-> result#
             ;; Include `:document-versions` for all affected documents, mapping document IDs to versions
             (cond-> (and (:audit/id val#)
                          (seq (:audit/documents val#)))
               (assoc :document-versions (into {} (for [doc-id# (:audit/documents val#)]
                                                    [doc-id# (:audit/id val#)])))))))))
