(ns plaid.sql.span
  "SQL port of plaid.xtdb2.span. Spans live in the `spans` table; their
  token references live in the ordered `span_tokens` junction table,
  with `order_idx` preserving the input order.

  External API mirrors xtdb2 (same fn names + arglists). `db` replaces
  `node-or-map`. Cascade-on-delete: relations whose source or target
  span is being deleted are removed explicitly first (audited via
  delete-by-id!) so audit_writes captures them; FK ON DELETE CASCADE
  then sweeps the now-orphaned span_tokens rows."
  (:require [taoensso.timbre :as log]
            [plaid.sql.common :as psc]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.sql.metadata :as metadata])
  (:refer-clojure :exclude [get merge format]))

(def attr-keys [:span/id
                :span/layer
                :span/document
                :span/value
                :span/tokens])

;; ============================================================
;; Row mappers
;; ============================================================

;; NOTE: unlike most row mappers in this codebase (which are 1-arg `row` -> map),
;; this mapper takes a second `tokens` arg because the span's token list lives
;; in the `span_tokens` junction table and must be fetched separately via
;; `fetch-token-ids`. Folding that fetch into the mapper would require passing
;; `db`/`tx` into what is otherwise pure data shaping — we keep the mapper pure
;; and accept the asymmetry. Callers must pre-fetch tokens.
(defn- row->span
  [row tokens]
  (when row
    {:span/id       (:id row)
     :span/layer    (:span_layer_id row)
     :span/document (:document_id row)
     :span/value    (psc/read-json (:value row))
     :span/tokens   (vec tokens)}))

(defn- fetch-token-ids
  "Return the ordered (by order_idx) token-id vector for `span-id`."
  [db span-id]
  (->> (psc/q db {:select [:token_id]
                  :from [:span_tokens]
                  :where [:= :span_id span-id]
                  :order-by [:order_idx]})
       (mapv :token_id)))

;; ============================================================
;; Public reads
;; ============================================================

(defn format
  "Format a raw span row (`row` from `spans`) plus its ordered tokens
  for external consumption. `raw` should already be a row->span result."
  [db raw]
  (when raw
    (let [core (select-keys raw attr-keys)]
      (metadata/add-metadata-to-response db core "span" (:span/id raw)))))

(defn get
  "Look up a span by id. Returns the formatted (API-shape) map or nil."
  [db id]
  (when-let [row (psc/fetch-by-id db :spans id)]
    (let [tokens (fetch-token-ids db id)]
      (format db (row->span row tokens)))))

(defn project-id
  "Find the project id for a span. Single-entity lookup via the
  denormalized span_layers.project_id column."
  [db id]
  (when-let [sl-id (:span_layer_id (psc/fetch-by-id db :spans id))]
    (:project_id (psc/fetch-by-id db :span_layers sl-id))))

(defn get-relation-ids
  "Return the IDs of relations whose source or target is `eid`."
  [db eid]
  (->> (psc/q db {:select-distinct [:id]
                  :from [:relations]
                  :where [:or
                          [:= :source_span_id eid]
                          [:= :target_span_id eid]]})
       (mapv :id)))

;; ============================================================
;; Internal helpers
;; ============================================================

(defn- validate-atomic-value!
  [value]
  (when-not (or (nil? value) (string? value) (number? value) (boolean? value))
    (throw (ex-info "Span value must be atomic (string, number, boolean, or null)"
                    {:value value :code 400}))))

(defn- fetch-tokens-by-ids
  "Return a vector of token rows matching `token-ids`, preserving the
  input order. Missing ids show up as `nil` slots so the caller can
  detect them."
  [tx token-ids]
  (let [rows (psc/fetch-ids tx :tokens token-ids)
        by-id (into {} (map (juxt :id identity)) rows)]
    (mapv #(clojure.core/get by-id %) token-ids)))

(defn- span-layer-token-layer-id
  "Return the :token_layer_id (parent) of the given span layer."
  [tx span-layer-id]
  (:token_layer_id (psc/fetch-by-id tx :span_layers span-layer-id)))

(defn- check-tokens!
  "Schema check used by create + bulk-create.

  Validates:
   - non-empty token list
   - span layer exists
   - every token id resolves
   - all tokens share the same token_layer_id
   - that shared token layer matches the span layer's parent token layer
   - all tokens share the same document_id"
  [tx span-layer-id token-ids token-rows]
  (cond
    (empty? token-ids)
    (throw (ex-info "Token list is empty or malformed" {:code 400}))

    ;; The schema PK is (span_id, order_idx), not (span_id, token_id),
    ;; so duplicates are representable — but they're never meaningful,
    ;; they inflate ETL images, and reparent-junction!'s dedup semantics
    ;; on merge are order-dependent over duplicate rows. Reject.
    (not (apply distinct? token-ids))
    (throw (ex-info "Token list contains duplicate IDs."
                    {:ids token-ids :code 400}))

    (not (every? some? token-rows))
    (throw (ex-info "Not all token IDs are valid." {:ids token-ids :code 400})))
  (let [layer-row (psc/fetch-by-id tx :span_layers span-layer-id)]
    (when (nil? layer-row)
      (throw (ex-info (psc/err-msg-not-found "Span layer" span-layer-id)
                      {:id span-layer-id :code 400})))
    (let [token-layer-ids (set (map :token_layer_id token-rows))
          doc-ids (set (map :document_id token-rows))]
      (when (> (count token-layer-ids) 1)
        (throw (ex-info "Not all token IDs belong to the same layer."
                        {:layer-ids token-layer-ids :code 400})))
      (let [tokl-id (first token-layer-ids)]
        (when-not (= tokl-id (:token_layer_id layer-row))
          (throw (ex-info (str "Token layer " tokl-id
                               " is not linked to span layer " span-layer-id)
                          {:token-layer-id tokl-id
                           :span-layer-id span-layer-id
                           :code 400}))))
      (when (> (count doc-ids) 1)
        (throw (ex-info "Not all token IDs belong to the same document."
                        {:code 400}))))))

(defn- insert-span-tokens!
  "Insert the ordered join rows linking `span-id` to `token-ids`."
  [tx span-id token-ids]
  (doseq [[idx tid] (map-indexed vector token-ids)]
    (psc/add-join! tx :span_tokens
                   {:span_id span-id
                    :token_id tid
                    :order_idx idx})))

;; ============================================================
;; Create
;; ============================================================

(defn create
  "Create a span. `attrs` requires :span/layer and :span/tokens
  (non-empty vector); `:span/value` is optional. `metadata` is a map of
  key->value inserted into entity_metadata when provided.

  Audit shape: ONE audit_writes row against `:spans` with change_type
  :insert. pre = nil; post = the inserted span row augmented with a
  `:tokens` key holding the ordered token-id vector from `span_tokens`,
  AND (when `metadata` is non-empty) a `:metadata` key carrying the
  inserted metadata map. Folding both into the same :insert row avoids
  the noisy :insert + :update pair we'd otherwise emit when metadata is
  present (task #59).

  Returns {:success true :extra <new-id>}."
  ([db attrs user-id] (create db attrs user-id nil))
  ([db attrs user-id metadata]
   (let [{:span/keys [layer tokens value]} attrs
         new-id (psc/new-uuid)]
     (submit-operation!
      [tx db {:type :span/create
              :project (when layer
                         (:project_id (psc/fetch-by-id db :span_layers layer)))
              :document (when-let [t (first tokens)]
                          (:document_id (psc/fetch-by-id db :tokens t)))
              :description (str "Create span with " (count tokens)
                                " tokens in layer " layer)
              :user user-id}]
      ;; Validation inside the body (task #47).
      (validate-atomic-value! value)
      (when (psc/fetch-by-id tx :spans new-id)
        (throw (ex-info (psc/err-msg-already-exists "Span" new-id)
                        {:id new-id :code 409})))
      (let [token-rows (fetch-tokens-by-ids tx tokens)
            _ (check-tokens! tx layer tokens token-rows)
            doc-id (:document_id (first token-rows))]
        ;; Manual insert + audit (vs. psc/insert!) so the post-image we
        ;; emit carries the junction-table tokens. Otherwise the audit
        ;; row would only show {id, span_layer_id, document_id, value}
        ;; and ETL replay would produce a span with no tokens.
        (psc/execute! tx {:insert-into :spans
                          :values [{:id new-id
                                    :span_layer_id layer
                                    :document_id doc-id
                                    :value (psc/write-json value)}]})
        (insert-span-tokens! tx new-id tokens)
        ;; Insert metadata BEFORE the audit emission, with the
        ;; skip-parent-audit? flag so no separate :update row fires;
        ;; we then fold :metadata into our manual :insert audit's
        ;; post_image (task #59).
        (when (seq metadata)
          (metadata/insert-metadata! tx "span" new-id metadata
                                     {:skip-parent-audit? true}))
        (let [post-row (psc/fetch-by-id tx :spans new-id)
              post-tokens (fetch-token-ids tx new-id)
              post-image (cond-> (assoc post-row :tokens post-tokens)
                           (seq metadata) (assoc :metadata metadata))]
          (psc/record-audit-write! tx :spans new-id :insert nil post-image))
        new-id)))))

;; ============================================================
;; Merge (update mutable attrs)
;; ============================================================

(defn merge
  "Update mutable span fields. Currently supports :span/value."
  [db eid m user-id]
  (submit-operation!
   [tx db {:type :span/update-attributes
           :project (project-id db eid)
           :document (:document_id (psc/fetch-by-id db :spans eid))
           :description (str "Update attributes of span " eid)
           :user user-id}]
   (when (contains? m :span/value)
     (validate-atomic-value! (:span/value m)))
   (let [existing (psc/fetch-by-id tx :spans eid)]
     (when (nil? existing)
       (throw (ex-info (psc/err-msg-not-found "Span" eid) {:code 404 :id eid})))
     (let [attrs (cond-> {}
                   (contains? m :span/value)
                   (assoc :value (psc/write-json (:span/value m))))]
       (when (seq attrs)
         (psc/update-by-id! tx :spans eid attrs))
       eid))))

;; ============================================================
;; Delete
;; ============================================================

(defn delete
  "Delete a span. Relations that reference this span (source or target)
  are deleted FIRST (audited via psc/delete-by-id!) so the audit log
  captures them — the FK ON DELETE CASCADE on relations would otherwise
  silently sweep them. The span_tokens FK CASCADE cleans up the
  junction rows."
  [db eid user-id]
  (let [pre (psc/fetch-by-id db :spans eid)]
    (submit-operation!
     [tx db {:type :span/delete
             :project (project-id db eid)
             :document (:document_id pre)
             :description (str "Delete span " eid " and its "
                               (count (get-relation-ids db eid))
                               " relations")
             :user user-id}]
     (when (nil? (psc/fetch-by-id tx :spans eid))
       (throw (ex-info (psc/err-msg-not-found "Span" eid) {:code 404 :id eid})))
     (let [rel-ids (get-relation-ids tx eid)]
       (doseq [rid rel-ids]
         (psc/delete-by-id! tx :relations rid))
       (psc/delete-by-id! tx :spans eid)
       ;; Clean up entity_metadata rows (no FK; doesn't auto-cascade).
       (psc/execute! tx
                     {:delete-from :entity_metadata
                      :where [:and
                              [:= :entity_type "span"]
                              [:= :entity_id eid]]})
       eid))))

;; ============================================================
;; Metadata
;; ============================================================

(defn set-metadata
  "Replace all metadata on a span."
  [db eid metadata-map user-id]
  (submit-operation!
   [tx db {:type :span/set-metadata
           :project (project-id db eid)
           :document (:document_id (psc/fetch-by-id db :spans eid))
           :description (str "Set metadata on span " eid
                             " with " (count metadata-map) " keys")
           :user user-id}]
   (metadata/validate-entity-type! "span")
   (when (nil? (psc/fetch-by-id tx :spans eid))
     (throw (ex-info (psc/err-msg-not-found "Span" eid) {:code 404 :id eid})))
   (metadata/replace-metadata! tx "span" eid metadata-map)
   eid))

(defn patch-metadata
  "Shallow-merge a metadata patch on a span: keys present set/overwrite,
  a null value deletes that key, omitted keys are untouched. See
  `plaid.sql.metadata/patch-metadata!`."
  [db eid patch user-id]
  (submit-operation!
   [tx db {:type :span/patch-metadata
           :project (project-id db eid)
           :document (:document_id (psc/fetch-by-id db :spans eid))
           :description (str "Patch metadata on span " eid
                             " with " (count patch) " keys")
           :user user-id}]
   (metadata/validate-entity-type! "span")
   (when (nil? (psc/fetch-by-id tx :spans eid))
     (throw (ex-info (psc/err-msg-not-found "Span" eid) {:code 404 :id eid})))
   (metadata/patch-metadata! tx "span" eid patch)
   eid))

(defn delete-metadata
  "Remove all metadata from a span."
  [db eid user-id]
  (submit-operation!
   [tx db {:type :span/delete-metadata
           :project (project-id db eid)
           :document (:document_id (psc/fetch-by-id db :spans eid))
           :description (str "Delete all metadata from span " eid)
           :user user-id}]
   (metadata/validate-entity-type! "span")
   (when (nil? (psc/fetch-by-id tx :spans eid))
     (throw (ex-info (psc/err-msg-not-found "Span" eid) {:code 404 :id eid})))
   (metadata/delete-metadata! tx "span" eid)
   eid))

(defn get-doc-id-of-token
  "Return the document id that owns `token-id`."
  [db token-id]
  (:document_id (psc/fetch-by-id db :tokens token-id)))

;; ============================================================
;; Bulk create
;; ============================================================

(defn- check-spans-consistency!
  "All spans in a bulk-create must target the same span layer (v2 contract)."
  [spans-attrs]
  (when (empty? spans-attrs)
    (throw (ex-info "Span list is empty" {:code 400})))
  (when-not (= 1 (->> spans-attrs (map :span/layer) distinct count))
    (throw (ex-info "Spans must all belong to the same layer" {:code 400}))))

(defn bulk-create
  "Bulk-create spans. All entries in `attrs-vec` must share the same
  :span/layer. Each entry requires :span/tokens (non-empty vector) and
  optionally :span/value and :metadata. Returns {:success true :extra <ids>}."
  [db attrs-vec user-id]
  (let [layer-id (-> attrs-vec first :span/layer)
        ;; Resolve doc-id outside the tx for the operation header.
        ;; Defensive against malformed input (first attrs entry missing tokens).
        first-token-id (-> attrs-vec first :span/tokens first)
        outer-doc-id (when first-token-id (get-doc-id-of-token db first-token-id))]
    (submit-operation!
     [tx db {:type :span/bulk-create
             :project (when layer-id
                        (:project_id (psc/fetch-by-id db :span_layers layer-id)))
             :document outer-doc-id
             :description (str "Bulk create " (count attrs-vec) " spans in layer " layer-id)
             :user user-id}]
     ;; Validation runs inside the tx so submit-operation* can catch
     ;; ExceptionInfo and surface a structured 4xx response.
     (check-spans-consistency! attrs-vec)
     (doseq [a attrs-vec]
       (validate-atomic-value! (:span/value a)))
     (let [layer-row (psc/fetch-by-id tx :span_layers layer-id)]
       (when (nil? layer-row)
         (throw (ex-info (psc/err-msg-not-found "Span layer" layer-id)
                         {:id layer-id :code 400}))))
     (let [;; One bulk fetch of every referenced token.
           all-token-ids (->> attrs-vec (mapcat :span/tokens) distinct vec)
           token-rows (psc/fetch-ids tx :tokens all-token-ids)
           token-by-id (into {} (map (juxt :id identity)) token-rows)
           ;; Per-span validation lifted from `check-tokens!` but using the
           ;; shared cache. Builds the records to insert at the same time.
           records (mapv
                    (fn [a]
                      (let [tokens (:span/tokens a)
                            token-rows-for-span (mapv #(clojure.core/get token-by-id %) tokens)
                            new-id (psc/new-uuid)]
                        (check-tokens! tx layer-id tokens token-rows-for-span)
                        {:id new-id
                         :tokens tokens
                         :doc-id (:document_id (first token-rows-for-span))
                         :value (:span/value a)
                         :metadata (:metadata a)}))
                    attrs-vec)
           ;; All spans in the batch must belong to a single document (v2 contract).
           doc-ids (->> records (map :doc-id) distinct)]
       (when-not (= 1 (count doc-ids))
         (throw (ex-info "Not all spans belong to the same document"
                         {:document-ids doc-ids :code 400})))
       ;; Insert all span rows. We deliberately do NOT use
       ;; `psc/insert-many!` here: that helper emits a bare :insert audit
       ;; row per span (no :tokens). Because the history replayer treats an
       ;; :insert as a full put (replace), a bulk-created span that is
       ;; never subsequently updated would land in the history with NO
       ;; tokens even though `span_tokens` has them. Instead we insert the
       ;; rows + join rows + metadata silently and then emit ONE synthetic
       ;; :insert per span whose post_image folds :tokens (and :metadata
       ;; when present) — matching single-row `create` (task #4/#59).
       (psc/execute! tx {:insert-into :spans
                         :values (mapv (fn [r]
                                         {:id (:id r)
                                          :span_layer_id layer-id
                                          :document_id (:doc-id r)
                                          :value (psc/write-json (:value r))})
                                       records)})
       ;; Insert all span_tokens rows (unaudited join rows).
       (doseq [r records]
         (insert-span-tokens! tx (:id r) (:tokens r)))
       ;; Metadata, with skip-parent-audit? so no separate :update row
       ;; fires; we fold :metadata into the synthetic :insert below.
       (doseq [r records]
         (when (seq (:metadata r))
           (metadata/insert-metadata! tx "span" (:id r) (:metadata r)
                                      {:skip-parent-audit? true})))
       ;; Emit one synthetic :insert per span with the full image.
       (doseq [r records]
         (let [post-row (psc/fetch-by-id tx :spans (:id r))
               post-tokens (fetch-token-ids tx (:id r))
               post-image (cond-> (assoc post-row :tokens post-tokens)
                            (seq (:metadata r)) (assoc :metadata (:metadata r)))]
           (psc/record-audit-write! tx :spans (:id r) :insert nil post-image)))
       (mapv :id records)))))

;; ============================================================
;; Bulk delete
;; ============================================================

(defn bulk-delete
  "Bulk-delete spans. For each span, referencing relations are deleted
  first (audited), then the span (FK CASCADE sweeps span_tokens), then
  entity_metadata. Mirrors the cascade ordering in
  plaid.sql.token/multi-delete!.

  Ids that don't resolve to an existing span row are silently dropped
  (mirrors v2's `(filter :span/id (vals span-map))` filter in
  `bulk-delete*`). Returns the vector of ids actually deleted, which
  excludes any unknown ids the caller passed in. Without this filter,
  unknown ids would flow through `psc/delete-by-id!` and produce phantom
  audit rows with `pre = nil`."
  [db eids user-id]
  (let [eids (vec (distinct eids))
        span-rows (psc/fetch-ids db :spans eids)
        first-row (first span-rows)
        outer-doc-id (:document_id first-row)
        outer-project (when first-row
                        (:project_id (psc/fetch-by-id db :span_layers
                                                      (:span_layer_id first-row))))]
    (submit-operation!
     [tx db {:type :span/bulk-delete
             :project outer-project
             :document outer-doc-id
             :description (str "Bulk delete " (count eids) " spans")
             :user user-id}]
     ;; Re-fetch inside the tx so the existence check is consistent
     ;; with the rows we then delete. Filter the caller's eids down to
     ;; ids that actually exist; unknown ids are dropped silently and
     ;; never reach psc/delete-by-id! (which would otherwise audit a
     ;; phantom :delete with pre = nil).
     (let [span-rows-tx (psc/fetch-ids tx :spans eids)
           existing-ids (->> span-rows-tx (keep :id) vec)]
       (when (seq existing-ids)
         (let [;; Pre-flight document consistency (v2 contract).
               doc-ids (->> span-rows-tx (map :document_id) distinct)]
           (when (> (count doc-ids) 1)
             (throw (ex-info "Not all spans belong to the same document"
                             {:document-ids doc-ids :code 400}))))
         ;; Relations referencing any of these spans, audited individually.
         (let [rel-ids (->> (psc/q tx {:select-distinct [:id]
                                       :from [:relations]
                                       :where [:or
                                               [:in :source_span_id existing-ids]
                                               [:in :target_span_id existing-ids]]})
                            (mapv :id))]
           (doseq [rid rel-ids]
             (psc/delete-by-id! tx :relations rid)))
         ;; Spans themselves. FK CASCADE on span_tokens sweeps the join rows.
         (doseq [sid existing-ids]
           (psc/delete-by-id! tx :spans sid))
         ;; entity_metadata (no FK, manual sweep).
         (psc/execute! tx
                       {:delete-from :entity_metadata
                        :where [:and
                                [:= :entity_type "span"]
                                [:in :entity_id existing-ids]]}))
       existing-ids))))

;; ============================================================
;; Set tokens
;; ============================================================

(defn set-tokens
  "Replace the ordered token list on a span. New tokens are validated
  for existence, document sharing, and token-layer linkage exactly like
  `create`. Replacement is DELETE-then-INSERT inside the operation tx,
  so it is atomic.

  The `span_tokens` join-table churn itself is not audited row-by-row.
  Instead we emit a single audit_writes row against `:spans` for this
  span id whose pre/post images are the span row augmented with a
  `:tokens` key holding the ordered token-id vector before/after the
  swap. That gives replay everything it needs to reconstruct the new
  join state from one audit row that conceptually represents the change."
  [db eid new-token-ids user-id]
  (let [pre (psc/fetch-by-id db :spans eid)]
    (submit-operation!
     [tx db {:type :span/update-tokens
             :project (project-id db eid)
             :document (:document_id pre)
             :description (str "Update tokens of span " eid
                               " to " (count new-token-ids) " tokens")
             :user user-id}]
     (let [span-row (psc/fetch-by-id tx :spans eid)
           _ (when (nil? span-row)
               (throw (ex-info (psc/err-msg-not-found "Span" eid) {:code 404 :id eid})))
           layer-id (:span_layer_id span-row)
           span-doc-id (:document_id span-row)
           token-rows (fetch-tokens-by-ids tx new-token-ids)]
       (check-tokens! tx layer-id new-token-ids token-rows)
       ;; Cross-document guard: even though check-tokens! enforces a
       ;; single document among the new tokens, that document must also
       ;; match the span's existing document.
       (let [new-doc-id (:document_id (first token-rows))]
         (when (and new-doc-id (not= new-doc-id span-doc-id))
           (throw (ex-info "New tokens belong to a different document than the span."
                           {:span-document span-doc-id
                            :token-document new-doc-id
                            :code 400}))))
       ;; Snapshot the pre-image ordered token list, then swap the join
       ;; rows. We emit one synthetic audit_writes row against :spans
       ;; (pre/post images carry the token vector) instead of auditing
       ;; each junction-row delete/insert — see docstring.
       (let [pre-tokens (fetch-token-ids tx eid)]
         (psc/execute! tx {:delete-from :span_tokens
                           :where [:= :span_id eid]})
         (insert-span-tokens! tx eid new-token-ids)
         (let [post-tokens (fetch-token-ids tx eid)
               pre-image (assoc span-row :tokens pre-tokens)
               post-image (assoc span-row :tokens post-tokens)]
           (psc/record-audit-write! tx :spans eid :update pre-image post-image)))
       eid))))
