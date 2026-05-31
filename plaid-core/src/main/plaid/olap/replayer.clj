(ns plaid.olap.replayer
  "Translate OLTP `audit_writes` rows into XTDB v2 tx-ops.

  Single job: take audit rows + their parent op record and submit one
  `xt/submit-tx` whose `:system-time` equals `op.ts`. After the
  submit, the OLAP node at `{:snapshot-time op.ts}` reproduces the
  OLTP state as it was at that moment.

  Boundary contract:
  - The audit `post_image` is `clojure.data.json/write-str` output
    of the synthetic-image map produced by `plaid.sql.common/record-audit-write!`.
    `data.json` strips keyword namespaces on write but preserves the
    snake_case column names that HoneySQL/JDBC hand back. So we receive
    keys like `:span_layer_id`, `:tokens` (junction), `:metadata` (junction).
  - Folded-junction keys (`KNOWN_JUNCTION_KEYS`) stay unqualified — that
    is the read-side contract baked into the synthetic-image emit sites
    (`plaid.sql.project/audit-project-acl-change!`, `span/set-tokens`,
    `metadata/emit-parent-audit!`, etc.). Re-namespacing would defeat
    `plaid.olap.document`'s deep reads, which read junction state
    directly off each entity doc under these unqualified keys.
  - On `:delete`, the synthetic-parent-row asymmetry (see
    `plaid.sql.metadata`'s top docstring) means the pre-image carries
    only bare parent columns. XTDB v2's `:delete-docs` closes out
    validity at the tx's system-time, so we don't need the junction
    state — queries at any earlier `:snapshot-time` see the entity's
    pre-delete put-docs version with junction state intact.

  See `/home/luke/.claude/plans/sigh-makes-me-sad-drifting-island.md`
  for the full design rationale."
  (:require [camel-snake-kebab.core :as csk]
            [clojure.data.json :as json]
            [clojure.string :as str]
            [plaid.olap.core :as olap]
            [xtdb.api :as xt]))

(def KNOWN_JUNCTION_KEYS
  "Unqualified keys produced by `clojure.data.json`'s namespace
  stripping at the synthetic-image emit sites. The replayer preserves
  these as-is on the OLAP doc; downstream reads use them under the
  same names."
  #{:tokens :metadata :readers :writers :maintainers :vocabs})

;; ============================================================
;; Per-table entity-namespace map
;;
;; The `:ns` is the namespace under which intrinsic columns get keyed
;; on the OLAP doc. `:col-renames` is the explicit column → attr map
;; for cases where the v2 attr name doesn't match a mechanical
;; "strip _id + kebab-case" of the SQL column name (e.g. spans:
;; span_layer_id → :span/layer, not :span/span-layer-id). Columns not
;; listed in `:col-renames` fall through to that mechanical rule.
;; ============================================================

(def ^:private table->spec
  {"users"           {:ns "user"
                      :col-renames {:password_hash    :user/password-hash
                                    :password_changes :user/password-changes
                                    :is_admin         :user/is-admin}}
   "projects"        {:ns "project"
                      ;; `:config` is intentionally unqualified to
                      ;; mirror the v2 row->project-bare mapper.
                      :col-renames {:config :config}}
   "documents"       {:ns "document"
                      :col-renames {:project_id  :document/project
                                    :created_at  :document/time-created
                                    :modified_at :document/time-modified}}
   "text_layers"     {:ns "text-layer"
                      :col-renames {:project_id :text-layer/project
                                    :config     :config}}
   "token_layers"    {:ns "token-layer"
                      :col-renames {:text_layer_id         :token-layer/text-layer
                                    :project_id            :token-layer/project
                                    :parent_token_layer_id :token-layer/parent-token-layer
                                    :config                :config}}
   "span_layers"     {:ns "span-layer"
                      :col-renames {:token_layer_id :span-layer/token-layer
                                    :project_id     :span-layer/project
                                    :config         :config}}
   "relation_layers" {:ns "relation-layer"
                      :col-renames {:span_layer_id :relation-layer/span-layer
                                    :project_id    :relation-layer/project
                                    :config        :config}}
   "texts"           {:ns "text"
                      :col-renames {:document_id   :text/document
                                    :text_layer_id :text/layer}}
   "tokens"          {:ns "token"
                      :col-renames {:text_id        :token/text
                                    :token_layer_id :token/layer
                                    :document_id    :token/document
                                    :end_           :token/end}}
   "spans"           {:ns "span"
                      :col-renames {:span_layer_id :span/layer
                                    :document_id   :span/document}}
   "relations"       {:ns "relation"
                      :col-renames {:relation_layer_id :relation/layer
                                    :document_id       :relation/document
                                    :source_span_id    :relation/source
                                    :target_span_id    :relation/target}}
   "vocab_layers"    {:ns "vocab"
                      :col-renames {:config :config}}
   "vocab_items"     {:ns "vocab-item"
                      :col-renames {:vocab_layer_id :vocab-item/layer}}
   "vocab_links"     {:ns "vocab-link"
                      :col-renames {:vocab_item_id :vocab-link/vocab-item
                                    :document_id   :vocab-link/document}}})

(defn- table-spec [target-table]
  (or (get table->spec target-table)
      (throw (ex-info "Unknown audit target_table"
                      {:type :replayer/malformed-row
                       :target-table target-table}))))

;; `users.id` is a TEXT primary key set to the user's username/email (see
;; the schema in resources/migrations/20260527120000-initial-schema.up.sql
;; + `plaid.sql.user/create`, which writes `:id` equal to `:username`).
;; Every other audited table uses UUIDs. Forcing UUID coercion on user
;; rows would stall the tailer with `:type :replayer/malformed-row`; we
;; accept either shape and keep non-UUID strings as-is. XTDB v2 supports
;; string `:xt/id` natively.
(defn- coerce-target-id [x]
  (cond
    (instance? java.util.UUID x) x
    ;; A blank string (empty or whitespace-only) would degrade to
    ;; `:xt/id ""` and silently create a phantom doc that no real
    ;; reader can address. Reject up-front so the tailer stalls with
    ;; a clear `:type` instead.
    (and (string? x) (str/blank? x))
    (throw (ex-info "target_id is blank"
                    {:type :replayer/malformed-row
                     :value x}))
    (string? x) (try (java.util.UUID/fromString x)
                     (catch IllegalArgumentException _ x))
    :else (throw (ex-info "target_id is not a UUID/string"
                          {:type :replayer/malformed-row
                           :value x}))))

(defn- olap-table-kw [target-table]
  (keyword "olap" target-table))

(defn parse-image
  "Parse an audit `pre_image`/`post_image` JSON string into a Clojure
  map. Returns nil for nil/empty input. Throws on malformed JSON."
  [image-json]
  (when (and image-json (not= "" image-json))
    (try
      (json/read-str image-json :key-fn keyword)
      (catch Exception e
        (throw (ex-info "Failed to parse audit image JSON"
                        {:type :replayer/malformed-row
                         :image image-json}
                        e))))))

(defn- rename-col
  "Translate a single intrinsic column key under `entity-ns`, honoring
  per-table overrides in `col-renames`."
  [entity-ns col-renames col-kw]
  (or (get col-renames col-kw)
      (keyword entity-ns (csk/->kebab-case-string (name col-kw)))))

(defn- ->uuid-or-keep [v]
  (if (string? v)
    (try (java.util.UUID/fromString v) (catch IllegalArgumentException _ v))
    v))

(defn- coerce-fk
  "FK columns (`*_id` in the schema) live in `audit_writes.post_image`
  as JSON strings — `clojure.data.json` renders the OLTP-side
  `java.util.UUID` values as strings on write. Coerce back so OLAP
  queries filtering by `:span/document = <uuid>` work."
  [col-kw v]
  (if (and (string? v) (str/ends-with? (name col-kw) "_id"))
    (->uuid-or-keep v)
    v))

(defn- coerce-junction
  "Junction-state values folded into the parent's synthetic image come
  back from JSON as plain strings/vectors/maps. Coerce to the shape the
  OLAP read API expects:
  - `:tokens` / `:readers` / `:writers` / `:maintainers` / `:vocabs`:
    vector of UUID strings → vector of UUIDs.
  - `:metadata`: Clojure map → JSON string, per
    `xtdb-nil-stripping` (XTDB v2 lowercases nested map keys, so
    user-supplied casing only round-trips if the map is opaque to
    XTDB)."
  [k v]
  (case k
    :metadata (if (string? v) v (json/write-str (or v {})))
    (:tokens :readers :writers :maintainers :vocabs)
    (if (sequential? v) (mapv ->uuid-or-keep v) v)
    v))

(defn- post-image->doc
  "Turn a parsed `post_image` map into the OLAP doc to put. Intrinsic
  columns are re-keyed under the table's entity namespace; junction
  keys pass through unqualified; `:xt/id` is set to the entity's id."
  [target-id post-image {:keys [ns col-renames]}]
  (reduce-kv
   (fn [doc k v]
     (cond
       (= :id k) doc
       (contains? KNOWN_JUNCTION_KEYS k) (assoc doc k (coerce-junction k v))
       :else (assoc doc (rename-col ns col-renames k) (coerce-fk k v))))
   {:xt/id (coerce-target-id target-id)}
   post-image))

(defn audit-row->tx-op
  "Translate a single audit row map into a single XTDB tx-op vector:

   - `:insert`             → `[:put-docs :olap/<table> doc]` (fresh doc)
   - `:update`             → `[:patch-docs :olap/<table> doc]` (key-merge)
   - `:doc-version-bump`   → `[:patch-docs :olap/<table> doc]` (key-merge)
   - `:delete`             → `[:delete-docs :olap/<table> id]`

  `:update` / `:doc-version-bump` use `:patch-docs` (key-level merge into
  the existing doc) rather than `:put-docs` (full replacement). This is
  load-bearing: an OLTP `update`/`merge` on a parent entity emits a
  post_image carrying only that table's columns — NOT the junction state
  (`:tokens`, `:metadata`, ACL lists) that lives in separate tables. A
  `:put-docs` would replace the whole doc and strip those keys; a later
  `:doc-version-bump` (bare doc row, no `:metadata`) would do the same.
  `:patch-docs` merges per-key, so junction state folded by an earlier
  op survives, and a junction-changing op (which DOES carry the full new
  junction value) replaces just that key. Verified against XTDB
  v2.2.0-beta1: patch merges keys, creates on absent, and recreates
  after delete.

  Throws ex-info with `:type :replayer/malformed-row` (carrying `:op-id`
  + `:seq` so the tailer's stall record names the offending row) on
  unrecognised input."
  [{:keys [target_table target_id change_type post_image op_id seq] :as row}]
  (try
    (when (or (nil? target_table) (nil? target_id) (nil? change_type)
              ;; Empty-string change_type would otherwise survive the
              ;; nil? check, slip past `(keyword "")` as a degenerate
              ;; keyword, then surface as "Unknown change_type" below —
              ;; technically rejected, but the operator sees the wrong
              ;; error class. Treat it as a missing-column case so the
              ;; stall reason points at the real schema violation.
              (and (string? change_type) (= "" change_type)))
      (throw (ex-info "audit row missing required column"
                      {:type :replayer/malformed-row :row row})))
    (let [spec (table-spec target_table)
          table-kw (olap-table-kw target_table)
          ct (cond-> change_type (string? change_type) keyword)]
      (case ct
        :delete
        [:delete-docs table-kw (coerce-target-id target_id)]

        (:insert :update :doc-version-bump)
        (let [post (parse-image post_image)]
          (when (nil? post)
            (throw (ex-info "audit row missing post_image for non-delete change"
                            {:type :replayer/malformed-row
                             :row row})))
          (let [doc (post-image->doc target_id post spec)]
            (if (= ct :insert)
              [:put-docs table-kw doc]
              [:patch-docs table-kw doc])))

        (throw (ex-info "Unknown change_type"
                        {:type :replayer/malformed-row
                         :change-type change_type}))))
    ;; Attach the row's (op-id, seq) to every malformed-row error from a
    ;; single chokepoint — including throws raised by table-spec /
    ;; parse-image / coerce-target-id, which don't have the row in scope.
    ;; The tailer's stall handler reads :op-id + :seq to make the stall
    ;; reason greppable against audit_writes.
    (catch clojure.lang.ExceptionInfo e
      (if (= :replayer/malformed-row (:type (ex-data e)))
        (throw (ex-info (ex-message e)
                        (merge (ex-data e) {:op-id op_id :seq seq})))
        (throw e)))))

(defn- cursor-from-op
  "Build the cursor record advanced to the last audit row of `op-record`.
  `:last-op-ts` is normalized to a canonical ISO string (via
  `olap/->iso-string`) so it stays lexicographically comparable against
  `operations.ts` in `fetch-batch`. `last-seq` is the max `:seq` across
  the op's rows (order-independent)."
  [op-record audit-rows]
  (let [last-seq (->> audit-rows (map :seq) (reduce max -1))]
    {:last-op-ts (olap/->iso-string (:op/ts op-record))
     :last-op-id (:op/id op-record)
     :last-seq last-seq
     :tailer-status :running
     :stall-reason nil}))

;; XTDB v2 does NOT sequentially merge multiple same-id ops within ONE
;; transaction: for same-id `:patch-docs` in one tx it keeps only the
;; LAST op's keys (verified against v2.2.0-beta1 — even when the doc
;; pre-exists). So the metadata-fold `:update` + `:doc-version-bump`
;; pair (both patches, same op, same tx) would lose the folded metadata
;; unless we pre-merge them into a single tx-op here. (Cross-op key
;; preservation is handled by `:patch-docs` merging against the existing
;; OLAP doc in a SEPARATE tx; this function only addresses the
;; within-op, same-tx collapse.)
(defn- merge-same-id-tx-ops
  "Collapse tx-ops within one op that target the same `[table id]` into a
  single tx-op, walking in audit-seq order. Per id:

   - `:put-docs`   — full-replace; once an id has been put in this op it
                     stays a put (an `:insert` dominates), merging keys
                     from later same-id ops.
   - `:patch-docs` — key-merge; if the id is only ever patched in this op
                     the result stays a patch, so the cross-op merge
                     against the existing OLAP doc is preserved.
   - `:delete-docs` — resets accumulated state; a later put/patch in the
                     same op recreates the entity as a FULL-replace put
                     (the patch image is a full row, and we must not
                     key-merge into the pre-delete committed version), a
                     trailing delete wins.

  Returns a vector preserving first-occurrence order across distinct ids."
  [tx-ops]
  (let [order (atom [])
        state (atom {})]
    (doseq [[op-kw table-kw arg] tx-ops]
      (let [id (if (= op-kw :delete-docs) arg (:xt/id arg))
            k [table-kw id]
            prev (get @state k)]
        (when-not prev (swap! order conj k))
        (swap! state assoc k
               (case op-kw
                 :delete-docs
                 {:op :delete :table table-kw :id id}

                 :put-docs
                 (if (or (nil? prev) (= :delete (:op prev)))
                   {:op :put :doc arg :table table-kw :id id}
                   {:op :put :doc (clojure.core/merge (:doc prev) arg) :table table-kw :id id})

                 :patch-docs
                 (cond
                   (nil? prev)
                   {:op :patch :doc arg :table table-kw :id id}
                   ;; A patch AFTER a delete within this op is a recreate:
                   ;; emit a full-replace put so XTDB does NOT key-merge the
                   ;; patch into the PRE-delete committed version (which
                   ;; would resurrect stale keys the delete was meant to
                   ;; drop). `:update` post-images are full rows, so put is
                   ;; the faithful shape. Matches the delete-then-put arm.
                   (= :delete (:op prev))
                   {:op :put :doc arg :table table-kw :id id}
                   ;; A prior put for this id keeps the put (replace)
                   ;; semantics — later patch keys merge into the put.
                   (= :put (:op prev))
                   {:op :put :doc (clojure.core/merge (:doc prev) arg) :table table-kw :id id}
                   :else
                   {:op :patch :doc (clojure.core/merge (:doc prev) arg) :table table-kw :id id})))))
    (mapv (fn [k]
            (let [{:keys [op doc table id]} (get @state k)]
              (case op
                :delete [:delete-docs table id]
                :put [:put-docs table doc]
                :patch [:patch-docs table doc])))
          @order)))

(defn- intrinsic-null?
  "True if `doc` explicitly maps an intrinsic (namespaced, non-junction)
  column to nil. `:patch-docs` SILENTLY STRIPS nil-valued keys, so such a
  column would keep its stale prior value in the OLAP doc instead of
  being cleared. Junction keys (`KNOWN_JUNCTION_KEYS`) are unqualified;
  `:xt/id` is namespaced but never nil — so a nil-valued namespaced key
  is always an intrinsic column being nulled. Reachable today via
  `tokens.precedence` (cleared by `plaid.sql.token/merge`)."
  [doc]
  (some (fn [[k v]] (and (nil? v) (some? (namespace k)))) doc))

(defn- fetch-current-junction
  "Read the entity's CURRENT (latest committed) junction-state keys from
  the OLAP node. Uses SQL `SELECT *` because XTQL `[*]` returns empty
  maps; NO `:snapshot-time`, so it reads the latest version — which is
  the pre-op state, since this op hasn't been applied yet. Returns a map
  of whatever `KNOWN_JUNCTION_KEYS` are present (empty if the entity is
  absent)."
  [node table-kw id]
  (let [row (first (xt/q node [(str "SELECT * FROM olap." (name table-kw)
                                    " WHERE _id = ?") id]))]
    (select-keys row (vec KNOWN_JUNCTION_KEYS))))

(defn- resolve-nullable-patch
  "If a merged `:patch-docs` tx-op nulls an intrinsic column, rewrite it
  as a `:put-docs` that preserves the entity's current junction state.

  Why: `:patch-docs` can't null a column (XTDB strips nil-valued keys),
  so e.g. clearing `tokens.precedence` would leave the stale value in the
  OLAP historical read. A `:put-docs` correctly drops the column (read
  back as nil), but would also wipe junction keys (`:tokens`/`:metadata`/
  ACLs) absent from this update's full-row image — so we merge the
  current doc's junction keys back in, letting the image win where it
  carries one (a junction-changing op folds the full new value).

  No-op for the common case (no nil intrinsic column): the cheap
  `:patch-docs` path is preserved, and no read is issued."
  [node [op-kw table-kw doc :as tx-op]]
  (if (and (= op-kw :patch-docs) (intrinsic-null? doc))
    (let [junction (fetch-current-junction node table-kw (:xt/id doc))]
      [:put-docs table-kw (clojure.core/merge junction doc)])
    tx-op))

(defn apply-op!
  "Translate every row in `audit-rows` into a tx-op, append a
  cursor-advance tx-op (`plaid.olap.core/cursor->tx-op`), and submit
  the batch via `xt/submit-tx`.

  `op-record` is the parent `operations` row in the shape produced by
  the tailer's SELECT — keyed `:op/id`, `:op/ts`, `:op/op-type`. The
  cursor doc captures `(op-ts, op-id, last-seq)` so resume after crash
  picks up the next op cleanly.

  Two axes, intentionally separable:
   - The CURSOR stores `(:op/ts op-record)` verbatim — this is the
     OLTP-axis identifier that `fetch-batch` orders by against
     `operations.ts`. Must be the OLTP op's wall-clock time.
   - The XTDB `:system-time` governs bitemporal monotonicity in OLAP
     storage. Defaults to the op's ts, but the tailer's monotonic
     guard can override it (clock skew / retroactive backfill) without
     disturbing the cursor's OLTP-axis value.

  Multiple audit rows targeting the same `[table id]` within one op are
  collapsed by `merge-same-id-tx-ops` into a single tx-op (XTDB does not
  sequentially merge same-id ops within one tx — see that fn's note).

  IDEMPOTENCY CAVEAT: re-applying an op onto a node that is ALREADY past
  its `system-time` throws `specified system-time older than current tx`.
  Replay is only idempotent through the tailer's `apply-op-with-guard!`,
  which bumps the write to `latest+1ms` first. After a restart-regression
  (XTDB's lazy on-disk durability — see rebuild_test) the tailer always
  re-applies via that guard, so this is safe in production. Do NOT call
  `apply-op!` directly to re-apply onto a populated node; from-epoch
  replay onto a FRESH node is fine (system-times only increase)."
  ([node op-record audit-rows]
   (apply-op! node op-record audit-rows (olap/->date (:op/ts op-record))))
  ([node op-record audit-rows system-time]
   (let [base (-> (mapv audit-row->tx-op audit-rows)
                  (merge-same-id-tx-ops))
         ;; Rewrite any patch that nulls an intrinsic column into a
         ;; junction-preserving put (XTDB patch can't null a key).
         resolved (mapv #(resolve-nullable-patch node %) base)
         tx-ops (conj resolved
                      (olap/cursor->tx-op (cursor-from-op op-record audit-rows)))]
     ;; execute-tx is synchronous (returns a TxKey only after indexing).
     ;; submit-tx returned immediately with just {:tx-id n}, leaving the
     ;; tailer's post-apply cursor read racing the indexer on slow nodes.
     ;; The monotonic-system-time guard and dropped-write detection both
     ;; depend on the cursor being visible right after the write.
     (xt/execute-tx node tx-ops {:system-time system-time}))))
