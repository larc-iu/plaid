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

(def kinds
  "What a group may say it is (`?group-kind=`), the whole vocabulary. A
  closed list rather than any string because readers count operations by
  kind: `assistant_plan` next to `assistant-plan` would split one count in
  two, and nothing would say so. A new kind is a new entry here and in the
  manual's list (\"Kinds of operation\").

    assistant-plan  an approved assistant plan being applied
    service-run     one run of a service, the service's writes included
    import          a file or archive read into a project
    bulk-edit       one change made across many places at once
    guess-adoption  a person taking a suggested value as their own
    repair          a repair an app makes by itself when a document opens
    review          a person accepting machine or contributed work already
                    stored, as it stands"
  #{"assistant-plan" "service-run" "import" "bulk-edit" "guess-adoption" "repair" "review"})

(def ref-max-length
  "The longest `?group-ref=` accepted. A ref is a key a reader joins on, so
  a longer one is refused rather than cut."
  1024)

(defn- row->group [row]
  (when row
    (cond-> {:operation-group/id (:id row)
             :operation-group/message (:message row)
             :operation-group/user (:user_id row)
             :operation-group/created-at (:created_at row)}
      (:kind row) (assoc :operation-group/kind (:kind row))
      (:ref row) (assoc :operation-group/ref (:ref row)))))

(defn get [db id]
  (row->group (psc/fetch-by-id db :operation_groups id)))

(defn scoped-token
  "The `:jti` of the scoped token whose write created the group, nil when a
  session or a named API token created it (or no such group). Kept off the
  group map: it is for the relabel check, never for a reader."
  [db id]
  (:scoped_token (psc/fetch-by-id db :operation_groups id)))

(defn may-join?
  "Whether a write by `user-id`, made with the scoped token `token-key` (nil
  for a session or a named API token), may join the group whose row is
  `row` (its `user_id` and `scoped_token` columns). The same user may, with
  any session or named token. A scoped token may join only a group its own
  writes created, the same rule that lets it relabel one. So History says
  who did what: a group's writes are all its creator's, or a service's that
  the creator handed the group to (see `plaid.server.events/grant-group!`)."
  [row user-id token-key]
  (and (some? row)
       (= (:user_id row) user-id)
       (or (nil? token-key) (= (:scoped_token row) token-key))))

(defn joinable?
  "Whether `user-id` with `token-key` may join the group `id`: it does not
  exist yet (the first write creates it as theirs), or `may-join?` says so."
  [db id user-id token-key]
  (let [row (psc/fetch-by-id db :operation_groups id)]
    (or (nil? row) (may-join? row user-id token-key))))

(defn set-message!
  "Refine the group's label (e.g. `endOperation('Merged 3 morphemes')` once
  the count is known). Returns the updated group, or nil if no such group."
  [db id message]
  (when (pos? (psc/execute! db {:update :operation_groups
                                :set {:message message}
                                :where [:= :id id]}))
    (get db id)))
