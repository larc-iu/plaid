(ns plaid.sql.token
  "SQL port of plaid.xtdb2.token. Tokens live in the `tokens` table.

  This is the hardest module of the port: it has the most schema-wide
  cascades (token deletes ripple through spans → relations and
  vocab_links), the only nontrivial constraint surface
  (overlap-mode + nesting + orphan guards), and the only operations
  that the cascades depend on (split, merge-tokens, shift-boundary,
  bulk-create/delete).

  The single biggest simplification vs v2: the entire body of each
  submit-operation! runs in one SQL transaction with serializable
  semantics under SQLite. All the match* + ASSERT TOCTOU machinery
  from v2 is GONE — pre-flight reads in plaid.sql.constraints.token
  see a consistent snapshot and no other writer can interleave, so
  the constraint check IS the safety check.

  The other thing worth noting: schema-level ON DELETE CASCADE from
  span_tokens.token_id, vocab_link_tokens.token_id, and from
  relations.{source,target}_span_id would clean up the database fine
  on a raw token DELETE, but FK cascades bypass audit_writes. To
  preserve v2 audit semantics, multi-delete! does the visible-entity
  cascade manually (relations → spans → vocab_links → tokens) and
  lets FK CASCADE only sweep up the now-orphaned junction rows."
  (:require [taoensso.timbre :as log]
            [plaid.sql.common :as psc]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.sql.metadata :as metadata]
            [plaid.sql.constraints.token :as tc])
  (:refer-clojure :exclude [get merge format]))

(def attr-keys [:token/id
                :token/text
                :token/begin
                :token/end
                :token/layer
                :token/document
                :token/precedence])

;; ============================================================
;; Row mappers
;; ============================================================

(defn- row->token
  "Translate a `tokens` row to the namespaced shape used by the REST
  API. Returns nil on nil input.

  Note `:end_` (DB column) → `:token/end` (API key). The DB column
  uses a trailing underscore because `end` is SQL-reserved; the API
  side stays plain `:token/end`."
  [row]
  (when row
    {:token/id         (:id row)
     :token/text       (:text_id row)
     :token/layer      (:token_layer_id row)
     :token/document   (:document_id row)
     :token/begin      (:begin row)
     :token/end        (:end_ row)
     :token/precedence (:precedence row)}))

(defn- token->row
  "Inverse of row->token for INSERT/UPDATE. Drops :token/document if
  absent; expects :token/text / :token/layer / :token/begin /
  :token/end / :token/precedence keys."
  [{:token/keys [id text layer document begin end precedence]}]
  (cond-> {:id id
           :text_id text
           :token_layer_id layer
           :document_id document
           :begin begin
           :end_ end}
    (some? precedence) (assoc :precedence precedence)))

;; ============================================================
;; Internal helpers
;; ============================================================

(defn- check-token-bounds! [begin end text-body]
  (cond
    (or (not (int? end)) (not (int? begin)))
    (throw (ex-info "Token end and begin must be numeric"
                    {:end end :begin begin :code 400}))
    (neg? (- end begin))
    (throw (ex-info "Token has non-positive extent"
                    {:begin begin :end end :code 400}))
    (< begin 0)
    (throw (ex-info "Token has a negative start index" {:begin begin :code 400}))
    (> end (count text-body))
    (throw (ex-info "Token ends beyond the end of its associated text"
                    {:end end :text-length (count text-body) :code 400}))))

(defn- check-token-precedence! [precedence]
  (when-not (or (nil? precedence) (int? precedence))
    (throw (ex-info "Precedence must either be not supplied or an integer."
                    {:code 400 :precedence precedence}))))

(defn- check-tokens-consistency! [tokens-attrs]
  (when-not (= 1 (->> tokens-attrs (map :token/text) distinct count))
    (throw (ex-info "Tokens must all belong to the same text" {:code 400})))
  (when-not (= 1 (->> tokens-attrs (map :token/layer) distinct count))
    (throw (ex-info "Tokens must all belong to the same layer" {:code 400}))))

(defn- fetch-text-body
  "Return the `body` column for `text-id`, or nil if missing. Used to
  validate token bounds and to expose :token/value on reads."
  [db text-id]
  (:body (psc/fetch-by-id db :texts text-id)))

(defn- fetch-text [db text-id]
  (psc/fetch-by-id db :texts text-id))

(defn- text-layer-id-of-text [db text-id]
  (:text_layer_id (fetch-text db text-id)))

(defn- token-layer-ids-of-text-layer
  "Return the set of token-layer ids attached to `text-layer-id`."
  [db text-layer-id]
  (->> (psc/q db {:select [:id]
                  :from :token_layers
                  :where [:= :text_layer_id text-layer-id]})
       (mapv :id)
       set))

;; ============================================================
;; Public reads
;; ============================================================

(defn format
  "Format a raw token record (row->token output) for external
  consumption: core attrs + :metadata if any rows exist for it."
  [db raw]
  (when raw
    (let [core (select-keys raw attr-keys)]
      (metadata/add-metadata-to-response db core "token" (:token/id raw)))))

(defn get
  "Look up a token by id. Returns the formatted (API-shape) map or nil."
  [db id]
  (when-let [row (psc/fetch-by-id db :tokens id)]
    (format db (row->token row))))

(defn project-id
  "Find the project id for a token. Single-entity lookup via the
  denormalized token_layers.project_id column (no extra hop)."
  [db id]
  (when-let [tokl-id (:token_layer_id (psc/fetch-by-id db :tokens id))]
    (:project_id (psc/fetch-by-id db :token_layers tokl-id))))

(defn get-doc-id-of-text
  "Return the document id for `text-id`."
  [db text-id]
  (:document_id (psc/fetch-by-id db :texts text-id)))

(defn get-tokens
  "Return all tokens for (layer, doc), each enriched with
  :token/value (its substring of the text body). Empty when there
  are no tokens.

  Ordering — the canonical token order (task #101, revised 2026-06-02 to
  match the query engine; see plaid.sql.query.compile):
    1. :begin ASC
    2. :precedence ASC NULLS LAST (lower precedence first; nil ranks AFTER
       any non-nil). Precedence OUTRANKS extent.
    3. :end_ ASC (shorter token first, among equal begin+precedence)
    4. :id ASC (final deterministic tiebreaker)"
  [db layer-id doc-id]
  (let [rows (psc/q db {:select [:*]
                        :from :tokens
                        :where [:and
                                [:= :token_layer_id layer-id]
                                [:= :document_id doc-id]]
                        :order-by [[:begin :asc]
                                   [:precedence :asc-nulls-last]
                                   [:end_ :asc]
                                   [:id :asc]]})
        tokens (mapv row->token rows)]
    (if (empty? tokens)
      []
      (when-let [body (fetch-text-body db (:token/text (first tokens)))]
        (mapv #(assoc % :token/value (subs body (:token/begin %) (:token/end %)))
              tokens)))))

(defn get-span-ids
  "Return the IDs of spans that reference this token (via the
  span_tokens junction)."
  [db eid]
  (->> (psc/q db {:select-distinct [:span_id]
                  :from :span_tokens
                  :where [:= :token_id eid]})
       (mapv :span_id)))

;; ============================================================
;; Junction-table helpers (private)
;; ============================================================

(defn- reparent-junction!
  "Move junction rows from `dying-id` to `surviving-id`, deduping
  where the surviving token is already linked to the same parent.
  Emits one synthetic audit row PER affected parent entity (span /
  vocab_link), pre-image carrying the old `:tokens` vector (with
  dying-id present) and post-image carrying the new vector (with
  dying-id removed; surviving-id is either appended in its slot or
  already present, depending on dedup). This mirrors v2's put-docs
  audit for the same change.

  `parent-table` is the parent entity table (`:spans` /
  `:vocab_links`) — needed so the audit row can target the right
  table. `junction-table` is the junction (`:span_tokens` /
  `:vocab_link_tokens`). `parent-id-col` is the FK column on the
  junction pointing at the parent (`:span_id` / `:vocab_link_id`).

  Portability: the UPDATE target carries an explicit alias (`j1`) so
  the EXISTS-subquery correlation is unambiguous on Postgres as well
  as SQLite. Postgres requires `UPDATE table AS alias` whenever a
  self-referencing subquery names the same physical table; SQLite
  accepts the same `AS alias` form (but NOT the implicit `table
  alias` form). HoneySQL's `:update` clause doesn't render the
  `AS alias` header for us, so we hand-build the UPDATE SQL with a
  HoneySQL subquery embedded for the EXISTS clause."
  [tx parent-table junction-table parent-id-col surviving-id dying-id]
  (let [junction-name (name junction-table)
        parent-col-name (name parent-id-col)
        ;; 0. Snapshot the parents whose token list will change — we
        ;;    need the OLD ordered token vector for the audit pre-image
        ;;    before the UPDATE rewrites the junction.
        ;; ORDER BY <parent-id-col> for deterministic per-op audit
        ;; sequence: without it the audit_writes :seq ordinals are
        ;; ordered by whatever the engine returns, which can differ
        ;; across replays (task #70). Stable order means the same
        ;; (op_id, seq) tuples reproduce on every replay.
        affected-parent-ids
        (->> (psc/q tx {:select-distinct [parent-id-col]
                        :from junction-table
                        :where [:= :token_id dying-id]
                        :order-by [parent-id-col]})
             (mapv parent-id-col))
        ;; Pre-image: parent row + old token vector (by order_idx).
        pre-images
        (when (seq affected-parent-ids)
          (let [parent-rows (psc/fetch-ids-as-map tx parent-table :id affected-parent-ids)]
            (into {}
                  (map (fn [pid]
                         (let [row (clojure.core/get parent-rows pid)
                               toks (->> (psc/q tx {:select [:token_id]
                                                    :from junction-table
                                                    :where [:= parent-id-col pid]
                                                    :order-by [:order_idx]})
                                         (mapv :token_id))]
                           [pid {:row row :tokens toks}])))
                  affected-parent-ids)))
        ;; Format the EXISTS subquery via HoneySQL — only the outer
        ;; UPDATE header is the problematic part.
        [exists-sql & exists-params]
        (psc/format-sql
         {:select [1]
          :from [[junction-table :j2]]
          :where [:and
                  [:= (keyword (str "j2." parent-col-name))
                   (keyword (str "j1." parent-col-name))]
                  [:= :j2.token_id surviving-id]]})
        update-sql (str "UPDATE " junction-name " AS j1"
                        " SET token_id = ?"
                        " WHERE j1.token_id = ?"
                        " AND NOT EXISTS (" exists-sql ")")]
    ;; 1. Move junction rows whose parent is NOT already linked to
    ;;    surviving-id.
    (psc/execute! tx (into [update-sql surviving-id dying-id] exists-params))
    ;; 2. Delete any remaining rows still pointing at dying-id (those
    ;;    are the duplicates we skipped in step 1). No alias needed —
    ;;    the WHERE clause references only the target table's columns.
    (psc/execute! tx {:delete-from junction-table
                      :where [:= :token_id dying-id]})
    ;; 3. Emit one synthetic audit row per affected parent, pre/post
    ;;    images carrying the parent row + :tokens vector before/after.
    ;;    The post-image is read directly from the (now-rewritten)
    ;;    junction so it reflects whatever the actual UPDATE +
    ;;    dedup-DELETE produced.
    (doseq [pid affected-parent-ids]
      (let [{:keys [row tokens]} (clojure.core/get pre-images pid)
            post-tokens (->> (psc/q tx {:select [:token_id]
                                        :from junction-table
                                        :where [:= parent-id-col pid]
                                        :order-by [:order_idx]})
                             (mapv :token_id))]
        (psc/record-audit-write! tx parent-table pid :update
                                 (assoc row :tokens tokens)
                                 (assoc row :tokens post-tokens))))))

;; ============================================================
;; Cascade delete
;; ============================================================

(defn- relations-referencing-spans
  "IDs of relations whose source or target span is in `span-ids`."
  [tx span-ids]
  (if (empty? span-ids)
    []
    (->> (psc/q tx {:select-distinct [:id]
                    :from :relations
                    :where [:or
                            [:in :source_span_id (vec span-ids)]
                            [:in :target_span_id (vec span-ids)]]})
         (mapv :id))))

(defn- spans-becoming-orphaned
  "Return span IDs that will be left with ZERO tokens once `token-ids`
  are removed from span_tokens. A span is orphaned iff every one of
  its token references is in `token-ids`."
  [tx token-ids]
  (if (empty? token-ids)
    []
    (->> (psc/q tx
                ;; spans whose token set is a subset of token-ids:
                ;; (count tokens in token-ids) = (count tokens overall)
                ;; for that span. Compute via a single grouped query.
                {:select [:span_id]
                 :from :span_tokens
                 :group-by [:span_id]
                 :having [:=
                          [:count :*]
                          [:sum
                           [:case
                            [:in :token_id (vec token-ids)] 1
                            :else 0]]]})
         (mapv :span_id))))

(defn- fetch-vocab-link-token-ids
  "Return the ordered token-id vector for `vl-id` from vocab_link_tokens.
  Mirror of plaid.sql.vocab-link/fetch-token-ids — duplicated to avoid
  the ns dependency cycle (vocab_link already depends on this ns
  transitively via reads)."
  [tx vl-id]
  (->> (psc/q tx {:select [:token_id]
                  :from [:vocab_link_tokens]
                  :where [:= :vocab_link_id vl-id]
                  :order-by [:order_idx]})
       (mapv :token_id)))

(defn- partition-vocab-links-by-deletion
  "For the set of vocab_links that reference any token in `token-ids`,
  partition into (a) fully orphaned (every token in token-ids — DELETE),
  and (b) partially trimmed (some tokens remain — emit a synthetic
  audit row carrying the trimmed :tokens vector).

  Returns {:orphan-vl-ids [...] :vl-trim-plan [{:vl-id :vl-row
                                                :pre-tokens :post-tokens} ...]}.

  This is the SQL port's restoration of v2's `multi-delete*` vocab-link
  trim semantics (xtdb2/token.clj:296-310): v2 kept a vocab-link with
  remaining tokens, only deleting it when its token list was fully
  consumed. The SQL port previously only handled the orphan case, with
  partial-trim silently relying on FK CASCADE on
  vocab_link_tokens.token_id (audit-invisible)."
  [tx token-ids token-ids-set]
  (if (empty? token-ids)
    {:orphan-vl-ids [] :vl-trim-plan []}
    (let [;; Vocab_link ids touched by the delete set.
          touched-vl-ids (->> (psc/q tx {:select-distinct [:vocab_link_id]
                                         :from :vocab_link_tokens
                                         :where [:in :token_id (vec token-ids)]})
                              (mapv :vocab_link_id))]
      (if (empty? touched-vl-ids)
        {:orphan-vl-ids [] :vl-trim-plan []}
        (let [vl-rows-by-id (psc/fetch-ids-as-map tx :vocab_links :id touched-vl-ids)
              plans (for [vl-id touched-vl-ids
                          :let [pre-tokens (fetch-vocab-link-token-ids tx vl-id)
                                post-tokens (vec (remove token-ids-set pre-tokens))]]
                      {:vl-id vl-id
                       :vl-row (clojure.core/get vl-rows-by-id vl-id)
                       :pre-tokens pre-tokens
                       :post-tokens post-tokens})
              {orphans true trims false} (group-by #(empty? (:post-tokens %)) plans)]
          {:orphan-vl-ids (mapv :vl-id orphans)
           :vl-trim-plan (vec trims)})))))

(defn- trim-vocab-link-tokens!
  "Emit a synthetic audit row on :vocab_links carrying the trimmed
  :tokens vector, then rewrite the junction table to match. The
  junction rewrite is itself unaudited (the synthetic audit row IS
  the change record for ETL); we explicitly DELETE the gone-token
  junction rows rather than relying on FK CASCADE to ensure the
  pre/post in the audit row matches the DB state regardless of
  cascade ordering nuances.

  `plan` keys: :vl-id, :vl-row (the spans-style row, includes
  :id :vocab_item_id :document_id), :pre-tokens, :post-tokens."
  [tx {:keys [vl-id vl-row pre-tokens post-tokens]}]
  (let [pre-image  (assoc vl-row :tokens pre-tokens)
        post-image (assoc vl-row :tokens post-tokens)]
    (psc/record-audit-write! tx :vocab_links vl-id :update pre-image post-image)
    ;; Drop junction rows whose token no longer survives. FK CASCADE
    ;; on vocab_link_tokens.token_id (when the token row goes away
    ;; below) would handle this anyway, but doing it here keeps the
    ;; junction state self-consistent immediately after the audit row.
    (psc/execute! tx
                  {:delete-from :vocab_link_tokens
                   :where [:and
                           [:= :vocab_link_id vl-id]
                           [:not-in :token_id (if (seq post-tokens) (vec post-tokens) [nil])]]})))

(defn- sweep-entity-metadata!
  "Delete `entity_metadata` rows for the given entity-type/ids cluster.
  No-op when ids is empty.

  Audit strategy: this sweep is INTENTIONALLY unaudited. The parent
  entity's `:delete` audit row (just emitted via `psc/delete-by-id!`)
  signals the entity is gone, and metadata is treated by the ETL
  replayer as parent-owned state (any metadata key whose entity row
  is absent must also be absent in the history replica). Auditing each
  metadata DELETE individually would be high-volume noise without
  adding information ETL can't already derive.

  entity_metadata has no FK to its parent, so the row would otherwise
  be orphaned in SQLite. We sweep here for the cascaded entity types
  the same way the token sweep at the bottom of `multi-delete!`
  handles tokens directly."
  [tx entity-type ids]
  (when (seq ids)
    (psc/execute! tx
                  {:delete-from :entity_metadata
                   :where [:and
                           [:= :entity_type entity-type]
                           [:in :entity_id (vec ids)]]})))

(defn multi-delete!
  "Delete every token in `eids`, AND cascade to the visible entities
  whose existence depends on them — orphaned spans (no tokens left),
  orphaned vocab_links (no tokens left), partially-orphaned vocab_links
  (some but not all tokens deleted — those get TRIMMED, not deleted —
  see v2's `multi-delete*` for the original semantics), and relations
  whose source/target span is about to disappear. Each visible-entity
  delete uses psc/delete-by-id! so audit_writes captures it.

  Ordering rationale: a span deletion FK-cascades to relations
  (relations.{source,target}_span_id ON DELETE CASCADE). FK cascades
  bypass audit_writes, so we delete the affected RELATIONS FIRST
  (audited), then the spans (audited), then vocab_links — both the
  fully orphaned ones (audited delete) and the partially trimmed ones
  (synthetic audit row carrying the new `:tokens` vector, then the
  junction rows actually get rewritten or FK-swept) — then the tokens
  themselves. The schema's ON DELETE CASCADE on the junction tables
  (span_tokens, vocab_link_tokens) cleans up the junction rows when
  the parent is gone — those are high-volume and not separately
  audited (the parent's row carries the change).

  entity_metadata cleanup: see `sweep-entity-metadata!` — we sweep
  metadata for each cascaded entity type (relations, spans, vocab_links,
  tokens) AFTER the audited parent delete. The sweeps themselves are
  unaudited; the parent entity's :delete audit row signals the metadata
  going away in the history replica."
  [tx eids]
  (when (seq eids)
    (let [eids (vec eids)
          eids-set (set eids)
          ;; 1. Which spans will have zero remaining tokens?
          orphan-span-ids (spans-becoming-orphaned tx eids)
          ;; 2. Which relations reference one of those spans?
          rel-ids (relations-referencing-spans tx orphan-span-ids)
          ;; 3. Vocab_links touched by this delete set — split into
          ;;    fully-orphaned (DELETE) vs partial-trim (synthetic
          ;;    audit row carrying the trimmed :tokens vector).
          {:keys [orphan-vl-ids vl-trim-plan]}
          (partition-vocab-links-by-deletion tx eids eids-set)]
      ;; Order: relations → spans → vocab_links → tokens.
      ;; Each cascade phase is one DELETE ... WHERE id IN (...) RETURNING *
      ;; round-trip; per-id audit rows still emitted via delete-where!.
      (when (seq rel-ids)
        (psc/delete-where! tx :relations [:in :id rel-ids]))
      (sweep-entity-metadata! tx "relation" rel-ids)
      (when (seq orphan-span-ids)
        (psc/delete-where! tx :spans [:in :id orphan-span-ids]))
      (sweep-entity-metadata! tx "span" orphan-span-ids)
      ;; Vocab_link partial trim: emit synthetic audit + rewrite junctions.
      (doseq [plan vl-trim-plan]
        (trim-vocab-link-tokens! tx plan))
      ;; Vocab_link full-orphan delete.
      (when (seq orphan-vl-ids)
        (psc/delete-where! tx :vocab_links [:in :id orphan-vl-ids]))
      (sweep-entity-metadata! tx "vocab-link" orphan-vl-ids)
      (psc/delete-where! tx :tokens [:in :id eids])
      (sweep-entity-metadata! tx "token" eids))))

;; ============================================================
;; Single create
;; ============================================================

(defn- schema-check!
  "Pre-flight validation for a single token create.
  Throws ex-info (400/404/409) on violation."
  [tx {:token/keys [id text layer begin end precedence]}]
  (let [text-row (fetch-text tx text)
        text-body (:body text-row)
        text-layer-id (:text_layer_id text-row)
        token-layers (when text-layer-id (token-layer-ids-of-text-layer tx text-layer-id))]
    (when (psc/fetch-by-id tx :tokens id)
      (throw (ex-info (psc/err-msg-already-exists "Token" id) {:id id :code 409})))
    (when (nil? (psc/fetch-by-id tx :token_layers layer))
      (throw (ex-info (psc/err-msg-not-found "Token layer" layer) {:id layer :code 400})))
    (when (nil? text-row)
      (throw (ex-info (psc/err-msg-not-found "Text" text) {:id text :code 400})))
    (when-not (contains? token-layers layer)
      (throw (ex-info (str "Text layer " text-layer-id " is not linked to token layer " layer ".")
                      {:text-layer-id text-layer-id :token-layer-id layer :code 400})))
    (check-token-bounds! begin end text-body)
    (check-token-precedence! precedence)))

(defn create
  "Create a single token. `attrs` requires :token/text, :token/layer,
  :token/begin, :token/end; optional :token/precedence. `metadata` (a
  map of key→value) is inserted into entity_metadata when provided.

  Audit shape: ONE audit_writes row against `:tokens` with change_type
  :insert. pre = nil; post = the inserted token row, augmented with a
  `:metadata` key when `metadata` is non-empty. Folding metadata into
  the :insert post_image avoids the noisy :insert + :update pair we'd
  otherwise emit (task #59). Tokens have no junction-table tokens
  themselves, so only `:metadata` is folded.

  Returns {:success true :extra <new-id>} on success."
  ([db attrs user-id] (create db attrs user-id nil))
  ([db attrs user-id metadata]
   (let [new-id (psc/new-uuid)
         {:token/keys [text layer begin end precedence]} attrs
         token {:token/id new-id
                :token/text text
                :token/layer layer
                :token/begin begin
                :token/end end
                :token/precedence precedence}]
     ;; Resolve doc-id outside the tx for the operation header. Inside
     ;; the tx we use the actual row.
     (let [doc-id (get-doc-id-of-text db text)]
       (submit-operation!
        [tx db {:type :token/create
                :project (when layer
                           (:project_id (psc/fetch-by-id db :token_layers layer)))
                :document doc-id
                :description (str "Create token " begin "-" end " in layer " layer)
                :user user-id}]
        (let [token-with-doc (assoc token :token/document doc-id)
              row (token->row token-with-doc)]
          (schema-check! tx token-with-doc)
          (tc/enforce! tx :create
                       {:layer layer :doc-id doc-id :begin begin :end end
                        :records [token-with-doc]})
          (if (seq metadata)
            ;; Manual insert + audit so the post_image folds in
            ;; :metadata, avoiding a separate :update audit row
            ;; (task #59).
            (do
              (psc/execute! tx {:insert-into :tokens :values [row]})
              (metadata/insert-metadata! tx "token" new-id metadata
                                         {:skip-parent-audit? true})
              (let [post-row (psc/fetch-by-id tx :tokens new-id)
                    post-image (assoc post-row :metadata metadata)]
                (psc/record-audit-write! tx :tokens new-id :insert nil post-image)))
            ;; No metadata: use the audited insert! helper as before.
            (psc/insert! tx :tokens row))
          new-id))))))

;; ============================================================
;; Merge (update extent + precedence)
;; ============================================================

(declare resize-child-cascade!)

(defn- set-extent
  "Return the new {:begin ... :end_ ...} for an extent update; runs
  bounds checks. Reads `pre` (the current row) and the text body to
  validate."
  [tx pre {new-begin :token/begin new-end :token/end}]
  (let [text-body (fetch-text-body tx (:text_id pre))
        nb (or new-begin (:begin pre))
        ne (or new-end (:end_ pre))]
    (check-token-bounds! nb ne text-body)
    {:begin nb :end_ ne}))

(defn- set-precedence
  "Return {:precedence ...} for a precedence change. nil clears the
  column. No-change → empty map."
  [precedence]
  (check-token-precedence! precedence)
  {:precedence precedence})

(defn merge
  "Update an existing token's extent and/or precedence. `m` may
  include :token/begin, :token/end, and :token/precedence.

  If the extent changes on a layer with descendants, this cascades
  to nested tokens via resize-child-cascade! (mirrors v2's behavior).

  Returns {:success true :extra <token-id>}."
  [db eid m user-id]
  (submit-operation!
   [tx db {:type :token/update
           :project (project-id db eid)
           :document (:document_id (psc/fetch-by-id db :tokens eid))
           :description (let [changes (cond-> []
                                        (contains? m :token/begin) (conj "start")
                                        (contains? m :token/end) (conj "end")
                                        (contains? m :token/precedence) (conj "precedence"))]
                          (str "Update " (clojure.string/join ", " changes)
                               " of token " eid))
           :user user-id}]
   (let [pre (psc/fetch-by-id tx :tokens eid)]
     (when (nil? pre)
       (throw (ex-info (psc/err-msg-not-found "Token" eid) {:id eid :code 404})))
     (let [{old-begin :begin old-end :end_ layer :token_layer_id doc-id :document_id} pre
           extent-attrs (set-extent tx pre (select-keys m [:token/begin :token/end]))
           new-begin (:begin extent-attrs)
           new-end (:end_ extent-attrs)
           extents-changing? (or (contains? m :token/begin)
                                 (contains? m :token/end))
           prec-attrs (if (contains? m :token/precedence)
                        (set-precedence (:token/precedence m))
                        {})
           dlids (when extents-changing? (tc/descendant-layer-ids tx layer))]
       ;; Step 1: cascade resize down through descendants BEFORE the
       ;; parent's own update — same order as v2 (cascade tx-ops were
       ;; appended in front of the parent put, but here we just do it
       ;; in transaction order). The parent's new extent is what we
       ;; cascade with.
       (when extents-changing?
         (resize-child-cascade! tx dlids layer doc-id
                                old-begin old-end new-begin new-end))
       ;; Step 2: apply the parent update.
       (psc/update-by-id! tx :tokens eid (clojure.core/merge extent-attrs prec-attrs))
       ;; Step 3: constraints. Post-state in tx is what we're checking
       ;; against — orphan guard runs against the now-trimmed children.
       (tc/enforce! tx :update
                    {:layer layer
                     :doc-id doc-id
                     :eid eid
                     :begin old-begin
                     :end old-end
                     :new-begin new-begin
                     :new-end new-end
                     :extents-changing? extents-changing?
                     :dlids dlids
                     :records [(clojure.core/merge (row->token pre)
                                                   {:token/begin new-begin
                                                    :token/end new-end
                                                    :token/layer layer})]})
       eid))))

;; ============================================================
;; Delete
;; ============================================================

(defn- descendant-token-ids-in-extent
  "Vector of descendant token IDs (same doc) nested within [lo, hi)."
  [tx dlids doc-id lo hi]
  (mapv :token/id (tc/descendant-tokens-in-extent tx dlids doc-id lo hi)))

(defn delete
  "Delete one token. Cascades to nested descendant tokens (and their
  dependents via multi-delete!)."
  [db eid user-id]
  (let [pre (psc/fetch-by-id db :tokens eid)]
    (submit-operation!
     [tx db {:type :token/delete
             :project (project-id db eid)
             :document (:document_id pre)
             :description (str "Delete token " eid)
             :user user-id}]
     (let [pre-tx (psc/fetch-by-id tx :tokens eid)
           _ (when (nil? pre-tx)
               (throw (ex-info (psc/err-msg-not-found "Token" eid) {:id eid :code 404})))
           {layer :token_layer_id doc-id :document_id begin :begin end :end_} pre-tx
           dlids (tc/descendant-layer-ids tx layer)
           descendant-ids (descendant-token-ids-in-extent tx dlids doc-id begin end)]
       ;; Pre-flight overlap check (rejects :partitioning single delete).
       ;; Pre-cascade for non-partitioning layers this is a no-op, so
       ;; the only effect is failing fast on partitioning before we
       ;; tear anything down.
       (tc/enforce! tx :delete
                    {:layer layer :doc-id doc-id :begin begin :end end :dlids []})
       (multi-delete! tx (cons eid descendant-ids))
       ;; Re-run with real dlids to fire the post-cascade orphan guard.
       (tc/enforce! tx :delete
                    {:layer layer :doc-id doc-id :begin begin :end end :dlids dlids})
       eid))))

;; ============================================================
;; Bulk create
;; ============================================================

(defn bulk-create
  "Bulk-create tokens. All entries in `attrs-vec` must share the same
  :token/text and :token/layer. Returns {:success true :extra <ids>}
  on success."
  [db attrs-vec user-id]
  (let [layer-id (-> attrs-vec first :token/layer)
        text-id (-> attrs-vec first :token/text)
        doc-id (when text-id (get-doc-id-of-text db text-id))]
    (submit-operation!
     [tx db {:type :token/bulk-create
             :project (when layer-id
                        (:project_id (psc/fetch-by-id db :token_layers layer-id)))
             :document doc-id
             :description (str "Bulk create " (count attrs-vec) " tokens in layer " layer-id)
             :user user-id}]
     ;; Cross-row consistency check (throws 400 if attrs disagree on text/layer).
     (check-tokens-consistency! attrs-vec)
     (let [text-row (fetch-text tx text-id)]
       (when (nil? (psc/fetch-by-id tx :token_layers layer-id))
         (throw (ex-info (psc/err-msg-not-found "Token layer" layer-id)
                         {:id layer-id :code 400})))
       (when (nil? text-row)
         (throw (ex-info (psc/err-msg-not-found "Text" text-id) {:id text-id :code 400})))
       (let [text-body (:body text-row)
             text-length (count text-body)
             text-layer-id (:text_layer_id text-row)
             token-layer-set (token-layer-ids-of-text-layer tx text-layer-id)]
         (when-not (contains? token-layer-set layer-id)
           (throw (ex-info (str "Text layer " text-layer-id " is not linked to token layer " layer-id ".")
                           {:text-layer-id text-layer-id :token-layer-id layer-id :code 400})))
         (let [records (mapv (fn [a]
                               (let [tid (psc/new-uuid)]
                                 {:token/id tid
                                  :token/text text-id
                                  :token/layer layer-id
                                  :token/document doc-id
                                  :token/begin (:token/begin a)
                                  :token/end (:token/end a)
                                  :token/precedence (:token/precedence a)
                                  ::metadata (:metadata a)}))
                             attrs-vec)]
           ;; Per-token bounds + precedence check.
           (doseq [t records]
             (check-token-bounds! (:token/begin t) (:token/end t) text-body)
             (check-token-precedence! (:token/precedence t)))
           ;; Constraint enforcement (overlap + intra-batch + nesting).
           (tc/enforce! tx :bulk-create
                        {:layer layer-id
                         :doc-id doc-id
                         :text-length text-length
                         :records (mapv #(dissoc % ::metadata) records)})
           ;; Bulk INSERT.
           (psc/insert-many! tx :tokens (mapv token->row records))
           ;; Per-token metadata after the inserts.
           (doseq [t records]
             (when (seq (::metadata t))
               (metadata/insert-metadata! tx "token" (:token/id t) (::metadata t))))
           (mapv :token/id records)))))))

;; ============================================================
;; Bulk delete
;; ============================================================

(defn bulk-delete
  "Delete every token in `eids`. Each token's descendant subtree is
  cascade-deleted alongside it, and the visible-entity cascade
  (relations / spans / vocab_links) runs once over the full set."
  [db eids user-id]
  (let [eids (vec (distinct eids))
        token-rows (psc/fetch-ids db :tokens eids)
        token-light (mapv (fn [r] {:token/id (:id r)
                                   :token/layer (:token_layer_id r)
                                   :token/document (:document_id r)
                                   :token/begin (:begin r)
                                   :token/end (:end_ r)})
                          token-rows)
        ;; Group by [layer, doc] tuple — not just layer. A partitioning
        ;; layer can span documents, and the partitioning
        ;; all-or-nothing check + the orphan guard both work per
        ;; (layer, doc) pair. See enforce-overlap-bulk-delete in
        ;; plaid.sql.constraints.token.
        tokens-by-layer-doc (group-by (juxt :token/layer :token/document) token-light)
        first-t (first token-light)
        doc-id (:token/document first-t)]
    (submit-operation!
     [tx db {:type :token/bulk-delete
             :project (when first-t
                        (:project_id (psc/fetch-by-id db :token_layers (:token/layer first-t))))
             :document doc-id
             :description (str "Bulk delete " (count eids) " tokens")
             :user user-id}]
     (let [;; dlids depend only on the layer, so key the cache by layer
           ;; and dedupe over the (layer, doc) tuples.
           dlids-by-layer (into {}
                                (map (fn [lid] [lid (tc/descendant-layer-ids tx lid)]))
                                (distinct (map first (keys tokens-by-layer-doc))))
           descendant-ids (mapcat (fn [t]
                                    (descendant-token-ids-in-extent
                                     tx (clojure.core/get dlids-by-layer (:token/layer t))
                                     (:token/document t)
                                     (:token/begin t) (:token/end t)))
                                  token-light)
           all-ids (distinct (concat eids descendant-ids))]
       ;; Pre-flight: partitioning all-or-nothing check. Phase :pre
       ;; tells enforce! to skip the orphan guard (cascade hasn't run
       ;; yet) but still run the overlap-mode partitioning check.
       (tc/enforce! tx :bulk-delete
                    {:tokens-by-layer-doc tokens-by-layer-doc
                     :dlids-by-layer {}
                     :phase :pre})
       (multi-delete! tx all-ids)
       ;; Post-cascade orphan guard. Phase :post skips the
       ;; partitioning all-or-nothing check (the layer is now empty so
       ;; the count comparison would misfire) but enforces the
       ;; orphan-descendant guard against the original extents in
       ;; tokens-by-layer-doc.
       (tc/enforce! tx :bulk-delete
                    {:tokens-by-layer-doc tokens-by-layer-doc
                     :dlids-by-layer dlids-by-layer
                     :phase :post})
       eids))))

;; ============================================================
;; Split
;; ============================================================

(defn- split-one!
  "Split the token row `t` at `position`. Updates t's end_ to
  position and inserts a new right-half token with begin = position.
  Returns the new (right-half) token id."
  [tx t position]
  (let [{:keys [id text_id token_layer_id document_id begin end_]} t]
    (when-not (and (int? position) (> position begin) (< position end_))
      (throw (ex-info "Split position must be strictly between token begin and end"
                      {:code 400 :position position :begin begin :end end_})))
    (let [new-id (psc/new-uuid)]
      (psc/update-by-id! tx :tokens id {:end_ position})
      (psc/insert! tx :tokens
                   {:id new-id
                    :text_id text_id
                    :token_layer_id token_layer_id
                    :document_id document_id
                    :begin position
                    :end_ end_})
      new-id)))

(defn- split-straddlers!
  "Split every descendant token straddling `position` at `position`.
  Used by the split cascade and the partitioning shift cascade."
  [tx straddlers position]
  (doseq [s straddlers]
    (let [t-row (psc/fetch-by-id tx :tokens (:token/id s))]
      (when t-row
        (split-one! tx t-row position)))))

(defn split
  "Split `eid` at `position`. Cascades to descendant tokens that
  straddle position. Returns {:success true :extra <new-right-id>}."
  [db eid position user-id]
  (let [pre (psc/fetch-by-id db :tokens eid)]
    (submit-operation!
     [tx db {:type :token/split
             :project (project-id db eid)
             :document (:document_id pre)
             :description (str "Split token " eid " at position " position)
             :user user-id}]
     (let [t-row (psc/fetch-by-id tx :tokens eid)
           _ (when (nil? t-row)
               (throw (ex-info (psc/err-msg-not-found "Token" eid) {:id eid :code 404})))
           {layer :token_layer_id doc-id :document_id begin :begin end :end_} t-row
           dlids (tc/descendant-layer-ids tx layer)
           straddlers (tc/straddling-descendant-tokens-in tx dlids doc-id begin end position)
           new-right-id (split-one! tx t-row position)]
       (split-straddlers! tx straddlers position)
       (tc/enforce! tx :split
                    {:layer layer :doc-id doc-id
                     :begin begin :end end
                     :position position
                     :dlids dlids})
       new-right-id))))

;; ============================================================
;; Merge-tokens (combine two adjacent/overlapping tokens into one)
;; ============================================================

(defn merge-tokens
  "Merge two tokens in the same (layer, document) into one. The
  surviving token is the one with the smaller :begin (left); its
  extent grows to cover the union, and the right token is deleted.
  Spans and vocab_links that referenced the right token are
  reparented onto the left.

  Returns {:success true :extra <surviving-id>} on success."
  [db token-id-1 token-id-2 user-id]
  (let [t1 (psc/fetch-by-id db :tokens token-id-1)
        t2 (psc/fetch-by-id db :tokens token-id-2)]
    (submit-operation!
     [tx db {:type :token/merge
             :project (project-id db token-id-1)
             :document (:document_id t1)
             :description (str "Merge tokens " token-id-1 " and " token-id-2)
             :user user-id}]
     (let [t1 (psc/fetch-by-id tx :tokens token-id-1)
           t2 (psc/fetch-by-id tx :tokens token-id-2)
           _ (when (nil? t1)
               (throw (ex-info (psc/err-msg-not-found "Token" token-id-1) {:id token-id-1 :code 404})))
           _ (when (nil? t2)
               (throw (ex-info (psc/err-msg-not-found "Token" token-id-2) {:id token-id-2 :code 404})))
           _ (when (not= (:token_layer_id t1) (:token_layer_id t2))
               (throw (ex-info "Tokens must belong to the same layer" {:code 400})))
           _ (when (not= (:document_id t1) (:document_id t2))
               (throw (ex-info "Tokens must belong to the same document" {:code 400})))
           [left right] (if (<= (:begin t1) (:begin t2)) [t1 t2] [t2 t1])
           layer (:token_layer_id left)
           doc-id (:document_id left)
           merged-begin (min (:begin t1) (:begin t2))
           merged-end (max (:end_ t1) (:end_ t2))
           left-light {:token/id (:id left)
                       :token/layer layer
                       :token/document doc-id
                       :token/begin (:begin left)
                       :token/end (:end_ left)}
           right-light {:token/id (:id right)
                        :token/layer layer
                        :token/document doc-id
                        :token/begin (:begin right)
                        :token/end (:end_ right)}]
       ;; Pre-flight: overlap-mode + (for partitioning) adjacency,
       ;; plus nesting check for the merged extent.
       (tc/enforce! tx :merge
                    {:layer layer :doc-id doc-id
                     :t1 left-light :t2 right-light
                     :records [(assoc left-light
                                      :token/begin merged-begin
                                      :token/end merged-end)]})
       ;; Reparent spans referencing the right token onto the left.
       (reparent-junction! tx :spans :span_tokens :span_id (:id left) (:id right))
       ;; Same for vocab_links.
       (reparent-junction! tx :vocab_links :vocab_link_tokens :vocab_link_id (:id left) (:id right))
       ;; Grow the left token to the union extent.
       (psc/update-by-id! tx :tokens (:id left)
                          {:begin merged-begin :end_ merged-end})
       ;; Delete the right token only. Descendants inside [right.begin,
       ;; right.end_) MUST be preserved — after the merge they sit inside
       ;; the surviving left token (whose extent now covers the union),
       ;; so the parent-containment invariant still holds.
       (multi-delete! tx [(:id right)])
       (:id left)))))

;; ============================================================
;; Shift-boundary
;; ============================================================

(declare resize-child-cascade!)

(defn shift-boundary
  "Move one of `token-id`'s boundaries to a new position. `attrs` may
  include :token/begin and/or :token/end. On :partitioning layers the
  adjacent neighbor is auto-adjusted so the partition stays intact."
  [db token-id attrs user-id]
  (let [pre (psc/fetch-by-id db :tokens token-id)]
    (submit-operation!
     [tx db {:type :token/shift-boundary
             :project (project-id db token-id)
             :document (:document_id pre)
             :description (str "Shift boundary of token " token-id)
             :user user-id}]
     (let [pre (psc/fetch-by-id tx :tokens token-id)
           _ (when (nil? pre)
               (throw (ex-info (psc/err-msg-not-found "Token" token-id) {:id token-id :code 404})))
           {layer :token_layer_id doc-id :document_id begin :begin end :end_
            text-id :text_id} pre
           new-begin (or (:token/begin attrs) begin)
           new-end (or (:token/end attrs) end)
           text-body (fetch-text-body tx text-id)
           text-length (count text-body)]
       (check-token-bounds! new-begin new-end text-body)
       (let [dlids (tc/descendant-layer-ids tx layer)
             ;; Step 1: pre-flight overlap check. For partitioning
             ;; layers this also returns the neighbor adjustments we
             ;; need to apply so the partition stays a valid cover.
             ;; For :non-overlapping it just validates and returns [].
             shift-adjustments
             (tc/prepare-shift! tx {:layer layer
                                    :doc-id doc-id
                                    :token-id token-id
                                    :begin begin :end end
                                    :new-begin new-begin :new-end new-end
                                    :text-length text-length})]
         ;; Step 2: apply the partitioning neighbor adjustments.
         (doseq [{:keys [id attrs]} shift-adjustments]
           (psc/update-by-id! tx :tokens id attrs))
         ;; Step 3: cascade the resize down to descendants.
         (resize-child-cascade! tx dlids layer doc-id begin end new-begin new-end)
         ;; Step 4: apply the parent boundary change.
         (psc/update-by-id! tx :tokens token-id
                            {:begin new-begin :end_ new-end})
         ;; Step 5: post-state nesting + parent-side guard check.
         (tc/enforce! tx :shift
                      {:layer layer :doc-id doc-id :token-id token-id
                       :begin begin :end end
                       :new-begin new-begin :new-end new-end
                       :text-length text-length
                       :extents-changing? true
                       :dlids dlids
                       :records [{:token/id token-id
                                  :token/layer layer
                                  :token/document doc-id
                                  :token/begin new-begin
                                  :token/end new-end}]})
         token-id)))))

;; ============================================================
;; Resize cascade (used by merge / shift-boundary)
;; ============================================================

(defn- resize-child-cascade!
  "Cascade a parent token resize ([begin,end) → [nb,ne)) to descendant
  tokens. Mirrors v2's resize-child-cascade*:

   - :partitioning parent — its neighbor grows to cover the freed
     region; for each moved boundary, split each straddling
     descendant at the moved position so the outside half re-homes
     to the neighbor by offset containment.
   - non-overlapping / :any parent — delete descendants that lose
     all positive overlap with the new extent (left fully outside,
     or collapsed when the parent shrinks to zero) and trim those
     straddling the new edge."
  [tx dlids layer doc-id begin end nb ne]
  (cond
    (empty? dlids) nil

    (= :partitioning (tc/layer-overlap-mode tx layer))
    (let [moved (cond-> []
                  (not= nb begin) (conj nb)
                  (not= ne end) (conj ne))]
      (doseq [p moved]
        (let [straddlers (tc/straddling-descendant-tokens-at tx dlids doc-id p)]
          (split-straddlers! tx straddlers p))))

    :else
    (let [descendants (tc/descendant-tokens-in-extent tx dlids doc-id begin end)
          classify (fn [d]
                     (let [lo (max (:token/begin d) nb)
                           hi (min (:token/end d) ne)]
                       (cond
                         (>= lo hi) :delete
                         (and (= lo (:token/begin d)) (= hi (:token/end d))) :keep
                         :else :trim)))
          {to-delete :delete to-trim :trim} (group-by classify descendants)]
      (when (seq to-delete)
        (multi-delete! tx (mapv :token/id to-delete)))
      (doseq [d to-trim]
        (psc/update-by-id! tx :tokens (:token/id d)
                           {:begin (max (:token/begin d) nb)
                            :end_ (min (:token/end d) ne)})))))

;; ============================================================
;; Metadata
;; ============================================================

(defn set-metadata
  "Replace all metadata on a token."
  [db eid metadata-map user-id]
  (submit-operation!
   [tx db {:type :token/set-metadata
           :project (project-id db eid)
           :document (:document_id (psc/fetch-by-id db :tokens eid))
           :description (str "Set metadata on token " eid
                             " with " (count metadata-map) " keys")
           :user user-id}]
   (metadata/validate-entity-type! "token")
   (when (nil? (psc/fetch-by-id tx :tokens eid))
     (throw (ex-info (psc/err-msg-not-found "Token" eid) {:code 404 :id eid})))
   (metadata/replace-metadata! tx "token" eid metadata-map)
   eid))

(defn patch-metadata
  "Shallow-merge a metadata patch on a token: keys present set/overwrite,
  a null value deletes that key, omitted keys are untouched. See
  `plaid.sql.metadata/patch-metadata!`."
  [db eid patch user-id]
  (submit-operation!
   [tx db {:type :token/patch-metadata
           :project (project-id db eid)
           :document (:document_id (psc/fetch-by-id db :tokens eid))
           :description (str "Patch metadata on token " eid
                             " with " (count patch) " keys")
           :user user-id}]
   (metadata/validate-entity-type! "token")
   (when (nil? (psc/fetch-by-id tx :tokens eid))
     (throw (ex-info (psc/err-msg-not-found "Token" eid) {:code 404 :id eid})))
   (metadata/patch-metadata! tx "token" eid patch)
   eid))

(defn delete-metadata
  "Remove all metadata from a token."
  [db eid user-id]
  (submit-operation!
   [tx db {:type :token/delete-metadata
           :project (project-id db eid)
           :document (:document_id (psc/fetch-by-id db :tokens eid))
           :description (str "Delete all metadata from token " eid)
           :user user-id}]
   (metadata/validate-entity-type! "token")
   (when (nil? (psc/fetch-by-id tx :tokens eid))
     (throw (ex-info (psc/err-msg-not-found "Token" eid) {:code 404 :id eid})))
   (metadata/delete-metadata! tx "token" eid)
   eid))

;; ============================================================
;; Text-edit cascade compensator (called by plaid.sql.text)
;; ============================================================

(defn compensate-partition-layers!
  "After a text-body edit reindexes/deletes tokens, extend remaining
  tokens in every :partitioning layer to close any gap left by the
  edit and validate the result. Mirrors v2's
  compensate-after-cascade: the pure gap-fill algorithm is identical
  — only the persistence path changes.

  `tokens` is the surviving (post-reindex) token set in the form
  {:token/id ... :token/layer ... :token/begin ... :token/end ...};
  `new-text-length` is the length of the new text body.

  Empty-layer note: a partitioning layer with NO surviving tokens
  after the edit is intentionally skipped — per the partitioning
  contract an EMPTY layer is a valid state (\"always empty or a
  complete cover\"). The pure deletion case (all tokens consumed by
  the deleted range) lands in that valid empty state and needs no
  compensation. v2 had a TOCTOU assert (`text-edit-partition-asserts`)
  to fence a concurrent establishment against the old text length,
  but under the SQL port's serializable tx that race is impossible.

  Partial-cover invariant: given that `apply-text-edits` preserves
  positional ordering (tokens stay sorted by begin, never crossing
  each other) and that a partitioning layer cannot pre-edit have
  overlaps or gaps, the algorithm here yields a valid partition for
  every survivor set with at least one token:
    1. The first token's begin is forced to 0.
    2. Each non-final token's end is extended (never shrunk) to the
       next token's begin, closing any gap apply-text-edits opened.
    3. The final token's end is set to new-text-length.
  validate-partition! is invoked at the end as a fail-closed check
  for any case the algorithm doesn't normalize (e.g. defensive
  guard against future cascade-helper changes).

  Throws ex-info if a partitioning layer cannot be made into a valid
  partition by extension (fail-closed)."
  [tx tokens new-text-length]
  (let [by-layer (group-by :token/layer tokens)
        layer-ids (vec (keys by-layer))
        ;; One IN-read for the affected layers' modes (matches v2's
        ;; perf shape: per-query cost dominates, batch ≈ point).
        modes (if (empty? layer-ids)
                {}
                (->> (psc/q tx {:select [:id :overlap_mode]
                                :from :token_layers
                                :where [:in :id layer-ids]})
                     (reduce (fn [m row]
                               (assoc m (:id row)
                                      (or (some-> (:overlap_mode row) keyword) :any)))
                             {})))]
    (doseq [[layer-id layer-tokens] by-layer]
      (when (= :partitioning (clojure.core/get modes layer-id))
        (let [sorted (vec (sort-by :token/begin layer-tokens))
              n (count sorted)
              final
              (vec (map-indexed
                    (fn [i tok]
                      (cond-> tok
                        (zero? i) (assoc :token/begin 0)
                        true (assoc :token/end
                                    (if (= i (dec n))
                                      new-text-length
                                      (max (:token/end tok)
                                           (:token/begin (nth sorted (inc i))))))))
                    sorted))
              ;; Build a [id attrs] seq for the layer, restricted to
              ;; tokens whose coordinates actually changed. Pass as a seq
              ;; (not a map) so bulk-update-by-id! emits audit rows in
              ;; source position order rather than hash order — `sorted`
              ;; is already sorted by [begin end].
              updates (->> (map vector sorted final)
                           (keep (fn [[orig fin]]
                                   (when (not= (select-keys orig [:token/begin :token/end])
                                               (select-keys fin [:token/begin :token/end]))
                                     [(:token/id orig)
                                      {:begin (:token/begin fin)
                                       :end_ (:token/end fin)}])))
                           vec)]
          ;; One CASE-driven UPDATE per partition layer instead of N
          ;; per-row UPDATEs + N SELECTs.
          (when (seq updates)
            (psc/bulk-update-by-id! tx :tokens updates))
          (tc/validate-partition! final new-text-length))))))
