(ns plaid.sql.audit-write
  "The audit-capture machinery: the operation context a write runs under, and
  the `audit_writes` rows it emits.

  `plaid.sql.operation/submit-operation!` binds `*op*` around a write body; the
  row helpers in `plaid.sql.crud` read it and record one audit row per row they
  touch. `record-audit-write!` / `record-audit-writes!` are the raw entry points
  for a change whose meaning does not live in a single row write (see the
  synthetic-parent-row pattern below).

  Split out of `plaid.sql.common` so the audit contract is one file, separate
  from the row helpers that obey it."
  (:require [next.jdbc :as jdbc]
            [plaid.sql.common :as psc]))

;; ============================================================
;; Audit-capture dynamic var
;;
;; submit-operation! binds *op* to a map holding the current operation id
;; (and other context). Per-row write helpers (insert!, update!, delete!)
;; check it and emit audit_writes rows automatically. When *op* is unbound
;; the helpers FAIL FAST (see ensure-op-bound!) — every production write
;; goes through submit-operation!, including bootstrap admin creation.
;; ============================================================

(def ^:dynamic *op*
  "Current operation context inside submit-operation!. nil when no op is active.
  Keys: :id, :ts, :tx (the JDBC Connection that's part of the tx),
  :seq-counter (atom holding the next audit-write ordinal within this op),
  :affected-documents (atom; docs whose version the body bumps — see
  plaid.sql.operation).

  The ::skip sentinel deliberately bypasses auditing. NOTHING uses it
  today — every write, including bootstrap admin creation, goes through
  submit-operation! and is audited. It exists only as a deliberate,
  greppable escape hatch for a future write that genuinely must not be
  audited; think hard before becoming its first caller (the audit log
  is the history replica's replay source)."
  nil)

(def ^:dynamic *expected-document-version*
  "Optimistic-concurrency expected document version, parsed from the
  HTTP `?document-version=<int>` query parameter by
  `plaid.rest-api.v1.middleware/wrap-document-version`.

  Bound around the handler invocation so that the in-tx OCC check
  inside `plaid.sql.operation/submit-operation*` runs atomically with
  the write — closing the TOCTOU window that existed when the
  middleware did the version comparison before the handler opened
  its write tx (task #108).

  nil when no expected version was supplied (or when running outside
  the REST middleware stack, e.g. from tests calling SQL helpers
  directly)."
  nil)

(def ^:dynamic *batch-validated-document-versions*
  "Per-atomic-batch map of document id to the client version already
  validated for that document. Batch sub-requests run sequentially in one
  transaction, so subsequent writes for the same document intentionally
  skip repeating the original OCC check after earlier sub-requests have
  advanced its version. nil outside the batch endpoint."
  nil)

(defn ensure-op-bound!
  "Fail-fast guard for the audited write helpers. Throws ex-info with
  :code 500 BEFORE any SQL executes if *op* is nil — without this,
  calling a write helper outside submit-operation! with a DataSource
  would commit the write in autoCommit mode before the audit attempt
  even fires (and then `record-audit-write!` would throw, but the row
  is already on disk).

  Permitted *op* values:
    - a map (the normal op context, with :id, :ts, :seq-counter, …), or
    - the ::skip sentinel (an unused-but-deliberate audit bypass — see
      the *op* docstring).
  Any other value (nil, a stray scalar) trips the guard.

  Public so every writer in `plaid.sql.crud` opens with the same check."
  []
  (when (or (nil? *op*)
            (and (not (map? *op*))
                 (not= ::skip *op*)))
    (throw (ex-info "write helper called outside submit-operation!"
                    {:code 500
                     :message "write helper called outside submit-operation!"}))))

(def audit-change-types
  "The full set of `change_type` values that may appear in audit_writes.
  Kept in sync with the CHECK constraint in the initial-schema migration.

  - :insert / :update / :delete — row-level writes captured by the
    audit helpers (insert!, update-by-id!, delete-by-id!, merge*).
  - :doc-version-bump — sentinel for the post-body `documents.version`
    increment emitted by `plaid.sql.operation/bump-document-version!`.
    Distinguished from a normal :update so ETL change-tracking on
    document bodies can ignore the per-op version bump without missing
    user-initiated `:document/update` rows. Still applied during replay
    (carries pre/post images with the version + modified_at transition)."
  #{:insert :update :delete :doc-version-bump})

(def doc-version-bump-change-type
  "Sentinel `change_type` for the per-op documents.version bump. See
  `audit-change-types`."
  :doc-version-bump)

;; ----------------------------------------------------------------
;; Post-image-only audit log + the synthetic-parent-row pattern
;; (tasks #28 / #34 / #58)
;;
;; POST-IMAGE ONLY: an audit row stores the full post-image of the
;; touched row and NOT a pre-image. The prior post-image of the same
;; entity IS its pre-image, so storing both was pure redundancy — it
;; only existed for the (since-removed) XTDB ETL replica. `pre_image`
;; is therefore left NULL on every row written after this change
;; (the column is retained for back-compat / forensic spelunking of
;; old rows; new rows don't populate it). The as-of reader uses only
;; post-images (`plaid.history.read`). A `:delete` row consequently
;; carries NO image at all (post is nil): the as-of fold treats a
;; delete as "entity absent at T", which needs no image. Callers
;; still compute the pre-image transiently — for no-op detection
;; (skip the audit when pre == post) and to stamp `document_id` on
;; delete rows.
;;
;; SYNTHETIC-PARENT-ROW: several mutations don't live as a single row
;; write on the parent table but conceptually belong to one parent
;; entity — e.g. the `span_tokens` junction (a span's ordered token
;; list) or `entity_metadata` (wide-narrow KV rows keyed on
;; entity_type+entity_id). To reconstruct the parent after a junction
;; mutation we emit ONE synthetic audit_writes row against the parent
;; table whose POST-image carries the parent row PLUS the junction
;; state folded under a well-known key (`:tokens`, `:metadata`,
;; `:readers`, `:maintainers`, ...). A `:delete` of the parent needs
;; no fold — the deletion implies the junction state is gone.
;; ----------------------------------------------------------------

;; The batched INSERT specifies 9 columns per row (every audit column
;; except the never-written `pre_image`), so each row contributes 9
;; placeholders. Chunk at 3000 rows (27000 params) to stay under SQLite's
;; SQLITE_MAX_VARIABLE_NUMBER (32766). (`plaid.sql.common/bulk-chunk-size`,
;; the general 4000, is sized for ~7-column rows.)
(def ^:private audit-bulk-chunk-size 3000)

(defn- reserve-seqs!
  "Reserve `n` consecutive per-op `:seq` ordinals from the op's counter
  atom and return the first reserved ordinal. The op is single-threaded
  inside submit-operation*, so the atom is just an in-memory counter — no
  real contention.

  Fallback for any old op shape that lacks `:seq-counter` (shouldn't happen
  in normal flow): start at 0. Callers still receive a distinct ordinal per
  row in a batch, so the UNIQUE(op_id, seq) constraint in audit_writes holds
  even on that path."
  [op n]
  (if-let [c (:seq-counter op)]
    (let [start @c] (swap! c + n) start)
    0))

(defn- audit-row-values
  "Build the column-keyed value map for one audit_writes row. Shared by the
  single-row (`record-audit-write!`) and batched (`record-audit-writes!`)
  entry points so the two stay identical except for how the INSERT is issued.

  `pre-image` is NOT persisted — the audit log is post-image-only (see the
  comment block above). It is still passed in because callers compute it for
  no-op detection (skip when pre == post) and because it supplies the
  `document_id` stamp for `:delete` rows (whose post-image is nil). The
  `pre_image` table column is left to default NULL."
  [op seq-n target-table target-id change-type pre-image post-image]
  {:id (psc/new-uuid)
   :op_id (:id op)
   :seq seq-n
   :target_table (name target-table)
   :target_id target-id
   :change_type (name change-type)
   :post_image (some-> post-image psc/write-json)
   ;; Per-row document attribution, from the row's OWN image — not the
   ;; op's :document, which is nil for multi-document cascade ops
   ;; (project/delete, vocab/delete) and was even once plain wrong
   ;; (pre-guard cross-document bulk-delete). This column is what as-of
   ;; reconstruction scopes by, so a missing stamp = a row invisible to
   ;; time travel. For `:delete` rows post is nil, so the stamp comes from
   ;; the pre-image — the one remaining reason we still take it as an arg.
   :document_id (or (:document_id post-image)
                    (:document_id pre-image)
                    (when (= (name target-table) "documents")
                      target-id))
   :ts (:ts op)})

(defn record-audit-write!
  "Emit an audit_writes row for `target-table`/`target-id` with the given
  change-type and post-image. `pre-image` is taken but NOT persisted (used
  only for no-op detection upstream and the delete-row `document_id` stamp —
  see `audit-row-values`). Requires *op* to be bound (or ::skip).

  Most callers should go through the higher-level `insert!`/`update-by-id!`/
  `delete-by-id!`/`merge*` helpers — those capture the post-image automatically
  from the row state. This raw entry point exists for the handful of writes
  whose meaningful change isn't a single row (e.g. span/set-tokens, where
  the change lives in the `span_tokens` junction table but conceptually
  belongs on the parent span's audit row). See the comment block above for
  the post-image-only log + synthetic-parent-row pattern.

  The per-op `:seq` ordinal is pulled from the counter atom in *op* so that
  every audit_writes row in the same op has a unique (op_id, seq) tuple.
  This is load-bearing for as-of ordering: all rows in one op share the same
  `:ts` (taken once in submit-operation*), so `seq` is what disambiguates
  the order of multiple writes to the same target row inside one op
  (e.g. bump-document-version! plus a body update on the same document).

  For high-volume same-table deletes/inserts prefer `record-audit-writes!`,
  which batches into chunked multi-row INSERTs."
  [tx target-table target-id change-type pre-image post-image]
  (ensure-op-bound!)
  (let [op *op*]
    (cond
      (nil? op)
      (throw (ex-info (str "Audited write to " target-table " " target-id
                           " outside of submit-operation!. Wrap the call, or pass"
                           " {:audit ::skip} for bootstrap-only writes.")
                      {:code 500 :target target-table :id target-id}))

      (= op ::skip)
      nil

      :else
      (jdbc/execute-one!
       tx
       (psc/format-sql
        {:insert-into :audit_writes
         :values [(audit-row-values op (reserve-seqs! op 1)
                                    target-table target-id change-type
                                    pre-image post-image)]})))))

(defn record-audit-writes!
  "Batched form of `record-audit-write!` for many rows that share one
  `target-table` and `change-type`. `entries` is a seq of
  `[target-id pre-image post-image]` triples.

  Emits the audit rows as chunked multi-row INSERTs rather than one
  `jdbc/execute-one!` round-trip per row. The per-row path dominates large
  cascade deletes: a ~200-document project delete emits ~188k audit rows,
  i.e. ~188k serial INSERTs. Per-op `:seq` ordinals are reserved in
  `entries` order, so the result is identical to calling
  `record-audit-write!` once per entry — just far fewer round-trips.

  No-op when `entries` is empty or *op* is ::skip."
  [tx target-table change-type entries]
  (ensure-op-bound!)
  (let [op *op*
        entries (vec entries)]
    (cond
      (empty? entries) nil

      (nil? op)
      (throw (ex-info (str "Audited write to " target-table
                           " outside of submit-operation!. Wrap the call, or pass"
                           " {:audit ::skip} for bootstrap-only writes.")
                      {:code 500 :target target-table}))

      (= op ::skip)
      nil

      :else
      (let [start (reserve-seqs! op (count entries))
            rows (map-indexed
                  (fn [i [target-id pre-image post-image]]
                    (audit-row-values op (+ start i)
                                      target-table target-id change-type
                                      pre-image post-image))
                  entries)]
        (doseq [chunk (partition-all audit-bulk-chunk-size rows)]
          (jdbc/execute-one! tx (psc/format-sql {:insert-into :audit_writes
                                                 :values (vec chunk)})))))))
