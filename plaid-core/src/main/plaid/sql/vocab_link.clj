(ns plaid.sql.vocab-link
  "Vocab links: the `vocab_links` table, with their tokens in the ordered
  `vocab_link_tokens` junction table (`order_idx` keeps the input order).
  Delete is a single row delete on `vocab_links`, and the FK ON DELETE
  CASCADE sweeps the junction rows."
  (:require [taoensso.timbre :as log]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.cascade-statistics :as cascade-stats]
            [plaid.sql.common :as psc]
            [plaid.sql.crud :as crud]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.sql.metadata :as metadata])
  (:refer-clojure :exclude [get merge format]))

;; NOTE: `:vocab-link/document` is kept in attr-keys (and thus in
;; the REST GET response shape, since `format`/`select-keys` uses
;; attr-keys) even though no existing test asserts on it. It gives REST
;; consumers a stable
;; back-pointer to the owning document without an extra query.
(def attr-keys [:vocab-link/id
                :vocab-link/vocab-item
                :vocab-link/document
                :vocab-link/tokens])

;; ============================================================
;; Row mappers
;; ============================================================

;; NOTE: unlike most row mappers in this codebase (which are 1-arg `row` -> map),
;; this mapper takes a second `tokens` arg because the vocab-link's token list
;; lives in the `vocab_link_tokens` junction table and must be fetched separately
;; via `crud/junction-token-ids`. Folding that fetch into the mapper would require
;; passing `db`/`tx` into what is otherwise pure data shaping — we keep the
;; mapper pure and accept the asymmetry. Callers must pre-fetch tokens.
(defn- row->vocab-link
  [row tokens]
  (when row
    {:vocab-link/id         (:id row)
     :vocab-link/vocab-item (:vocab_item_id row)
     :vocab-link/document   (:document_id row)
     :vocab-link/tokens     (vec tokens)}))

;; ============================================================
;; Public reads
;; ============================================================

(defn format
  "Format a raw vocab-link record (`row->vocab-link` output) for
  external consumption (core attrs + optional :metadata)."
  [db raw]
  (when raw
    (let [core (select-keys raw attr-keys)]
      (metadata/add-metadata-to-response db core "vocab-link" (:vocab-link/id raw)))))

(defn get
  "Look up a vocab-link by id. Returns the formatted (API-shape) map
  or nil."
  [db id]
  (when-let [row (psc/fetch-by-id db :vocab_links id)]
    (let [tokens (crud/junction-token-ids db :vocab_links id)]
      (format db (row->vocab-link row tokens)))))

(defn get-many
  "`{id vocab-link}` for the links `ids` that exist, each as `get` gives it,
  read together."
  [db ids]
  (let [rows (crud/rows-by-id db :vocab_links ids)
        tokens (crud/junction-token-ids-of db :vocab_links (keys rows))]
    (metadata/with-metadata-of db "vocab-link"
      (update-vals rows #(select-keys (row->vocab-link % (clojure.core/get tokens (:id %) [])) attr-keys)))))

(defn get-vocab-layer
  "Return the vocab_layer_id that owns this vocab-link's vocab item."
  [db id]
  (when-let [vl (psc/fetch-by-id db :vocab_links id)]
    (:vocab_layer_id (psc/fetch-by-id db :vocab_items (:vocab_item_id vl)))))

(defn project-id
  "Find the project id for a vocab-link via the document it lives in."
  [db id]
  (when-let [vl (psc/fetch-by-id db :vocab_links id)]
    (:project_id (psc/fetch-by-id db :documents (:document_id vl)))))

(defn project-id-from-token
  "Return the project id that owns the document of `token-id`."
  [db token-id]
  (when-let [t (psc/fetch-by-id db :tokens token-id)]
    (when-let [d (psc/fetch-by-id db :documents (:document_id t))]
      (:project_id d))))

(defn document-id-from-token
  "Return the document id that owns `token-id`."
  [db token-id]
  (when-let [t (psc/fetch-by-id db :tokens token-id)]
    (:document_id t)))

;; ============================================================
;; Internal helpers
;; ============================================================

(defn- fetch-tokens-by-ids
  "Return a vector of token rows matching `token-ids`, preserving the
  input order. Missing ids show up as `nil` slots so the caller can
  detect them."
  [tx token-ids]
  (let [rows (psc/fetch-ids tx :tokens token-ids)
        by-id (into {} (map (juxt :id identity)) rows)]
    (mapv #(clojure.core/get by-id %) token-ids)))

(defn- check-vocab-link-invariants!
  "Validates:
   - vocab-item exists
   - non-empty + every token id resolves
   - all tokens share the same document (fast pre-flight)
   - all tokens share the same text AND the same token-layer
   - the document's project has the vocab-item's vocab_layer in
     project_vocabs"
  [tx vocab-item-id token-ids token-rows]
  (let [vi-row (psc/fetch-by-id tx :vocab_items vocab-item-id)]
    (when (nil? vi-row)
      (throw (ex-info (psc/err-msg-not-found "Vocab item" vocab-item-id)
                      {:code 400 :id vocab-item-id})))
    (when (empty? token-ids)
      (throw (ex-info "Vocab link must reference at least one token"
                      {:code 400})))
    (when-let [missing (some (fn [[tid row]] (when (nil? row) tid))
                             (map vector token-ids token-rows))]
      (throw (ex-info (psc/err-msg-not-found "Token" missing)
                      {:code 400 :id missing})))
    ;; Mirror span/check-tokens!: the PK is (vocab_link_id, order_idx),
    ;; so duplicates are representable but never meaningful — reject.
    (when-not (apply distinct? token-ids)
      (throw (ex-info "Token list contains duplicate IDs."
                      {:ids token-ids :code 400})))
    (let [doc-ids (set (map :document_id token-rows))]
      (when (> (count doc-ids) 1)
        (throw (ex-info "Tokens inside vocab link must all belong to the same document"
                        {:code 400})))
      ;; Same-text + same-token-layer invariants. One SELECT DISTINCT
      ;; covers both — the row count tells us if either axis disagrees,
      ;; and the values let us produce a precise error message.
      (let [distinct-rows (psc/q tx {:select-distinct [:text_id :token_layer_id]
                                     :from [:tokens]
                                     :where [:in :id (vec token-ids)]})]
        (when (> (count distinct-rows) 1)
          (let [text-ids (set (map :text_id distinct-rows))
                tl-ids (set (map :token_layer_id distinct-rows))]
            (cond
              (> (count text-ids) 1)
              (throw (ex-info "Tokens inside vocab link must all belong to the same text"
                              {:code 400 :text-ids text-ids}))
              (> (count tl-ids) 1)
              (throw (ex-info "Tokens inside vocab link must all belong to the same token layer"
                              {:code 400 :token-layer-ids tl-ids}))))))
      (let [doc-id (first doc-ids)
            doc-row (psc/fetch-by-id tx :documents doc-id)
            project-id (:project_id doc-row)
            vocab-layer-id (:vocab_layer_id vi-row)
            link-row (psc/q1 tx {:select [:vocab_layer_id]
                                 :from [:project_vocabs]
                                 :where [:and
                                         [:= :project_id project-id]
                                         [:= :vocab_layer_id vocab-layer-id]]})]
        (when (nil? link-row)
          (throw (ex-info "Cannot create vocab link: project is not linked to the vocab layer"
                          {:code 400
                           :project-id project-id
                           :vocab-layer-id vocab-layer-id})))
        {:doc-id doc-id :project-id project-id}))))

(defn- insert-vocab-link-tokens!
  "Insert the ordered join rows linking `vl-id` to `token-ids`."
  [tx vl-id token-ids]
  (doseq [[idx tid] (map-indexed vector token-ids)]
    (crud/add-join! tx :vocab_link_tokens
                    {:vocab_link_id vl-id
                     :token_id tid
                     :order_idx idx})))

;; ============================================================
;; Create
;; ============================================================

(defn- project-and-doc-from-first-token
  "Read-only helper for op-header building. Resolves the project and
  document the new vocab-link will live in via its first token. Both
  values are validated again inside the tx."
  [db first-token-id]
  (when first-token-id
    (let [t (psc/fetch-by-id db :tokens first-token-id)
          doc-id (:document_id t)
          doc (when doc-id (psc/fetch-by-id db :documents doc-id))]
      {:doc-id doc-id
       :project-id (:project_id doc)})))

(defn- create-vocab-links!
  "The one create path of vocab links, under `create` and `bulk-create`.
  Each of `attrs-vec` requires :vocab-link/vocab-item and
  :vocab-link/tokens (a non-empty vector), and takes :metadata and
  :vocab-link/id (a client's UUIDv7, claimed here) or ::new-id (one the
  server minted for it), else the server mints one. Entries may name
  different vocab items (auto-linking links many tokens to many items at
  once), and every token of the call lies in one document. Each is
  checked by `check-vocab-link-invariants!`.

  Audit shape: ONE audit_writes :insert row per link, its post image the
  inserted row with a `:tokens` key holding the ordered token ids from
  `vocab_link_tokens` and, when it has metadata, a `:metadata` key, so
  replay reconstructs a link from one record.

  Returns the new ids in input order."
  [tx attrs-vec]
  (when (empty? attrs-vec)
    (throw (ex-info "Bulk create requires at least one vocab link" {:code 400})))
  (psc/claim-ids! tx :vocab_links "vocabulary link" (map :vocab-link/id attrs-vec))
  (let [records (mapv
                 (fn [a]
                   (let [vocab-item (:vocab-link/vocab-item a)
                         tokens (:vocab-link/tokens a)
                         token-rows (fetch-tokens-by-ids tx tokens)
                         {:keys [doc-id]} (check-vocab-link-invariants!
                                           tx vocab-item tokens token-rows)]
                     {:id (or (:vocab-link/id a) (::new-id a) (psc/new-uuid))
                      :vocab-item vocab-item
                      :tokens tokens
                      :doc-id doc-id
                      :metadata (:metadata a)}))
                 attrs-vec)
        doc-ids (->> records (map :doc-id) distinct)]
    (when-not (= 1 (count doc-ids))
      (throw (ex-info "Tokens in a bulk vocab-link create must all belong to the same document"
                      {:document-ids doc-ids :code 400})))
    ;; Rows, join rows and metadata unaudited, then one folded :insert each.
    (psc/execute! tx {:insert-into :vocab_links
                      :values (mapv (fn [r]
                                      {:id (:id r)
                                       :vocab_item_id (:vocab-item r)
                                       :document_id (:doc-id r)})
                                    records)})
    (doseq [r records]
      (insert-vocab-link-tokens! tx (:id r) (:tokens r))
      (metadata/insert-metadata! tx "vocab-link" (:id r) (:metadata r)
                                 {:skip-parent-audit? true}))
    (doseq [r records]
      (let [post-row (psc/fetch-by-id tx :vocab_links (:id r))
            post-tokens (crud/junction-token-ids tx :vocab_links (:id r))
            post-image (cond-> (assoc post-row :tokens post-tokens)
                         (seq (:metadata r)) (assoc :metadata (:metadata r)))]
        (psaw/record-audit-write! tx :vocab_links (:id r) :insert nil post-image)))
    (mapv :id records)))

(defn create
  "Create a vocab-link. `attrs` requires :vocab-link/vocab-item and
  :vocab-link/tokens (non-empty vector), and takes :vocab-link/id (a
  client's UUIDv7). `metadata` is a map of key->value. Audit shape as
  `create-vocab-links!`.

  Returns {:success true :extra <new-id>}."
  ([db attrs user-id] (create db attrs user-id nil))
  ([db attrs user-id metadata]
   (let [{:vocab-link/keys [tokens]} attrs
         new-id (or (:vocab-link/id attrs) (psc/new-uuid))
         {:keys [doc-id project-id]} (project-and-doc-from-first-token db (first tokens))]
     (submit-operation!
      [tx db {:type :vocab-link/create
              :project project-id
              :document doc-id
              :description (str "Create vocab mapping " new-id
                                (when (seq metadata)
                                  (str " with " (count metadata) " metadata keys")))
              :user user-id}]
      (first (create-vocab-links! tx [(assoc attrs ::new-id new-id :metadata metadata)]))))))

;; ============================================================
;; Bulk create
;; ============================================================

(defn bulk-create
  "Bulk-create vocab links: `create-vocab-links!` with every entry of
  `attrs-vec`. Returns {:success true :extra [ids]}."
  [db attrs-vec user-id]
  (let [first-token-id (-> attrs-vec first :vocab-link/tokens first)
        {:keys [doc-id project-id]} (project-and-doc-from-first-token db first-token-id)]
    (submit-operation!
     [tx db {:type :vocab-link/bulk-create
             :project project-id
             :document doc-id
             :description (str "Create " (psc/counted (count attrs-vec) "vocab mapping"))
             :user user-id}]
     (create-vocab-links! tx attrs-vec))))

;; ============================================================
;; (No `merge` fn — vocab_link has no mutable scalar fields beyond
;; the junction-table tokens, and the REST API does not expose a
;; PATCH endpoint for it. Token edits go through `set-tokens` /
;; `add-token` / `remove-token`.)
;; ============================================================

;; ============================================================
;; Delete
;; ============================================================

(defn- delete-vocab-links!
  "The one delete path of vocab links, under `delete` and `bulk-delete`,
  for existing link `ids`. The FK ON DELETE CASCADE on
  `vocab_link_tokens.vocab_link_id` removes the join rows, and
  entity_metadata, which has no FK, is swept here."
  [tx ids]
  (cascade-stats/prepare! tx)
  (doseq [eid ids]
    (crud/delete-by-id! tx :vocab_links eid))
  (crud/delete-entity-metadata! tx "vocab-link" ids))

(defn delete
  "Delete a vocab-link (see `delete-vocab-links!`)."
  [db eid user-id]
  (let [pre (psc/fetch-by-id db :vocab_links eid)
        proj (when pre (project-id db eid))
        doc-id (when pre (:document_id pre))]
    (submit-operation!
     [tx db {:type :vocab-link/delete
             :project proj
             :document doc-id
             :description "Delete vocab mapping"
             :user user-id}]
     ;; Re-fetch INSIDE the tx: a concurrent delete between the outer read
     ;; and this tx would otherwise make the delete a silent no-op that
     ;; still committed an operation and bumped the doc version.
     (when (nil? (psc/fetch-by-id tx :vocab_links eid))
       (throw (ex-info (psc/err-msg-not-found "Vocab link" eid)
                       {:code 404 :id eid})))
     (delete-vocab-links! tx [eid])
     eid)))

;; ============================================================
;; Bulk delete
;; ============================================================

(defn bulk-delete
  "Bulk-delete vocab links in a single operation. Ids that don't resolve to
  an existing row are silently dropped (mirrors `span/bulk-delete`). All
  links must belong to a single document (the doc-version OCC covers one
  doc). Returns the vector of ids actually deleted."
  [db eids user-id]
  (let [eids (vec (distinct eids))
        rows (psc/fetch-ids db :vocab_links eids)
        first-row (first rows)
        outer-doc-id (:document_id first-row)
        outer-project (when first-row
                        (:project_id (psc/fetch-by-id db :documents outer-doc-id)))]
    (submit-operation!
     [tx db {:type :vocab-link/bulk-delete
             :project outer-project
             :document outer-doc-id
             :description (str "Delete " (psc/counted (count rows) "vocab mapping"))
             :user user-id}]
     ;; Re-fetch inside the tx so the existence check matches the rows we
     ;; delete (a concurrent delete between the outer read and here is fine).
     (let [rows-tx (psc/fetch-ids tx :vocab_links eids)
           existing-ids (->> rows-tx (keep :id) vec)]
       (when (seq existing-ids)
         (let [doc-ids (->> rows-tx (map :document_id) distinct)]
           (when (> (count doc-ids) 1)
             (throw (ex-info "Tokens in a bulk vocab-link delete must all belong to the same document"
                             {:document-ids doc-ids :code 400}))))
         (delete-vocab-links! tx existing-ids))
       existing-ids))))

;; ============================================================
;; Metadata
;; ============================================================

(def ^:private metadata-fns
  (metadata/metadata-fns {:table :vocab_links
                          :entity-type "vocab-link"
                          :noun "vocab link"
                          :project-fn project-id
                          :doc-id-fn (fn [db eid] (:document_id (psc/fetch-by-id db :vocab_links eid)))}))

(def ^{:doc "Replace all metadata on a vocab-link."
       :arglists '([db eid metadata-map user-id])}
  set-metadata (:set-metadata metadata-fns))

(def ^{:doc "Shallow-merge a metadata patch on a vocab-link: keys present set/overwrite,
  a null value deletes that key, omitted keys are untouched. See
  `plaid.sql.metadata/patch-metadata!`."
       :arglists '([db eid patch user-id])}
  patch-metadata (:patch-metadata metadata-fns))

(def ^{:doc "Remove all metadata from a vocab-link."
       :arglists '([db eid user-id])}
  delete-metadata (:delete-metadata metadata-fns))
