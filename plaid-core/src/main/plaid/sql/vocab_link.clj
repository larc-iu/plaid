(ns plaid.sql.vocab-link
  "SQL port of plaid.xtdb2.vocab-link. Vocab links live in the
  `vocab_links` table; their token references live in the ordered
  `vocab_link_tokens` junction table with `order_idx` preserving the
  input order.

  External API mirrors xtdb2 (same fn names + arglists). `db` replaces
  `node-or-map`. Delete is a single row delete on `vocab_links` — the
  FK ON DELETE CASCADE sweeps the junction rows."
  (:require [taoensso.timbre :as log]
            [plaid.sql.common :as psc]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.sql.metadata :as metadata])
  (:refer-clojure :exclude [get merge format]))

;; NOTE (#70): `:vocab-link/document` is kept in attr-keys (and thus in
;; the REST GET response shape, since `format`/`select-keys` uses
;; attr-keys) even though no existing test asserts on it. Keeping it
;; matches the v2 attr-key set and gives REST consumers a stable
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
;; via `fetch-token-ids`. Folding that fetch into the mapper would require
;; passing `db`/`tx` into what is otherwise pure data shaping — we keep the
;; mapper pure and accept the asymmetry. Callers must pre-fetch tokens.
(defn- row->vocab-link
  [row tokens]
  (when row
    {:vocab-link/id         (:id row)
     :vocab-link/vocab-item (:vocab_item_id row)
     :vocab-link/document   (:document_id row)
     :vocab-link/tokens     (vec tokens)}))

(defn- fetch-token-ids
  "Return the ordered (by order_idx) token-id vector for `vl-id`."
  [db vl-id]
  (->> (psc/q db {:select [:token_id]
                  :from [:vocab_link_tokens]
                  :where [:= :vocab_link_id vl-id]
                  :order-by [:order_idx]})
       (mapv :token_id)))

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
    (let [tokens (fetch-token-ids db id)]
      (format db (row->vocab-link row tokens)))))

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
     (mirrors the v2 invariants in plaid.xtdb2.vocab-link/create*)
   - the document's project has the vocab-item's vocab_layer in
     project_vocabs"
  [tx vocab-item-id token-ids token-rows]
  (let [vi-row (psc/fetch-by-id tx :vocab_items vocab-item-id)]
    (when (nil? vi-row)
      (throw (ex-info (psc/err-msg-not-found "Vocab item" vocab-item-id)
                      {:code 400 :id vocab-item-id})))
    (when (or (empty? token-ids)
              (not (every? some? token-rows)))
      (throw (ex-info "Vocab link must reference at least one token"
                      {:code 400})))
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
    (psc/add-join! tx :vocab_link_tokens
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

(defn create
  "Create a vocab-link. `attrs` requires :vocab-link/vocab-item and
  :vocab-link/tokens (non-empty vector). `metadata` is a map of
  key->value inserted into entity_metadata when provided.

  Audit shape: ONE audit_writes row against `:vocab_links` with
  change_type :insert. pre = nil; post = the inserted vocab_link row
  augmented with a `:tokens` key holding the ordered token-id vector
  from `vocab_link_tokens`, AND (when `metadata` is non-empty) a
  `:metadata` key carrying the inserted metadata map. Same
  synthetic-audit pattern as `span/create` — folds junction state +
  metadata into the parent row's image so ETL replay reconstructs the
  link with its tokens (and metadata) from one record, avoiding the
  noisy :insert + :update pair (task #59).

  Returns {:success true :extra <new-id>}."
  ([db attrs user-id] (create db attrs user-id nil))
  ([db attrs user-id metadata]
   (let [{:vocab-link/keys [vocab-item tokens]} attrs
         new-id (psc/new-uuid)
         {:keys [doc-id project-id]} (project-and-doc-from-first-token db (first tokens))]
     (submit-operation!
      [tx db {:type :vocab-link/create
              :project project-id
              :document doc-id
              :description (str "Create vocab mapping"
                                (when metadata
                                  (str " with " (count metadata) " metadata keys")))
              :user user-id}]
      (when (psc/fetch-by-id tx :vocab_links new-id)
        (throw (ex-info (psc/err-msg-already-exists "Vocab link" new-id)
                        {:id new-id :code 409})))
      (let [token-rows (fetch-tokens-by-ids tx tokens)
            {:keys [doc-id]} (check-vocab-link-invariants!
                              tx vocab-item tokens token-rows)]
        ;; Manual insert + audit (vs. psc/insert!) so the post-image
        ;; carries the junction-table tokens — see docstring.
        (psc/execute! tx {:insert-into :vocab_links
                          :values [{:id new-id
                                    :vocab_item_id vocab-item
                                    :document_id doc-id}]})
        (insert-vocab-link-tokens! tx new-id tokens)
        ;; Insert metadata BEFORE the audit emission, with the
        ;; skip-parent-audit? flag so no separate :update row fires;
        ;; we then fold :metadata into our manual :insert audit's
        ;; post_image (task #59).
        (when (seq metadata)
          (metadata/insert-metadata! tx "vocab-link" new-id metadata
                                     {:skip-parent-audit? true}))
        (let [post-row (psc/fetch-by-id tx :vocab_links new-id)
              post-tokens (fetch-token-ids tx new-id)
              post-image (cond-> (assoc post-row :tokens post-tokens)
                           (seq metadata) (assoc :metadata metadata))]
          (psc/record-audit-write! tx :vocab_links new-id :insert nil post-image))
        new-id)))))

;; ============================================================
;; (No `merge` fn — vocab_link has no mutable scalar fields beyond
;; the junction-table tokens, and the REST API does not expose a
;; PATCH endpoint for it. Token edits go through `set-tokens` /
;; `add-token` / `remove-token`.)
;; ============================================================

;; ============================================================
;; Delete
;; ============================================================

(defn delete
  "Delete a vocab-link. The FK ON DELETE CASCADE on
  `vocab_link_tokens.vocab_link_id` removes the junction rows."
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
     (when (nil? pre)
       (throw (ex-info (psc/err-msg-not-found "Vocab link" eid)
                       {:code 404 :id eid})))
     (psc/delete-by-id! tx :vocab_links eid)
     (psc/execute! tx
                   {:delete-from :entity_metadata
                    :where [:and
                            [:= :entity_type "vocab-link"]
                            [:= :entity_id eid]]})
     eid)))

;; ============================================================
;; Metadata
;; ============================================================

(defn set-metadata
  "Replace all metadata on a vocab-link."
  [db eid metadata-map user-id]
  (metadata/validate-entity-type! "vocab-link")
  (submit-operation!
   [tx db {:type :vocab-link/set-metadata
           :project (project-id db eid)
           :document (:document_id (psc/fetch-by-id db :vocab_links eid))
           :description (str "Set metadata on vocab link " eid
                             " with " (count metadata-map) " keys")
           :user user-id}]
   (when (nil? (psc/fetch-by-id tx :vocab_links eid))
     (throw (ex-info (psc/err-msg-not-found "Vocab link" eid)
                     {:code 404 :id eid})))
   (metadata/replace-metadata! tx "vocab-link" eid metadata-map)
   eid))

(defn patch-metadata
  "Shallow-merge a metadata patch on a vocab-link: keys present set/overwrite,
  a null value deletes that key, omitted keys are untouched. See
  `plaid.sql.metadata/patch-metadata!`."
  [db eid patch user-id]
  (metadata/validate-entity-type! "vocab-link")
  (submit-operation!
   [tx db {:type :vocab-link/patch-metadata
           :project (project-id db eid)
           :document (:document_id (psc/fetch-by-id db :vocab_links eid))
           :description (str "Patch metadata on vocab link " eid
                             " with " (count patch) " keys")
           :user user-id}]
   (when (nil? (psc/fetch-by-id tx :vocab_links eid))
     (throw (ex-info (psc/err-msg-not-found "Vocab link" eid)
                     {:code 404 :id eid})))
   (metadata/patch-metadata! tx "vocab-link" eid patch)
   eid))

(defn delete-metadata
  "Remove all metadata from a vocab-link."
  [db eid user-id]
  (metadata/validate-entity-type! "vocab-link")
  (submit-operation!
   [tx db {:type :vocab-link/delete-metadata
           :project (project-id db eid)
           :document (:document_id (psc/fetch-by-id db :vocab_links eid))
           :description (str "Delete all metadata from vocab link " eid)
           :user user-id}]
   (when (nil? (psc/fetch-by-id tx :vocab_links eid))
     (throw (ex-info (psc/err-msg-not-found "Vocab link" eid)
                     {:code 404 :id eid})))
   (metadata/delete-metadata! tx "vocab-link" eid)
   eid))
