(ns plaid.sql.operation
  "Logical-operation wrapper for the SQL port.

  Where the XTDB v2 version built a vector of XTDB tx-ops, threaded them
  through a coordinator, and submitted them as a single XTDB transaction,
  here we open a JDBC transaction, generate an operation_id, bind it via
  the *op* dynamic var, and let the body do its writes imperatively. The
  write helpers in plaid.sql.common capture pre/post images into
  audit_writes automatically.

  The application-level coordinator from plaid.xtdb2 is gone: SQL
  transactions provide atomicity, and SQLite's single-writer model
  serializes concurrent batches naturally."
  (:require [clojure.string]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.common :as psc]
            [plaid.sql.crud :as crud]
            [plaid.sql.datasource :as psd]
            [plaid.sql.operation-group :as og]
            [plaid.server.events :as events]
            [plaid.server.locks :as locks]
            [taoensso.timbre :as log])
  (:import [clojure.lang ExceptionInfo]
           [java.sql SQLException]))

(def ^:dynamic *token-id*
  "Id of the named API token (`api_tokens.id`) that authenticated the current
  request, or nil for a session login. Bound by `wrap-api-token-id` from the
  VALIDATED JWT claim (never client input) and persisted onto the operations
  row as `token_id` — server-authoritative attribution of which named
  credential performed the action (the actor's token, not a spoofable
  client-supplied label)."
  nil)

(def ^:dynamic *scoped-token-key*
  "The `:jti` of the scoped (delegated) token that authenticated the current
  request, or nil for any other credential. Bound by `wrap-api-token-id`
  from the VALIDATED claim and stored on an operation group the request
  creates, so that token may relabel the group later (see
  `plaid.rest-api.v1.auth/operation-group-token-scope`)."
  nil)

(def ^:dynamic *current-batch-id*
  "Set by the REST batch handler when several sub-operations should be
  grouped under one logical batch. Just goes onto each operation row;
  no application-level coordination implied."
  nil)

(def ^:dynamic *custom-description*
  "Optional client-supplied audit-log message for the current request,
  bound by `wrap-audit-message` from the (templated) `?audit-message=`
  query param. When non-nil it OVERRIDES the caller's auto-generated
  `:description` on the operations row.

  Unlike `*token-id*` this is NOT server-authoritative — it is free text
  the client chose, and is for human readability of the audit log only.
  The structured forensic record (op_type + per-row audit_writes pre/post
  images) is unaffected."
  nil)

(def ^:dynamic *current-group-id*
  "Client-minted correlation id of the LOGICAL operation the current request
  belongs to (\"Merge morphemes\" = many token/span writes, possibly across
  several batches and a service round-trip). Bound by `wrap-operation-group`
  from `?group-id=`; goes onto each operations row as `group_id` so the
  audit read can fold the members into one expandable entry.

  Orthogonal to `*current-batch-id*`: a batch is a transaction boundary, a
  group is a display/intent boundary. A group is NOT atomic — members that
  committed before a failing one stay committed. Same trust model as
  `*custom-description*`: client free text, readability only."
  nil)

(def ^:dynamic *current-group-message*
  "Human label for `*current-group-id*` (from `?group-message=`), used only
  when this request is the FIRST tagged op of its group and therefore
  lazily creates the `operation_groups` row (see `ensure-group-row!`)."
  nil)

(def ^:dynamic *current-group-kind*
  "What kind of operation `*current-group-id*` is (from `?group-kind=`, one
  of `plaid.sql.operation-group/kinds`), stored like the message: only by
  the group's first tagged write."
  nil)

(def ^:dynamic *current-group-ref*
  "What `*current-group-id*` refers to (from `?group-ref=`), client text in
  a shape its kind documents. Stored like the message: only by the group's
  first tagged write."
  nil)

(defn- insert-operation-row!
  [tx {:keys [id type project document description user token-id batch-id group-id ts]}]
  (psc/execute!
   tx
   {:insert-into :operations
    :values [{:id id
              :op_type (if (keyword? type) (subs (str type) 1) (str type))
              :project_id project
              :document_id document
              :description description
              :batch_id batch-id
              :group_id group-id
              :user_id user
              :token_id token-id
              :ts ts}]}))

(defn- ensure-group-row!
  "Lazily create the `operation_groups` row for the op's group on first
  sight, inside the op's own tx (so the label is atomic with the first
  member and a crash can never leave an unlabeled group). Later members
  no-op via ON CONFLICT DO NOTHING; the label is refined only through the
  explicit PATCH /operation-groups/:id. No audit_writes row: this is
  audit-log metadata, not domain data.

  Then the write must be one the group may take in
  (`plaid.sql.operation-group/may-join?`): its creator's, or the writes of a
  service the creator handed the group to with an unfinished request
  (`plaid.server.events/group-grant`). Such a service writes as the
  creator here, so a group it starts is the requester's, who may then write
  into it and relabel it. Anything else is refused with 403 and the whole
  op rolls back, so no caller can put their writes under another caller's
  History entry. Checked after the insert, under the write lock, so the
  row it reads is the one that stands.

  A grant covers only writes in the project its request was made in (D27).
  A write elsewhere, or with no project (a vocabulary, a user), is refused
  unless the writer may join the group on its own. The refusal says why:
  another project, a request that has ended (its service answered, or the
  server failed it when the service's channel dropped), or another caller's
  group."
  [tx {:keys [group-id user ts project]}]
  (when group-id
    (let [token *scoped-token-key*
          granted (events/group-grant group-id user token project)
          own? (fn [g] (og/may-join? {:user_id (:owner g) :scoped_token (:owner-token g)} user token))
          elsewhere? (and granted (not= (some-> project str) (some-> (:project-id granted) str)))
          _ (when (and elsewhere? (not (own? granted)))
              (throw (ex-info (str "Operation group " group-id " was handed to this service by a request in "
                                   "project " (:project-id granted) ", so a write "
                                   (if project (str "in project " project) "outside that project")
                                   " cannot join it.")
                              {:code 403 :group-id group-id})))
          grant (when-not elsewhere? granted)
          owner (if grant (:owner grant) user)
          owner-token (if grant (:owner-token grant) token)]
      (psc/execute! tx {:insert-into :operation_groups
                        :values [{:id group-id
                                  :message *current-group-message*
                                  :kind *current-group-kind*
                                  :ref *current-group-ref*
                                  :user_id owner
                                  :scoped_token owner-token
                                  :created_at ts}]
                        :on-conflict [:id]
                        :do-nothing []})
      (when-not (og/may-join? (psc/q1 tx {:select [:user_id :scoped_token]
                                          :from [:operation_groups]
                                          :where [:= :id group-id]})
                              owner owner-token)
        (throw (ex-info (if (events/lapsed-group-grant group-id user token)
                          (str "Operation group " group-id " was handed to this service by a request "
                               "that has ended, so this write cannot join it.")
                          (str "Operation group " group-id " was started by another user or token, "
                               "so this write cannot join it."))
                        {:code 403 :group-id group-id}))))))

(defn- check-locks!
  "Refuse the op with a 423 when another user holds the lock on its document.

  Runs inside the op's transaction, after `BEGIN IMMEDIATE` has taken the
  SQLite write lock, and `acquire-document-lock!` takes a lock under that same
  write lock. So every write either committed before the lock was granted,
  where the holder's first read sees it, or opens its transaction after, where
  this check sees the lock. Checked before the transaction, a write could pass
  here, wait for the write lock or work its body out, and commit after the
  lock was granted, under a holder who had already read the document without
  it."
  [op-attrs]
  (when-let [doc-id (:document op-attrs)]
    (let [result (locks/check-document-locks [doc-id] (:user op-attrs))]
      (when (not= :ok result)
        (throw (ex-info (str "Document " (:document-id result) " is locked by " (:user-id result))
                        {:code 423
                         :document-id (:document-id result)
                         :locked-by (:user-id result)}))))))

(defn acquire-document-lock!
  "Take the lock on `document-id` for the holder `lock-id`, acting as
  `user-id`, while holding the SQLite write lock (`locks/acquire-lock!` gives
  the result).

  The empty transaction is the point. `BEGIN IMMEDIATE` waits for a write
  already in its transaction to commit, and no write can open one until the
  lock is in the table. Together with `check-locks!` running inside the write's
  transaction, a write either lands before the acquire answers or is refused
  with a 423, so the holder never reads a document that a write it did not see
  is about to change. The cost is that an acquire waits behind a long save.
  Past the busy timeout it answers `:busy`, which the route turns into the same
  retryable 503 a write gets."
  [db document-id user-id lock-id]
  (try
    (psd/with-tx [_tx db]
      (locks/acquire-lock! document-id user-id lock-id))
    (catch Exception e
      (if (psd/sqlite-busy? e)
        (do (log/warn e "Lock acquire waited out busy_timeout:" (ex-message e))
            :busy)
        (throw e)))))

(defn- ->v2-shape
  "Project the SQL op-record into the v2 audit/op key shape that
  plaid.server.events/publish-audit-event! expects.

  `:audit/documents` is the union of the op-attrs' single `:document`
  and the docs the body actually version-bumped (`:documents`, recorded
  by bump-document-version!/bump-document-versions! via the
  `:affected-documents` atom in `psaw/*op*`). Multi-document ops like
  vocab/delete and project/remove-vocab carry `:document nil` but bump
  N docs — without the union their events were doc-blind and
  document-scoped listeners were never notified."
  [op-record]
  (let [pid (:project op-record)
        did (:document op-record)]
    {:audit/id (:id op-record)
     :audit/projects (if pid #{pid} #{})
     :audit/documents (into (if did #{did} #{}) (:documents op-record))
     :op/id (:id op-record)
     :op/type (:type op-record)
     :op/project pid
     :op/document did
     :op/description (:description op-record)}))

(def ^:dynamic *deferred-events*
  "Bound (to an atom holding a vector) by the atomic batch handler.
  Inside an atomic batch, submit-operation*'s success path runs while
  the OUTER tx is still open — `with-tx` runs the body inline on the
  shared Connection — so publishing an audit event immediately would
  announce a write that (a) listeners can't read back yet (they'd see
  the pre-batch snapshot and never be re-notified) and (b) may roll
  back entirely if a later sub-op fails (phantom events). When bound,
  `post-submit!` appends the event payload here instead of publishing;
  the batch handler flushes the buffer AFTER the outer tx commits and
  drops it on rollback. Lock refreshes are NOT deferred — they're
  in-memory TTL bookkeeping that should track wall clock during a long
  batch, and they announce nothing."
  nil)

(defn- publish-op-event!
  [op-record user-id]
  (let [v2-op (->v2-shape op-record)]
    (try
      (events/publish-audit-event! v2-op [v2-op] user-id)
      (catch Exception e
        (log/warn "Failed to publish audit event:" (ex-message e))))))

(defn flush-deferred-events!
  "Publish audit events buffered under *deferred-events* (a seq of
  {:op-record .. :user-id ..}). Called by the atomic batch handler after
  its outer tx commits — never call with the tx still open."
  [events]
  (doseq [{:keys [op-record user-id]} events]
    (publish-op-event! op-record user-id)))

(def ^:dynamic *deferred-files*
  "Bound (to an atom holding a vector) by the atomic batch handler, for the
  work a rollback cannot undo: deleting a document's media file. A sub-op's
  success is not a commit, so a batch that deletes three documents and 404s
  on the third used to bring the other two back without their recordings.
  When bound, `after-commit!` buffers the work here and the batch handler
  runs it once the outer tx commits, or drops it on rollback."
  nil)

(defn after-commit!
  "Run `f` once the write it belongs to is durable: at once outside an atomic
  batch, where each write commits on its own, and after the outer tx commits
  inside one."
  [f]
  (if *deferred-files*
    (swap! *deferred-files* conj f)
    (f)))

(defn run-deferred-files!
  "Run the work buffered under *deferred-files*. Called by the atomic batch
  handler after its outer tx commits — never call with the tx still open."
  [fs]
  (doseq [f fs]
    (try
      (f)
      (catch Throwable t
        (log/warn t "Deferred file work failed:" (ex-message t))))))

(defn- post-submit! [op-record user-id]
  (if *deferred-events*
    (swap! *deferred-events* conj {:op-record op-record :user-id user-id})
    (publish-op-event! op-record user-id))
  (when-let [doc-id (:document op-record)]
    (try
      (locks/refresh-locks! [doc-id] user-id)
      (catch Exception e
        (log/warn "Failed to refresh locks:" (ex-message e))))))

(defn- repair-op?
  "Whether the current operation is in a group of kind `repair`: an app's
  repair on open, which no one made by editing."
  [tx]
  (when-let [g (:group-id psaw/*op*)]
    (= "repair" (:kind (psc/q1 tx {:select [:kind] :from :operation_groups :where [:= :id g]})))))

(defn- modified-at
  "What a write leaves as a document's `modified_at`: the operation's time,
  or the time it had for a repair on open, so that looking at a document
  never makes it the latest edited (H9-FIRST-OPEN-5)."
  [tx pre ts]
  (if (repair-op? tx) (:modified_at pre) ts))

(defn- bump-document-version!
  "Post-body version bump on the operation's :document. Audited under
  the sentinel `change_type` `:doc-version-bump` (vs. a plain `:update`)
  so ETL change-tracking on document bodies can distinguish the per-op
  version bookkeeping from genuine `:document/update` edits — without it,
  every annotation write would look like a doc-content mutation on the
  replica. The audit row still carries the full pre/post images (only
  `:version` + `:modified_at` differ) so replay reproduces the row.

  Uses the row's current version (read inside the tx) to compute the
  next value — a raw SQL `version = version + 1` would also work but
  using fetch-by-id + execute! keeps the audit-image construction simple
  and parallel to update-by-id!.

  No-ops when the row is missing (e.g. for :document/delete, which has
  already removed it inside the body).

  Skipped entirely when op-attrs carries :skip-doc-version-bump? true.
  That's the escape hatch for ops whose body already manages the
  version column directly (:document/create — body INSERTs at v1;
  :document/update — body sets `(inc version)` itself). Without the
  skip, those ops would either start documents at v2 or jump v→v+2."
  [tx doc-id ts]
  (when-let [pre (psc/fetch-by-id tx :documents doc-id)]
    (let [post (assoc pre
                      :version (inc (or (:version pre) 0))
                      :modified_at (modified-at tx pre ts))]
      (psc/execute! tx {:update :documents
                        :set {:version (:version post)
                              :modified_at (:modified_at post)}
                        :where [:= :id doc-id]})
      (psaw/record-audit-write! tx :documents doc-id
                                psaw/doc-version-bump-change-type
                                pre post)
      ;; Record the bump for the op's audit event (see ->v2-shape).
      (when-let [a (:affected-documents psaw/*op*)]
        (swap! a conj doc-id)))))

(defn bump-document-versions!
  "Bulk version-bump for a coll of document ids. Use from inside an
  operation body when the op transitively invalidates client views of
  multiple documents (e.g. vocab/delete wiping vocab_links across many
  documents — the op-attrs carry no single `:document`, so the post-body
  `bump-document-version!` hook never fires for the affected docs).

  Emits one `:doc-version-bump` audit row per doc (same sentinel as the
  single-doc helper) so ETL parity is preserved: replicas see the same
  per-doc version transitions they'd see from a regular per-doc op.

  No-ops on duplicate or unknown ids (mirrors `bump-document-version!`'s
  missing-row tolerance). Distinct'ed up-front so a caller can pass the
  raw list of `vocab_link.document_id` values without pre-deduping."
  [tx doc-ids]
  ;; Use the op's monotonic ts (not a fresh now-iso) so `modified_at`
  ;; agrees with the op's `operations.ts` / audit-row ts. A fresh now-iso
  ;; can be marginally LESS than the op's strictly-monotonic ts, leaving
  ;; modified_at slightly behind the op time. (Falls back to now-iso if
  ;; ever called outside an op context.)
  (let [ts (or (:ts psaw/*op*) (psc/now-iso))]
    ;; `(distinct some-set)` throws in Clojure 1.12 (`nth` not supported on
    ;; PersistentHashSet) due to a `distinct` fast-path bug — coerce to a
    ;; seq via `seq` so we work for any input shape (set, vector, lazy).
    (doseq [doc-id (distinct (seq doc-ids))
            :let [pre (psc/fetch-by-id tx :documents doc-id)]
            :when pre]
      (let [post (assoc pre
                        :version (inc (or (:version pre) 0))
                        :modified_at (modified-at tx pre ts))]
        (psc/execute! tx {:update :documents
                          :set {:version (:version post)
                                :modified_at (:modified_at post)}
                          :where [:= :id doc-id]})
        (psaw/record-audit-write! tx :documents doc-id
                                  psaw/doc-version-bump-change-type
                                  pre post)
        ;; Record the bump for the op's audit event (see ->v2-shape) —
        ;; this is exactly the multi-document signal: ops like
        ;; vocab/delete carry :document nil but bump N docs here.
        (when-let [a (:affected-documents psaw/*op*)]
          (swap! a conj doc-id))))))

(defn op-ts
  "The current operation's monotonic timestamp, for bodies that stamp a
  time column themselves (vocab-layer creation, the folded `:modified_at`
  on a vocab rename). Falls back to wall clock outside an op context."
  []
  (or (:ts psaw/*op*) (psc/now-iso)))

(defn touch-vocab-layers!
  "Stamp `vocab_layers.modified_at` with the op's ts for each id in
  `vocab-ids`.

  The vocabulary-level counterpart of `bump-document-version!`: an item
  write never touches its parent layer row, so without this a vocabulary
  would look untouched no matter how many entries were added, edited, or
  deleted, and a list view could not show when it last changed. Call from
  ops that do NOT otherwise write the layer row; ops that do (rename,
  config) fold `:modified_at` into their own update instead, so the change
  rides one audit row rather than two.

  An ordinary `:update` audit row, not a sentinel change_type like
  `:doc-version-bump`: this is a real column write with no ETL consumer
  that needs to tell it apart, and `fold-rows` merges post-images key-wise
  so the `:maintainers` fold carried by the synthetic vocab_layers rows
  survives it. No-ops on a missing row (a layer dropped earlier in the
  same op) and on an unchanged value, via `update-by-id!`.

  Deliberately NOT called for vocab_links: a link is an annotation on a
  document, not a change to the vocabulary it points at."
  [tx vocab-ids]
  (let [ts (op-ts)]
    ;; `seq` first: `(distinct some-set)` throws in Clojure 1.12 (see
    ;; bump-document-versions!), and callers pass whatever shape they have.
    (doseq [vid (distinct (seq vocab-ids))
            :when vid]
      (crud/update-by-id! tx :vocab_layers vid {:modified_at ts}))))

(defn touch-vocab-layer!
  "Single-id `touch-vocab-layers!`."
  [tx vocab-id]
  (touch-vocab-layers! tx [vocab-id]))

(defn- wrote-nothing?
  "Whether operation `op-id` (stamped `ts`) wrote no row, and no operation
  was nested inside it. Nested operations run in the same transaction after
  it, so they are the ones stamped later."
  [tx op-id ts]
  (and (nil? (psc/q1 tx {:select [1] :from :audit_writes :where [:= :op_id op-id] :limit 1}))
       (nil? (psc/q1 tx {:select [1] :from :operations :where [:> :ts ts] :limit 1}))))

(defn- unrecord-operation!
  "Take the row of an operation that wrote nothing back out, and its group's
  row when no other operation is in that group, so the log shows no entry
  for it."
  [tx {:keys [id group-id]}]
  (psc/execute! tx {:delete-from :operations :where [:= :id id]})
  (when group-id
    (psc/execute! tx {:delete-from :operation_groups
                      :where [:and [:= :id group-id]
                              [:not [:exists {:select [1] :from :operations
                                              :where [:= :group_id group-id]}]]]})))

(defn submit-operation*
  "Functional core. body-fn is (fn [tx] ...). Returns a result map.

  Inserts the `operations` row BEFORE the body runs so that audit_writes
  rows generated by per-row write helpers can reference op_id without
  tripping the FK constraint.

  When op-attrs carries a :document, the document's `version` is bumped
  AFTER the body runs (via the audited update-by-id! path). Callers
  whose body already manages the version column must pass
  `:skip-doc-version-bump? true` to avoid a double-increment or a
  duplicate audit row (see `bump-document-version!`).

  Outer try/catch shape (task #47): a single try wraps the entire
  function body: the `with-tx` (whose first step is `check-locks!`), the
  body invocation and post-body bookkeeping. Any
  `ExceptionInfo` thrown WITHIN those bounds — by `check-locks!`, by
  the body-fn itself, or by `bump-document-version!` — is projected
  to `{:success false :code <ex-data :code or 500> :error <msg>}`.
  Validations OUTSIDE the body-fn (in CALLER code that runs BEFORE
  `submit-operation!` is invoked — typical pattern: a `:project` /
  `:document` lookup used to build the op-attrs map) are NOT caught
  here: those exceptions propagate up to whatever caller wraps the
  call to `submit-operation*`. Move pre-flight validations INTO the
  body-fn to ensure they get projected to a structured 4xx response.
  The catch sits OUTSIDE `with-tx` so the body's tx still rolls back
  cleanly (see batch-interaction note below).

  `:unrecorded-if-empty? true` in op-attrs takes the operation's row back
  out (and announces nothing) when the body wrote nothing, for an operation
  that only sometimes has work to do, such as a repair of clean data.

  Logging policy: 5xx is treated as a real server bug and logged at
  `error`; 4xx is a normal client-side validation failure and gets
  `debug` only (avoids spamming the log on every bad request)."
  [db op-attrs body-fn]
  (try
    (let [op-id (psc/new-uuid)
          ;; The outermost operation of a transaction collects the rows it
          ;; writes and checks the layer constraints on them at its end
          ;; (`plaid.sql.constraints.layer/finish!`). Inside a batch, or inside
          ;; another operation, the collector is already bound and whoever
          ;; bound it checks.
          outermost? (nil? psaw/*pending*)
          pending (or psaw/*pending* (atom {}))
          ;; Audit events of the operations that apply layer rules, published
          ;; with this one's after the commit.
          constraint-events (atom [])
          ;; `op-record` is built INSIDE the write tx because `ts` must be
          ;; stamped under the BEGIN IMMEDIATE lock (see
          ;; psc/next-monotonic-ts!). Capture it out via this volatile so
          ;; the post-commit nudge/post-submit! and the return value can
          ;; still see it.
          op-record* (volatile! nil)
          ;; Documents whose version the body bumps (via
          ;; bump-document-version!/bump-document-versions!, which read
          ;; this atom off psaw/*op*). Unioned into the audit event's
          ;; :audit/documents post-commit — see ->v2-shape.
          affected-docs (atom #{})
          ;; Set when an op that asked for it (`:unrecorded-if-empty?`)
          ;; wrote nothing and its row was taken back out.
          unrecorded? (volatile! false)
          extra (psd/with-tx [tx db]
                  ;; ts stamped here — while holding the RESERVED write
                  ;; lock — so it is strictly monotonic with COMMIT order.
                  ;; Stamping it before with-tx (as we used to) let a
                  ;; lower-ts op commit AFTER a higher-ts op under
                  ;; concurrent writers; the history tailer's
                  ;; `(ts,id) > cursor` keyset then skipped the lower-ts
                  ;; op forever (silent replica data loss).
                  (when-not (:skip-lock-check? op-attrs)
                    (check-locks! op-attrs))
                  (let [ts (psc/next-monotonic-ts! tx)
                        op-record (assoc op-attrs
                                         :id op-id
                                         :ts ts
                                         :batch-id (or (:batch-id op-attrs) *current-batch-id*)
                                         ;; Logical-operation grouping (see *current-group-id*).
                                         :group-id (or (:group-id op-attrs) *current-group-id*)
                                         ;; Server-authoritative: bound from the
                                         ;; validated JWT claim by wrap-api-token-id.
                                         :token-id (or (:token-id op-attrs) *token-id*)
                                         ;; Client-supplied (templated) audit message
                                         ;; overrides the auto-generated description.
                                         ;; See *custom-description* / wrap-audit-message.
                                         :description (or *custom-description* (:description op-attrs)))]
                    (vreset! op-record* op-record)
                    ;; A project being deleted takes no more writes. The route
                    ;; gate refuses it too, but checks before this transaction,
                    ;; so a write that passed it while the project was live
                    ;; could otherwise land after the delete's short step
                    ;; committed (see `plaid.sql.project/delete`).
                    (when-let [pid (:project op-attrs)]
                      (when (and (not= :project/delete (:type op-attrs))
                                 (psc/q1 tx {:select [:id]
                                             :from [:projects]
                                             :where [:and [:= :id pid] [:<> :deleted_at nil]]}))
                        (throw (ex-info (psc/err-msg-not-found "Project" pid) {:code 404 :id pid}))))
                    (ensure-group-row! tx op-record)
                    (insert-operation-row! tx op-record)
                    ;; In-tx OCC check (task #108). Before the body runs,
                    ;; verify the client's expected `?document-version=`
                    ;; (carried via psaw/*expected-document-version*) still
                    ;; matches the row inside our write tx. SQLite serializes
                    ;; concurrent writers via BEGIN IMMEDIATE, so this read
                    ;; sees a snapshot consistent with what we're about to
                    ;; write — closing the TOCTOU window between the
                    ;; middleware's read and the handler's write.
                    ;;
                    ;; Skip when:
                    ;;   - no expected version was supplied (typical
                    ;;     unversioned write), or
                    ;;   - the op has no :document (project-level ops), or
                    ;;   - the row doesn't yet exist (covers :document/create
                    ;;     where the body INSERTs the row at v=1 itself).
                    ;; The check DOES fire for :document/delete: at this
                    ;; point the row is still present, so a stale version
                    ;; correctly produces a 409 and rolls the tx back.
                    (when-let [expected psaw/*expected-document-version*]
                      (when-let [doc-id (:document op-attrs)]
                        (when-let [cur (psc/fetch-by-id tx :documents doc-id)]
                          (when (not= expected (:version cur))
                            (throw (ex-info "Document version conflict"
                                            {:code 409
                                             :document-id doc-id
                                             :expected-version expected
                                             :actual-version (:version cur)}))))))
                    ;; :seq-counter is an atom holding the next audit-write
                    ;; ordinal for this op. record-audit-write! pulls it and
                    ;; bumps the counter so every row gets a unique
                    ;; (op_id, seq) tuple. The op is single-threaded inside
                    ;; submit-operation*, so the atom is just an in-memory
                    ;; counter — no real contention.
                    (binding [psaw/*op* {:id op-id :ts ts :tx tx
                                         :seq-counter (atom 0)
                                         :affected-documents affected-docs
                                         :type (:type op-attrs)
                                         :user (:user op-attrs)
                                         :group-id (:group-id op-record)}
                              psaw/*pending* pending]
                      (let [result (body-fn tx)]
                        ;; Layer constraints, checked on what the transaction
                        ;; wrote before its document versions move. A refusal
                        ;; throws and rolls everything back. A rule applied
                        ;; to another document bumps that one, which the
                        ;; answer's versions must name.
                        (when outermost?
                          (let [finish! (requiring-resolve 'plaid.sql.constraints.layer/finish!)]
                            (swap! affected-docs into
                                   (if *deferred-events*
                                     (finish! tx)
                                     (binding [*deferred-events* constraint-events]
                                       (finish! tx))))))
                        ;; Bump documents.version so the optimistic-concurrency
                        ;; middleware (wrap-document-version) detects stale clients.
                        (when (and (:document op-attrs)
                                   (not (:skip-doc-version-bump? op-attrs)))
                          (bump-document-version! tx (:document op-attrs) ts))
                        (when (and (:unrecorded-if-empty? op-attrs)
                                   (wrote-nothing? tx op-id ts))
                          (unrecord-operation! tx op-record)
                          (vreset! unrecorded? true))
                        result))))
          op-record (assoc @op-record* :documents @affected-docs)]
      (try
        (flush-deferred-events! @constraint-events)
        (catch Throwable t
          (log/warn t "Publishing the layer rule events failed after the commit:" (ex-message t))))
      ;; The try/catch around post-submit! is defensive: the OLTP commit
      ;; is already durable, so nothing post-commit may invert success
      ;; into a 5xx response. An operation left unrecorded announces nothing.
      (when-not @unrecorded?
        (try
          (post-submit! op-record (:user op-attrs))
          (catch Throwable t
            (log/warn t "post-submit! failed after successful commit:" (ex-message t)))))
      ;; `:documents` is every document this op bumped the version of, the same
      ;; set the audit event carries. A handler passes it to
      ;; `assoc-document-versions-in-header` so a strict-mode client learns the
      ;; new versions from the write that caused them. Without it a write that
      ;; restates OTHER documents (renaming a vocabulary entry restates every
      ;; document that links it) leaves the client holding versions the server
      ;; has already moved past, and its next write to one of them 409s with
      ;; nobody to blame. Every op gets it, so a new multi-document op only has
      ;; to pass it along.
      {:success true :extra extra :documents (vec (:documents op-record))})
    ;; NOTE on batch-tx interaction (verified by
    ;; `plaid.rest-api.v1.batch-test/test-batch-rollback-when-body-throws-ex-info`):
    ;; when we're running inside an outer batch tx (db is a Connection),
    ;; `with-tx` runs the body inline rather than opening an inner tx, so
    ;; the throw out of body-fn propagates up through with-tx without
    ;; committing anything — by the time control reaches this catch, the
    ;; body's writes are still uncommitted in the outer tx. The REST
    ;; layer then converts our `{:success false :code ...}` to a non-200
    ;; response, and the batch loop sees status >= 300 and throws, which
    ;; rolls back the entire outer tx.
    (catch ExceptionInfo e
      (let [code (or (-> e ex-data :code) 500)]
        (if (>= code 500)
          (log/error e "submit-operation* failed:" (ex-message e))
          (log/debug e "submit-operation* rejected:" (ex-message e)))
        ;; Task #114: 5xx ExceptionInfo paths cover both intentional
        ;; server-error throws (e.g. validators with `:code 500`) and
        ;; "I forgot to set :code" leaks (the fallback `or … 500`). In
        ;; both cases the message often carries developer-facing detail
        ;; (constraint names, internal table references, etc.) we don't
        ;; want to surface to the client. The raw message is still
        ;; preserved server-side via the `log/error` above. 4xx flows
        ;; (validators throwing structured app errors) keep the message
        ;; — they're caller-actionable by design.
        (cond-> {:success false
                 :error (if (>= code 500) "Internal error" (ex-message e))
                 :code code}
          ;; Fields a refusal adds to the answer's body beside its message
          ;; (`id-taken` on a create naming a used id). See
          ;; `plaid.rest-api.v1.middleware/error-body`.
          (and (< code 500) (:plaid/body (ex-data e)))
          (assoc :error-body (:plaid/body (ex-data e))))))
    ;; SQLite busy / locked → 503 so clients see a retry-friendly signal
    ;; (instead of a generic 500 that looks like a server bug). Fires
    ;; only after busy_timeout has elapsed (~5s of contention) — at
    ;; that point the write genuinely couldn't acquire the lock. We
    ;; check both the result code (SQLITE_BUSY = 5, SQLITE_LOCKED = 6)
    ;; and the message string so the branch still catches the case
    ;; where the driver wrapped the exception (subclass might shadow
    ;; getResultCode).
    (catch SQLException e
      ;; Walk the cause/suppressed chain (not just the top exception) so a
      ;; busy masked by a "cannot rollback - no transaction is active"
      ;; rollback failure is still surfaced as a retryable 503 instead of
      ;; an opaque 500. See `psd/sqlite-busy?`.
      (if (psd/sqlite-busy? e)
        (do
          (log/warn e "Database busy/locked after busy_timeout:" (ex-message e))
          {:success false :error "Database busy, please retry" :code 503})
        (do
          (log/error e "Operation failed (SQL):" (ex-message e))
          ;; Task #95: do NOT leak raw SQLException text to the
          ;; response. The driver message often carries column
          ;; names, generated SQL fragments, and constraint
          ;; identifiers — useful for the operator (logged above)
          ;; but a needless schema-disclosure surface for clients.
          {:success false :error "Internal error" :code 500})))
    (catch Exception e
      ;; A non-SQLException can still WRAP a busy (e.g. a rollback-failure
      ;; wrapper) — check the chain before falling back to 500.
      (if (psd/sqlite-busy? e)
        (do
          (log/warn e "Database busy/locked after busy_timeout:" (ex-message e))
          {:success false :error "Database busy, please retry" :code 503})
        (do
          (log/error e "Operation failed")
          ;; Same rationale as the SQLException branch — generic message
          ;; in the response, full stack trace in the log.
          {:success false :error "Internal error" :code 500})))))

(defmacro submit-operation!
  "Run body inside a SQL transaction, recording one logical operation and
  per-row audit_writes for any inserts/updates/deletes performed inside.

  Usage:
    (submit-operation! [tx db {:type :token/create
                               :description \"Create token\"
                               :project project-id
                               :document doc-id
                               :user user-id}]
      (crud/insert! tx :tokens row))

  Returns {:success true :extra <body-result>} on success, otherwise
  {:success false :error :code}.  Rolls back the tx on exception."
  [[tx-sym db op-attrs] & body]
  `(submit-operation* ~db ~op-attrs (fn [~tx-sym] ~@body)))
