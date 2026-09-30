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
  (:require [clojure.string]
            [next.jdbc :as jdbc]
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
  is the time-travel source: `plaid.history.read` reconstructs every
  as-of read from it)."
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

(def ^:dynamic *pending*
  "The rows the current write transaction has written that a layer
  constraint may speak of (tokens, spans, relations, vocabulary links), as an
  atom holding a map from `[table id]` to what `note-write!` gathered, or nil
  when no transaction is collecting. Bound by the outermost
  `plaid.sql.operation/submit-operation*` and by the atomic batch handler,
  and read by `plaid.sql.constraints.layer/finish!` at the end of the
  transaction. It lives here rather than in that namespace because the audit
  helpers below fill it, and that namespace writes through them."
  nil)

(def ^:dynamic *refusal*
  "An atom bound per request by
  `plaid.rest-api.v1.layer-constraints/wrap-constraint-refusal`. An
  operation refused for breaking a layer constraint puts the violations here,
  and the middleware adds them to the 422 answer, whatever the route's own
  handler built from the operation's result."
  nil)

(def ^:private noted-tables #{"tokens" "spans" "relations" "vocab_links"})

(defn- op-kind
  "The namespace of the op type, e.g. \"span\" for :span/create."
  [op]
  (let [t (:type op)]
    (cond
      (keyword? t) (namespace t)
      (string? t) (first (clojure.string/split t #"/" 2))
      :else nil)))

(defn- prov-state
  "The provenance keys of an image's folded :metadata, or ::unknown when the
  image carries no metadata fold."
  [image]
  (if (contains? image :metadata)
    (let [m (:metadata image)]
      [(get m "prov" (get m :prov)) (get m "provConfirmed" (get m :provConfirmed))])
    ::unknown))

(defn- note-write!
  "Record one audited write of a row a layer constraint may speak of into
  `*pending*`. Keeps, per row, its layer and document, whether it is gone,
  the first image before the transaction (a token's old extent, a span's old
  token list), and the op kinds that changed what each constraint reads:
  a token's extent, a span's or link's token list, a relation's endpoints,
  a span's or relation's value (or its provenance, which decides whether
  the value is exempt). The op kind is the op type's namespace, which is how
  `finish!` tells a write on the row's own kind from a structural one."
  [op table-name id change pre post]
  (when-let [pending *pending*]
    (let [kind (op-kind op)
          group (:group-id op)
          insert? (= change :insert)
          delete? (= change :delete)
          changed? (fn [k] (or insert? (and pre post (not= (get pre k) (get post k)))))
          layer-key (case table-name
                      "tokens" :token_layer_id
                      "spans" :span_layer_id
                      "relations" :relation_layer_id
                      nil)
          image (or post pre)
          cats (case table-name
                 "tokens" (when (or delete? (changed? :begin) (changed? :end_)) #{:extent})
                 "spans" (cond-> #{}
                           (or insert? (and (contains? pre :tokens) (contains? post :tokens)
                                            (not= (:tokens pre) (:tokens post))))
                           (conj :tokens)
                           (or (changed? :value)
                               (and pre post (not= (prov-state pre) (prov-state post))))
                           (conj :value))
                 "relations" (cond-> #{}
                               (or (changed? :source_span_id) (changed? :target_span_id))
                               (conj :edge)
                               (or (changed? :value)
                                   (and pre post (not= (prov-state pre) (prov-state post))))
                               (conj :value))
                 "vocab_links" (when (or insert? (and (contains? pre :tokens) (contains? post :tokens)
                                                      (not= (:tokens pre) (:tokens post))))
                                 #{:tokens})
                 nil)]
      (swap! pending update [table-name id]
             (fn [info]
               (let [info (or info {:table table-name
                                    :id id
                                    ;; The row as it stood before the transaction, nil for
                                    ;; one it created.
                                    :pre (when-not insert? pre)})
                     info (cond-> info
                            (and (nil? (:pre-tokens info)) (not insert?) (contains? pre :tokens))
                            (assoc :pre-tokens (:tokens pre)))]
                 (cond-> (assoc info
                                :layer (or (when layer-key (get image layer-key)) (:layer info))
                                :doc (or (:document_id image) (:doc info))
                                :deleted? delete?)
                   (seq cats)
                   (update :kinds (fn [m] (reduce (fn [m c] (update m c (fnil conj #{}) kind)) m cats)))
                   (contains? cats :value)
                   (update :value-groups (fnil conj #{}) group))))))))

(defn- note!
  [op target-table target-id change-type pre-image post-image]
  (when *pending*
    (let [t (name target-table)]
      (when (noted-tables t)
        (note-write! op t target-id change-type pre-image post-image)))))

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
;; only existed for the (since-removed) XTDB ETL replica. The
;; `pre_image` column was dropped (migration
;; 20260616120000-drop-audit-pre-image). The as-of reader uses only
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

;; The batched INSERT specifies 9 columns per row (every audit
;; column but the integer key, which SQLite assigns), so each row
;; contributes 9 placeholders. Chunk at 3000 rows (27000 params) to stay under SQLite's
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
  table has no pre-image column."
  [op seq-n target-table target-id change-type pre-image post-image]
  {:op_id (:id op)
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
   ;; The vocabulary a row belongs to, which is what a vocabulary's history
   ;; is read by: its own id on a `vocab_layers` row, the entry's vocabulary
   ;; on a `vocab_items` row (from the pre-image on a delete, as above).
   ;; Links are left out. A link is annotation on a document, and its
   ;; history is the document's.
   :vocab_layer_id (case (name target-table)
                     "vocab_layers" target-id
                     "vocab_items" (or (:vocab_layer_id post-image)
                                       (:vocab_layer_id pre-image))
                     nil)
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
      (do
        (jdbc/execute-one!
         tx
         (psc/format-sql
          {:insert-into :audit_writes
           :values [(audit-row-values op (reserve-seqs! op 1)
                                      target-table target-id change-type
                                      pre-image post-image)]}))
        (note! op target-table target-id change-type pre-image post-image)))))

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
                                                 :values (vec chunk)})))
        (when *pending*
          (doseq [[target-id pre-image post-image] entries]
            (note! op target-table target-id change-type pre-image post-image)))))))
