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
  (:require [clojure.string :as str]
            [plaid.olap.core :as olap]
            [plaid.sql.common :as psc]
            [plaid.server.events :as events]
            [plaid.server.locks :as locks]
            [taoensso.timbre :as log])
  (:import [clojure.lang ExceptionInfo]
           [java.sql SQLException]))

(def ^:const max-user-agent-length
  "Hard cap on stored User-Agent strings. Real-world UA headers top out
  around 200-300 chars; 500 gives plenty of margin without letting a
  client wedge megabytes through into log files / the operations row."
  500)

(defn sanitize-user-agent
  "Strip ALL ASCII control characters (0x00-0x1F + 0x7F DEL) from `ua` so
  it can't smuggle log-injection sequences through `operations.user_agent`
  into log lines, and truncate to `max-user-agent-length`. Returns nil
  for nil input.

  Task #119 extension of task #95: the original implementation stripped
  only CR/LF, but other control bytes — backspace (0x08), ESC (0x1B,
  the start of ANSI escape sequences), NUL (0x00), DEL (0x7F) — are
  equally capable of corrupting terminal log output. ESC in particular
  lets a client paint arbitrary terminal escapes onto an operator's
  `tail -f`. The regex `[\\x00-\\x1F\\x7F]` covers C0 controls + DEL
  without touching valid printable ASCII or any multibyte UTF-8 sequence
  (UTF-8 continuation bytes start at 0x80 and so are outside the range)."
  [ua]
  (when (some? ua)
    (let [s (str/replace (str ua) #"[\x00-\x1F\x7F]" "")]
      (if (> (count s) max-user-agent-length)
        (subs s 0 max-user-agent-length)
        s))))

(def ^:dynamic *user-agent*
  "User-Agent string for the current HTTP request. Bound by the middleware
  and persisted onto the operations row. Sanitized on the write path
  (CR/LF stripped, truncated) — see `sanitize-user-agent`."
  nil)

(def ^:dynamic *current-batch-id*
  "Set by the REST batch handler when several sub-operations should be
  grouped under one logical batch. Just goes onto each operation row;
  no application-level coordination implied."
  nil)

(defn- insert-operation-row!
  [tx {:keys [id type project document description user user-agent batch-id ts]}]
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
              :user_agent user-agent
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
  plaid.server.events/publish-audit-event! expects."
  [op-record]
  (let [pid (:project op-record)
        did (:document op-record)]
    {:audit/id (:id op-record)
     :audit/projects (if pid #{pid} #{})
     :audit/documents (if did #{did} #{})
     :op/id (:id op-record)
     :op/type (:type op-record)
     :op/project pid
     :op/document did
     :op/description (:description op-record)}))

(defn- post-submit! [op-record user-id]
  (let [v2-op (->v2-shape op-record)]
    (try
      (events/publish-audit-event! v2-op [v2-op] user-id)
      (catch Exception e
        (log/warn "Failed to publish audit event:" (ex-message e)))))
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
                               pre post))))

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
                                 pre post)))))

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
          extra (psc/with-tx [tx db]
                  ;; ts stamped here — while holding the RESERVED write
                  ;; lock — so it is strictly monotonic with COMMIT order.
                  ;; Stamping it before with-tx (as we used to) let a
                  ;; lower-ts op commit AFTER a higher-ts op under
                  ;; concurrent writers; the OLAP tailer's
                  ;; `(ts,id) > cursor` keyset then skipped the lower-ts
                  ;; op forever (silent replica data loss).
                  (let [ts (psc/next-monotonic-ts! tx)
                        op-record (assoc op-attrs
                                         :id op-id
                                         :ts ts
                                         :batch-id (or (:batch-id op-attrs) *current-batch-id*)
                                         ;; Task #95: sanitize at the write boundary so
                                         ;; both the in-tx insert AND any downstream log
                                         ;; line that re-reads `:user-agent` see the
                                         ;; already-scrubbed value.
                                         :user-agent (sanitize-user-agent
                                                      (or (:user-agent op-attrs) *user-agent*)))]
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
                                        :seq-counter (atom 0)}]
                      (let [result (body-fn tx)]
                        ;; Bump documents.version so the optimistic-concurrency
                        ;; middleware (wrap-document-version) detects stale clients.
                        (when (and (:document op-attrs)
                                   (not (:skip-doc-version-bump? op-attrs)))
                          (bump-document-version! tx (:document op-attrs) ts))
                        result))))
          op-record @op-record*]
      ;; Nudge the OLAP tailer ASAP after the OLTP tx commits. Goes
      ;; BEFORE post-submit! so a slow event-bus publish or lock
      ;; refresh can't delay the OLAP catching up. nudge! is a
      ;; non-blocking put! on a dropping-buffer-1 channel — no
      ;; back-pressure risk if the tailer is busy.
      ;;
      ;; The try/catch around nudge! and post-submit! is defensive: the
      ;; OLTP commit is already durable, so nothing post-commit should
      ;; be allowed to invert success into a 5xx. Today nudge! is
      ;; effectively unfailable, but a future config read inside
      ;; `enabled?` or a publish/lock-refresh inside post-submit! must
      ;; not turn a committed write into a 500 response.
      (try
        (olap/nudge!)
        (catch Throwable t
          (log/warn t "OLAP nudge failed after successful commit:" (ex-message t))))
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
