(ns plaid.sql.operation-group
  "Logical-operation groups: the human label for a run of low-level writes
  that the audit log shows as one expandable entry (see
  `plaid.sql.operation/*current-group-id*` and the grouped read in
  `plaid.sql.audit`).

  Rows are created lazily by the first tagged write (inside that op's tx);
  this namespace only reads them and refines the message afterwards.
  Group rows are audit-log metadata, not domain data: writes here are raw
  (no operations row, no audit_writes) — the same policy as the
  operations/audit_writes tables themselves."
  (:refer-clojure :exclude [get])
  (:require [plaid.sql.common :as psc]))

(defn- row->group [row]
  (when row
    {:operation-group/id (:id row)
     :operation-group/message (:message row)
     :operation-group/user (:user_id row)
     :operation-group/created-at (:created_at row)}))

(defn get [db id]
  (row->group (psc/fetch-by-id db :operation_groups id)))

(defn set-message!
  "Refine the group's label (e.g. `endOperation('Merged 3 morphemes')` once
  the count is known). Returns the updated group, or nil if no such group."
  [db id message]
  (when (pos? (psc/execute! db {:update :operation_groups
                                :set {:message message}
                                :where [:= :id id]}))
    (get db id)))
