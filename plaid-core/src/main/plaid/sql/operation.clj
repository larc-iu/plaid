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
            [plaid.sql.common :as psc]
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

(def ^:dynamic *current-batch-id*
  "Set by the REST batch handler when several sub-operations should be
  grouped under one logical batch. Just goes onto each operation row;
  no application-level coordination implied."
  nil)

(defn- insert-operation-row!
  [tx {:keys [id type project document description user token-id batch-id ts]}]
  (psc/execute!
   tx
   {:insert-into :operations
    :values [{:id id
              :op_type (if (keyword? type) (subs (str type) 1) (str type))
              :project_id project
              :document_id document
              :description description
              :batch_id batch-id
              :user_id user
              :token_id token-id
              :ts ts}]}))

(defn- check-locks! [op-attrs]
  (when-let [doc-id (:document op-attrs)]
    (let [result (locks/check-document-locks [doc-id] (:user op-attrs))]
      (when (not= :ok result)
        (throw (ex-info (str "Document " (:document-id result) " is locked by " (:user-id result))
                        {:code 423
                         :document-id (:document-id result)
                         :locked-by (:user-id result)}))))))

(defn- ->v2-shape
  "Project the SQL op-record into the v2 audit/op key shape that
  plaid.server.events/publish-audit-event! expects.

  `:audit/documents` is the union of the op-attrs' single `:document`
  and the docs the body actually version-bumped (`:documents`, recorded
  by bump-document-version!/bump-document-versions! via the
  `:affected-documents` atom in `psc/*op*`). Multi-document ops like
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

(defn- post-submit! [op-record user-id]
  (if *deferred-events*
    (swap! *deferred-events* conj {:op-record op-record :user-id user-id})
    (publish-op-event! op-record user-id))
  (when-let [doc-id (:document op-record)]
    (try
      (locks/refresh-locks! [doc-id] user-id)
      (catch Exception e
        (log/warn "Failed to refresh locks:" (ex-message e))))))

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
                      :modified_at ts)]
      (psc/execute! tx {:update :documents
                        :set {:version (:version post)
                              :modified_at (:modified_at post)}
                        :where [:= :id doc-id]})
      (psc/record-audit-write! tx :documents doc-id
                               psc/doc-version-bump-change-type
                               pre post)
      ;; Record the bump for the op's audit event (see ->v2-shape).
      (when-let [a (:affected-documents psc/*op*)]
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
  (let [ts (or (:ts psc/*op*) (psc/now-iso))]
    ;; `(distinct some-set)` throws in Clojure 1.12 (`nth` not supported on
    ;; PersistentHashSet) due to a `distinct` fast-path bug — coerce to a
    ;; seq via `seq` so we work for any input shape (set, vector, lazy).
    (doseq [doc-id (distinct (seq doc-ids))
            :let [pre (psc/fetch-by-id tx :documents doc-id)]
            :when pre]
      (let [post (assoc pre
                        :version (inc (or (:version pre) 0))
                        :modified_at ts)]
        (psc/execute! tx {:update :documents
                          :set {:version (:version post)
                                :modified_at (:modified_at post)}
                          :where [:= :id doc-id]})
        (psc/record-audit-write! tx :documents doc-id
                                 psc/doc-version-bump-change-type
                                 pre post)
        ;; Record the bump for the op's audit event (see ->v2-shape) —
        ;; this is exactly the multi-document signal: ops like
        ;; vocab/delete carry :document nil but bump N docs here.
        (when-let [a (:affected-documents psc/*op*)]
          (swap! a conj doc-id))))))

(defn- sqlite-busy-in-chain?
  "True when `e` or anything in its cause/suppressed chain is a SQLite
   busy/locked error. The common case is a top-level SQLITE_BUSY, but
   under BEGIN-time contention next.jdbc can surface a 'cannot rollback -
   no transaction is active' failure on top with the real busy attached
   as a cause or suppressed exception — so we walk the whole chain,
   checking the SQLite result code (BUSY=5, LOCKED=6) and message text on
   each link."
  [^Throwable e]
  (loop [stack [e]]
    (if (empty? stack)
      false
      (let [^Throwable t (peek stack)
            stack' (pop stack)]
        (cond
          (nil? t) (recur stack')
          (let [rc (when (instance? org.sqlite.SQLiteException t)
                     (try (.code (.getResultCode ^org.sqlite.SQLiteException t))
                          (catch Throwable _ nil)))
                msg (or (.getMessage t) "")]
            (or (= 5 rc) (= 6 rc)
                (clojure.string/includes? msg "SQLITE_BUSY")
                (clojure.string/includes? msg "SQLITE_LOCKED")
                (clojure.string/includes? msg "database is locked")))
          true
          :else (recur (into stack' (remove nil? (cons (.getCause t) (seq (.getSuppressed t)))))))))))

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
  function body, starting with `check-locks!` and continuing through
  the `with-tx`/body invocation and post-body bookkeeping. Any
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

  Logging policy: 5xx is treated as a real server bug and logged at
  `error`; 4xx is a normal client-side validation failure and gets
  `debug` only (avoids spamming the log on every bad request)."
  [db op-attrs body-fn]
  (try
    (check-locks! op-attrs)
    (let [op-id (psc/new-uuid)
          ;; `op-record` is built INSIDE the write tx because `ts` must be
          ;; stamped under the BEGIN IMMEDIATE lock (see
          ;; psc/next-monotonic-ts!). Capture it out via this volatile so
          ;; the post-commit nudge/post-submit! and the return value can
          ;; still see it.
          op-record* (volatile! nil)
          ;; Documents whose version the body bumps (via
          ;; bump-document-version!/bump-document-versions!, which read
          ;; this atom off psc/*op*). Unioned into the audit event's
          ;; :audit/documents post-commit — see ->v2-shape.
          affected-docs (atom #{})
          extra (psc/with-tx [tx db]
                  ;; ts stamped here — while holding the RESERVED write
                  ;; lock — so it is strictly monotonic with COMMIT order.
                  ;; Stamping it before with-tx (as we used to) let a
                  ;; lower-ts op commit AFTER a higher-ts op under
                  ;; concurrent writers; the history tailer's
                  ;; `(ts,id) > cursor` keyset then skipped the lower-ts
                  ;; op forever (silent replica data loss).
                  (let [ts (psc/next-monotonic-ts! tx)
                        op-record (assoc op-attrs
                                         :id op-id
                                         :ts ts
                                         :batch-id (or (:batch-id op-attrs) *current-batch-id*)
                                         ;; Server-authoritative: bound from the
                                         ;; validated JWT claim by wrap-api-token-id.
                                         :token-id (or (:token-id op-attrs) *token-id*))]
                    (vreset! op-record* op-record)
                    (insert-operation-row! tx op-record)
                    ;; In-tx OCC check (task #108). Before the body runs,
                    ;; verify the client's expected `?document-version=`
                    ;; (carried via psc/*expected-document-version*) still
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
                    (when-let [expected psc/*expected-document-version*]
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
                    (binding [psc/*op* {:id op-id :ts ts :tx tx
                                        :seq-counter (atom 0)
                                        :affected-documents affected-docs}]
                      (let [result (body-fn tx)]
                        ;; Bump documents.version so the optimistic-concurrency
                        ;; middleware (wrap-document-version) detects stale clients.
                        (when (and (:document op-attrs)
                                   (not (:skip-doc-version-bump? op-attrs)))
                          (bump-document-version! tx (:document op-attrs) ts))
                        result))))
          op-record (assoc @op-record* :documents @affected-docs)]
      ;; The try/catch around post-submit! is defensive: the OLTP commit
      ;; is already durable, so nothing post-commit may invert success
      ;; into a 5xx response.
      (try
        (post-submit! op-record (:user op-attrs))
        (catch Throwable t
          (log/warn t "post-submit! failed after successful commit:" (ex-message t))))
      {:success true :extra extra})
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
        {:success false
         :error (if (>= code 500) "Internal error" (ex-message e))
         :code code}))
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
      ;; an opaque 500. See `sqlite-busy-in-chain?`.
      (if (sqlite-busy-in-chain? e)
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
      (if (sqlite-busy-in-chain? e)
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
      (psc/insert! tx :tokens row))

  Returns {:success true :extra <body-result>} on success, otherwise
  {:success false :error :code}.  Rolls back the tx on exception."
  [[tx-sym db op-attrs] & body]
  `(submit-operation* ~db ~op-attrs (fn [~tx-sym] ~@body)))
