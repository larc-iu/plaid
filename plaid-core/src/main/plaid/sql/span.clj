(ns plaid.sql.span
  "Spans: the `spans` table, with their tokens in the ordered
  `span_tokens` junction table (`order_idx` keeps the input order).

  Cascade-on-delete: relations whose source or target
  span is being deleted are removed explicitly first (audited via
  delete-by-id!) so audit_writes captures them; FK ON DELETE CASCADE
  then sweeps the now-orphaned span_tokens rows."
  (:require [taoensso.timbre :as log]
            [plaid.sql.bulk :as bulk]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.cascade-statistics :as cascade-stats]
            [plaid.sql.common :as psc]
            [plaid.sql.crud :as crud]
            [plaid.sql.operation :refer [submit-operation!]]
            [plaid.sql.metadata :as metadata]
            [plaid.sql.relation :as relation]
            [clojure.string])
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
;; `crud/junction-token-ids`. Folding that fetch into the mapper would require passing
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
    (let [tokens (crud/junction-token-ids db :spans id)]
      (format db (row->span row tokens)))))

(defn get-many
  "`{id span}` for the spans `ids` that exist, each as `get` gives it, read
  together (one query per table per chunk, not per span)."
  [db ids]
  (let [rows (crud/rows-by-id db :spans ids)
        tokens (crud/junction-token-ids-of db :spans (keys rows))]
    (metadata/with-metadata-of db "span"
      (update-vals rows #(select-keys (row->span % (clojure.core/get tokens (:id %) [])) attr-keys)))))

(defn project-id
  "Find the project id for a span. Single-entity lookup via the
  denormalized span_layers.project_id column."
  [db id]
  (when-let [sl-id (:span_layer_id (psc/fetch-by-id db :spans id))]
    (:project_id (psc/fetch-by-id db :span_layers sl-id))))

(defn get-relation-ids
  "Return the IDs of relations whose source or target is `eid`, each end
  read by its own index."
  [db eid]
  (->> (concat (crud/select-in db :relations "id" :source_span_id "idx_relations_source" [eid])
               (crud/select-in db :relations "id" :target_span_id "idx_relations_target" [eid]))
       (map :id)
       distinct
       vec))

;; ============================================================
;; Internal helpers
;; ============================================================

(defn- validate-atomic-value!
  [value]
  (psc/validate-atomic-value! "Span" value))

(defn- fetch-tokens-by-ids
  "Return a vector of token rows matching `token-ids`, preserving the
  input order. Missing ids show up as `nil` slots so the caller can
  detect them."
  [tx token-ids]
  (let [rows (psc/fetch-ids tx :tokens token-ids)
        by-id (into {} (map (juxt :id identity)) rows)]
    (mapv #(clojure.core/get by-id %) token-ids)))

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
    (crud/add-join! tx :span_tokens
                    {:span_id span-id
                     :token_id tid
                     :order_idx idx})))

;; ============================================================
;; Create
;; ============================================================

(defn- check-spans-consistency!
  "The spans of one create share their span layer."
  [spans-attrs]
  (when (empty? spans-attrs)
    (throw (ex-info "Span list is empty" {:code 400})))
  (when-not (= 1 (->> spans-attrs (map :span/layer) distinct count))
    (throw (ex-info "Spans must all belong to the same layer" {:code 400}))))

(defn- create-spans!
  "The one create path of spans, under `create` and `bulk-create`. Each
  of `attrs-vec` requires :span/layer (one for all of them) and
  :span/tokens (a non-empty vector), and takes :span/value, :metadata and
  :span/id (a client's UUIDv7, claimed here) or ::new-id (one the server
  minted for it), else the server mints one. Every span lies in one
  document.

  Audit shape: ONE audit_writes :insert row per span, its post image the
  inserted row with a `:tokens` key holding the ordered token ids from
  `span_tokens` and, when it has metadata, a `:metadata` key. The rows,
  join rows and metadata go in unaudited first: `crud/insert-many!`
  would audit a bare row with no tokens, and the history replayer takes
  an :insert as the whole entity.

  Returns the new ids in input order."
  [tx attrs-vec]
  (check-spans-consistency! attrs-vec)
  (doseq [a attrs-vec]
    (validate-atomic-value! (:span/value a)))
  (psc/claim-ids! tx :spans "span" (map :span/id attrs-vec))
  (let [layer-id (-> attrs-vec first :span/layer)
        ;; One fetch of every referenced token.
        token-rows (psc/fetch-ids tx :tokens (->> attrs-vec (mapcat :span/tokens) distinct vec))
        token-by-id (into {} (map (juxt :id identity)) token-rows)
        records (mapv
                 (fn [a]
                   (let [tokens (:span/tokens a)
                         rows (mapv #(clojure.core/get token-by-id %) tokens)]
                     (check-tokens! tx layer-id tokens rows)
                     {:id (or (:span/id a) (::new-id a) (psc/new-uuid))
                      :tokens tokens
                      :doc-id (:document_id (first rows))
                      :value (:span/value a)
                      :metadata (:metadata a)}))
                 attrs-vec)
        doc-ids (->> records (map :doc-id) distinct)]
    (when-not (= 1 (count doc-ids))
      (throw (ex-info "Not all spans belong to the same document"
                      {:document-ids doc-ids :code 400})))
    (psc/execute! tx {:insert-into :spans
                      :values (mapv (fn [r]
                                      {:id (:id r)
                                       :span_layer_id layer-id
                                       :document_id (:doc-id r)
                                       :value (psc/write-json (:value r))})
                                    records)})
    (doseq [r records]
      (insert-span-tokens! tx (:id r) (:tokens r))
      (metadata/insert-metadata! tx "span" (:id r) (:metadata r)
                                 {:skip-parent-audit? true}))
    (doseq [r records]
      (let [post-row (psc/fetch-by-id tx :spans (:id r))
            post-tokens (crud/junction-token-ids tx :spans (:id r))
            post-image (cond-> (assoc post-row :tokens post-tokens)
                         (seq (:metadata r)) (assoc :metadata (:metadata r)))]
        (psaw/record-audit-write! tx :spans (:id r) :insert nil post-image)))
    (mapv :id records)))

(defn create
  "Create a span. `attrs` requires :span/layer and :span/tokens
  (non-empty vector); `:span/value` and `:span/id` (a client's UUIDv7)
  are optional. `metadata` is a map of key->value. Audit shape as
  `create-spans!`.

  Returns {:success true :extra <new-id>}."
  ([db attrs user-id] (create db attrs user-id nil))
  ([db attrs user-id metadata]
   (let [{:span/keys [layer tokens]} attrs
         new-id (or (:span/id attrs) (psc/new-uuid))]
     (submit-operation!
      [tx db {:type :span/create
              :project (when layer
                         (:project_id (psc/fetch-by-id db :span_layers layer)))
              :document (when-let [t (first tokens)]
                          (:document_id (psc/fetch-by-id db :tokens t)))
              :description (str "Create span " new-id " with " (psc/counted (count tokens) "token")
                                " in layer " layer)
              :user user-id}]
      (first (create-spans! tx [(assoc attrs ::new-id new-id :metadata metadata)]))))))

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
         (crud/update-by-id! tx :spans eid attrs))
       eid))))

;; ============================================================
;; Delete
;; ============================================================

(defn delete-spans!
  "The one delete path of spans, under `delete`, `bulk-delete`, a span
  layer's cascade and the layer rule remedies, for span `ids`. The
  relations on them go first, audited (`relation/delete-relations!`),
  since the FK CASCADE on relations would sweep them unaudited, each end
  read by its own index, then the spans (the FK CASCADE on span_tokens
  sweeps the join rows) with their entity_metadata, which has no FK. Each
  span's delete cascades, so the statistics are made safe for that first
  (`cascade-stats/prepare!`). Returns the deleted spans' pre-images."
  [tx ids]
  (cascade-stats/prepare! tx)
  (let [ids (vec (distinct ids))]
    (relation/delete-relations!
     tx (->> (concat
              (crud/select-in tx :relations "id" :source_span_id "idx_relations_source" ids)
              (crud/select-in tx :relations "id" :target_span_id "idx_relations_target" ids))
             (map :id)
             distinct
             vec))
    (crud/delete-entities! tx :spans ids)))

(defn delete
  "Delete a span and the relations on it (see `delete-spans!`)."
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
     (delete-spans! tx [eid])
     eid)))

;; ============================================================
;; Metadata
;; ============================================================

(def ^:private metadata-fns
  (metadata/metadata-fns {:table :spans
                          :entity-type "span"
                          :noun "span"
                          :project-fn project-id
                          :doc-id-fn (fn [db eid] (:document_id (psc/fetch-by-id db :spans eid)))}))

(def ^{:doc "Replace all metadata on a span."
       :arglists '([db eid metadata-map user-id])}
  set-metadata (:set-metadata metadata-fns))

(def ^{:doc "Shallow-merge a metadata patch on a span: keys present set/overwrite,
  a null value deletes that key, omitted keys are untouched. See
  `plaid.sql.metadata/patch-metadata!`."
       :arglists '([db eid patch user-id])}
  patch-metadata (:patch-metadata metadata-fns))

(def ^{:doc "Remove all metadata from a span."
       :arglists '([db eid user-id])}
  delete-metadata (:delete-metadata metadata-fns))

(defn get-doc-id-of-token
  "Return the document id that owns `token-id`."
  [db token-id]
  (:document_id (psc/fetch-by-id db :tokens token-id)))

;; ============================================================
;; Bulk update
;; ============================================================

(def bulk-update-spec
  "The `plaid.sql.bulk/bulk-update!` spec for spans."
  {:table :spans
   :entity-type "span"
   :layer-table :span_layers
   :layer-key :span_layer_id
   :op-type :span/bulk-update
   :noun "span"
   :values? true})

(defn bulk-update
  "Update the value of, and/or patch the metadata on, many spans in ONE
  operation. See `plaid.sql.bulk/bulk-update!` for the contract."
  [db items user-id]
  (bulk/bulk-update! db items user-id bulk-update-spec))

;; ============================================================
;; Bulk create
;; ============================================================

(defn bulk-create
  "Bulk-create spans: `create-spans!` with every entry of `attrs-vec`.
  Returns {:success true :extra <ids>}."
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
             :description (str "Create " (psc/counted (count attrs-vec) "span") " in layer " layer-id)
             :user user-id}]
     (create-spans! tx attrs-vec))))

;; ============================================================
;; Bulk delete
;; ============================================================

(defn bulk-delete
  "Bulk-delete spans. For each span, referencing relations are deleted
  first (audited), then the span (FK CASCADE sweeps span_tokens), then
  entity_metadata. Mirrors the cascade ordering in
  plaid.sql.token/multi-delete!.

  Ids that don't resolve to an existing span row are silently dropped.
  Returns the vector of ids actually deleted, which
  excludes any unknown ids the caller passed in. Without this filter,
  unknown ids would flow through `crud/delete-by-id!` and produce phantom
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
             :description (str "Delete " (psc/counted (count eids) "span"))
             :user user-id}]
     ;; Re-fetch inside the tx so the existence check is consistent
     ;; with the rows we then delete. Filter the caller's eids down to
     ;; ids that actually exist; unknown ids are dropped silently and
     ;; never reach crud/delete-by-id! (which would otherwise audit a
     ;; phantom :delete with pre = nil).
     (let [span-rows-tx (psc/fetch-ids tx :spans eids)
           existing-ids (->> span-rows-tx (keep :id) vec)]
       (when (seq existing-ids)
         (let [;; Pre-flight document consistency.
               doc-ids (->> span-rows-tx (map :document_id) distinct)]
           (when (> (count doc-ids) 1)
             (throw (ex-info "Not all spans belong to the same document"
                             {:document-ids doc-ids :code 400}))))
         (delete-spans! tx existing-ids))
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
                               " to " (psc/counted (count new-token-ids) "token"))
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
       (psaw/ensure-recorded! tx :spans [eid])
       (let [pre-tokens (crud/junction-token-ids tx :spans eid)]
         (psc/execute! tx {:delete-from :span_tokens
                           :where [:= :span_id eid]})
         (insert-span-tokens! tx eid new-token-ids)
         (let [post-tokens (crud/junction-token-ids tx :spans eid)
               pre-image (assoc span-row :tokens pre-tokens)
               post-image (assoc span-row :tokens post-tokens)]
           (psaw/record-audit-write! tx :spans eid :update pre-image post-image)))
       eid))))
