(ns plaid.sql.document
  "SQL port of plaid.xtdb2.document. Documents live in the `documents`
  table. Optimistic concurrency uses the explicit `version` INTEGER
  column (replacing v2's :xt/system-from probe). `time-created` /
  `time-modified` come from `created_at` / `modified_at` columns.

  Public API mirrors the xtdb2 surface."
  (:require [clojure.data.json :as json]
            [taoensso.timbre :as log]
            [plaid.sql.common :as psc]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.sql.metadata :as metadata]
            [plaid.sql.token-layer :as token-layer]
            [plaid.media.storage :as media])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:document/id
                :document/name
                :document/time-created
                :document/time-modified
                :document/version
                :document/project])

;; ============================================================
;; Row mapper
;; ============================================================

(defn- row->document
  "Translate a `documents` row (snake_case keys) to the namespaced
  shape. Returns nil on nil input."
  [row]
  (when row
    {:document/id            (:id row)
     :document/name          (:name row)
     :document/project       (:project_id row)
     :document/version       (:version row)
     :document/time-created  (:created_at row)
     :document/time-modified (:modified_at row)}))

;; ============================================================
;; Reads
;; ============================================================

(defn get
  "Get a document by ID, formatted for external consumption.
  Attaches :document/media-url when a media file is present, and
  :metadata when entity_metadata has rows for the document."
  [db id]
  (when-let [doc (row->document (psc/fetch-by-id db :documents id))]
    (let [with-media (cond-> doc
                       (media/media-exists? id)
                       (assoc :document/media-url (str "/api/v1/documents/" id "/media")))]
      (metadata/add-metadata-to-response db with-media "document" id))))

(defn project-id
  "Look up the project ID for a given document. Used by metadata + REST
  middleware. Returns nil if the doc doesn't exist."
  [db id]
  (:project_id (psc/fetch-by-id db :documents id)))

(defn get-text-layers
  "Return text-layer ID stubs for the document's project. Mirrors v2's
  `get-text-layers` shape: a vector of `{:text-layer/id <id>}` maps."
  [db id]
  (let [doc (psc/fetch-by-id db :documents id)
        prj-id (:project_id doc)]
    (if prj-id
      (->> (psc/q db {:select [:id]
                      :from [:text_layers]
                      :where [:= :project_id prj-id]
                      :order-by [:order_idx]})
           (mapv (fn [r] {:text-layer/id (:id r)})))
      [])))

(defn get-text-ids
  "Return the IDs of all texts belonging to this document."
  [db eid]
  (->> (psc/q db {:select [:id]
                  :from [:texts]
                  :where [:= :document_id eid]})
       (mapv :id)))

;; ============================================================
;; Deep read: get-with-layer-data
;;
;; Mirrors the recursive get-doc-info multimethod in
;; plaid.xtdb2.document. The result is document + text-layers →
;; token-layers → span-layers → relation-layers within the document's
;; project, with the document-scoped rows (texts, tokens, spans,
;; relations, vocab-links) attached under each layer.
;;
;; PERF (Task #52, 2026-05-27): rewrites the previous recursive
;; per-layer / per-row walker to a small fixed set of batched queries
;; (~11 round trips regardless of layer count / row count), with a
;; single bulk entity_metadata fetch keyed on entity_id. The previous
;; shape ran O(layers × kinds) layer SELECTs plus an entity_metadata
;; SELECT per row, which was the 1m+ latency the SQL port was created
;; to fix. The result map is intentionally shape-identical to the old
;; recursive walker — the REST consumers depend on the exact key set.
;;
;; SQLite-specific note: span/vocab-link token-id arrays are aggregated
;; with `json_group_array(token_id ORDER BY order_idx)` then decoded
;; Clojure-side. Postgres would use `json_agg(token_id ORDER BY
;; order_idx)` (or `array_agg(...)`); portability is deferred for
;; this task.
;; ============================================================

(defn- decode-token-id-array
  "Parse the JSON array string produced by `json_group_array(token_id ORDER BY ...)`.
  SQLite returns the raw JSON string; we parse to a vector. The
  values inside are TEXT-encoded UUIDs (this layer pre-stores UUIDs
  as TEXT — see plaid.sql.common/coerce-id-cols); coerce each back
  to java.util.UUID to match the row-shape produced by the
  single-id read path (e.g. `(:token_id row)` over span_tokens)."
  [s]
  (when (some? s)
    (mapv psc/->uuid (json/read-str s))))

(defn- bulk-metadata-by-entity
  "Bulk-fetch entity_metadata for the given entity-ids and return a
  `{[entity-type entity-id] {key value}}` map. One query (chunked)
  replaces the per-row `metadata/get-metadata` calls the old walker
  issued. The entity_metadata PK is (entity_type, entity_id, key) so
  partitioning by [entity-type entity-id] keeps lookups unambiguous
  even when the same id happens to be reused under different types."
  [db entity-ids]
  (if (empty? entity-ids)
    {}
    (let [ids (vec (distinct entity-ids))
          chunks (partition-all 4000 ids)
          rows (into []
                     (mapcat (fn [chunk]
                               (psc/q db {:select [:entity_type :entity_id :key :value]
                                          :from [:entity_metadata]
                                          :where [:in :entity_id (vec chunk)]})))
                     chunks)]
      (reduce (fn [acc r]
                (let [k [(:entity_type r) (:entity_id r)]
                      v (try
                          ;; metadata values are JSON-encoded; keep
                          ;; nested keys as STRINGS to match v2 round-tripping
                          ;; (see metadata/decode-value).
                          (json/read-str (:value r))
                          (catch Exception _ (:value r)))]
                  (update acc k (fnil assoc {}) (:key r) v)))
              {} rows))))

(defn- attach-meta
  "Mirror of `metadata/add-metadata-to-response`, but reads from a
  precomputed metadata-index produced by `bulk-metadata-by-entity`.
  Pure (no DB hit)."
  [meta-idx entity-type entity-id m]
  (let [meta-map (clojure.core/get meta-idx [entity-type entity-id])]
    (if (seq meta-map)
      (assoc m :metadata meta-map)
      m)))

(defn get-with-layer-data
  "Deep document read: document + text-layers + token-layers + spans +
  relations + vocabs. Result shape is exactly the v2 shape so the same
  REST tests pass against either backend.

  Implementation: ~11 batched queries (vs the previous walker's
  O(layers × kinds + rows) round trips). Token-id arrays for spans
  and vocab-links are aggregated via SQLite `json_group_array` then
  parsed Clojure-side. The layer tree is built in-Clojure from flat
  rows grouped by parent-id."
  [db id]
  (when-let [doc (get db id)]
    (let [prj-id (:document/project doc)
          ;; --- 1. Layer skeleton (4 queries, keyed off project_id). ---
          text-layer-rows (if (nil? prj-id)
                            []
                            (psc/q db {:select [:*]
                                       :from [:text_layers]
                                       :where [:= :project_id prj-id]
                                       :order-by [:order_idx]}))
          tl-ids (mapv :id text-layer-rows)
          token-layer-rows (if (empty? tl-ids)
                             []
                             (psc/q db {:select [:*]
                                        :from [:token_layers]
                                        :where [:in :text_layer_id tl-ids]
                                        :order-by [:order_idx]}))
          tokl-ids (mapv :id token-layer-rows)
          span-layer-rows (if (empty? tokl-ids)
                            []
                            (psc/q db {:select [:*]
                                       :from [:span_layers]
                                       :where [:in :token_layer_id tokl-ids]
                                       :order-by [:order_idx]}))
          sl-ids (mapv :id span-layer-rows)
          relation-layer-rows (if (empty? sl-ids)
                                []
                                (psc/q db {:select [:*]
                                           :from [:relation_layers]
                                           :where [:in :span_layer_id sl-ids]
                                           :order-by [:order_idx]}))
          ;; --- 2. All texts for this doc (typically 1 per text-layer). ---
          text-rows (if (empty? tl-ids)
                      []
                      (psc/q db {:select [:id :body :document_id :text_layer_id]
                                 :from [:texts]
                                 :where [:and
                                         [:= :document_id id]
                                         [:in :text_layer_id tl-ids]]}))
          ;; --- 3. All tokens for this doc — one query, group Clojure-side. ---
          ;; ORDER BY: the canonical token order is (begin, precedence, end, id)
          ;; with precedence NULLS LAST — precedence OUTRANKS extent (task #101,
          ;; revised 2026-06-02 to match the query engine; see
          ;; plaid.sql.query.compile). The post-group sort via
          ;; `sort-token-records` preserves this order (its keys are a prefix of
          ;; the SQL key).
          token-rows (psc/q db {:select [:*]
                                :from [:tokens]
                                :where [:= :document_id id]
                                :order-by [[:begin :asc]
                                           [:precedence :asc-nulls-last]
                                           [:end_ :asc]
                                           [:id :asc]]})
          ;; --- 4. All spans + their ordered token-id arrays, one query.
          ;; LEFT JOIN + FILTER keeps spans with no span_tokens rows
          ;; (json_group_array of zero rows would be the literal "[null]"
          ;; without the FILTER). Postgres would write
          ;;   array_agg(st.token_id ORDER BY st.order_idx)
          ;;     FILTER (WHERE st.token_id IS NOT NULL)
          ;; (or json_agg(...)). ---
          ;; ORDER BY s.id: deterministic ordering so the OLTP↔history
          ;; parity test doesn't rely on coincidental row order matching
          ;; across SQLite and XTDB v2 (neither guarantees one without
          ;; an explicit ORDER BY).
          span-rows (psc/q db ["SELECT s.id, s.span_layer_id, s.document_id, s.value,
                                       json_group_array(st.token_id ORDER BY st.order_idx)
                                         FILTER (WHERE st.token_id IS NOT NULL)
                                         AS token_ids
                                  FROM spans s
                                  LEFT JOIN span_tokens st ON st.span_id = s.id
                                  WHERE s.document_id = ?
                                  GROUP BY s.id
                                  ORDER BY s.id"
                               id])
          ;; --- 5. All relations for this doc. ---
          relation-rows (psc/q db {:select [:*]
                                   :from [:relations]
                                   :where [:= :document_id id]
                                   :order-by [:id]})
          ;; --- 6. Vocab links scoped to this doc + their token arrays,
          ;; one query. Same Postgres-shape note as above. ---
          vl-rows (psc/q db ["SELECT vl.id, vl.vocab_item_id, vl.document_id,
                                     json_group_array(vlt.token_id ORDER BY vlt.order_idx)
                                       FILTER (WHERE vlt.token_id IS NOT NULL)
                                       AS token_ids
                                FROM vocab_links vl
                                LEFT JOIN vocab_link_tokens vlt
                                       ON vlt.vocab_link_id = vl.id
                                WHERE vl.document_id = ?
                                GROUP BY vl.id"
                             id])
          ;; --- 7. Vocab item / vocab layer / maintainers hydration. ---
          vi-ids (->> vl-rows (map :vocab_item_id) distinct vec)
          vi-rows (if (empty? vi-ids)
                    []
                    (psc/q db {:select [:*]
                               :from [:vocab_items]
                               :where [:in :id vi-ids]}))
          vlayer-ids (->> vi-rows (map :vocab_layer_id) distinct vec)
          vlayer-rows (if (empty? vlayer-ids)
                        []
                        (psc/q db {:select [:*]
                                   :from [:vocab_layers]
                                   :where [:in :id vlayer-ids]}))
          ;; ORDER BY user_id so the per-vlayer maintainers list
          ;; (`maintainers-by-vlayer` appends in row order) is
          ;; deterministically ordered and matches the history read ordering
          ;; — without it OLTP↔history parity diverges run-to-run (task #13).
          vm-rows (if (empty? vlayer-ids)
                    []
                    (psc/q db {:select [:vocab_layer_id :user_id]
                               :from [:vocab_maintainers]
                               :where [:in :vocab_layer_id vlayer-ids]
                               :order-by [:user_id]}))
          ;; --- 8. Bulk entity_metadata for every entity in this doc:
          ;; document + texts + tokens + spans + relations + vocab-links + vocab-items.
          ;; (vocab-item ids may span all docs but the entity_metadata PK
          ;; includes entity_type so the filter `entity_id IN (...)` is safe.) ---
          meta-ids (-> []
                       (into [id])
                       (into (map :id) text-rows)
                       (into (map :id) token-rows)
                       (into (map :id) span-rows)
                       (into (map :id) relation-rows)
                       (into (map :id) vl-rows)
                       (into (map :id) vi-rows))
          meta-idx (bulk-metadata-by-entity db meta-ids)
          ;; --- Grouping helpers (no further DB hits below). ---
          token-rows-by-layer (group-by :token_layer_id token-rows)
          span-rows-by-layer (group-by :span_layer_id span-rows)
          rel-rows-by-layer (group-by :relation_layer_id relation-rows)
          token-id->layer (into {} (map (juxt :id :token_layer_id)) token-rows)
          ;; vocab-links attach to the TOKEN-LAYER they touch (v2 contract).
          ;; A link spanning multiple token-layers appears under each.
          vl-token-ids (into {}
                             (map (fn [r]
                                    [(:id r) (decode-token-id-array (:token_ids r))]))
                             vl-rows)
          vl->token-layers (reduce (fn [acc [vl-id tok-ids]]
                                     (assoc acc vl-id
                                            (->> tok-ids
                                                 (map token-id->layer)
                                                 (remove nil?)
                                                 distinct
                                                 vec)))
                                   {} vl-token-ids)
          vi-by-id (into {} (map (juxt :id identity)) vi-rows)
          vlayer-by-id (into {} (map (juxt :id identity)) vlayer-rows)
          maintainers-by-vlayer (reduce (fn [acc r]
                                          (update acc (:vocab_layer_id r)
                                                  (fnil conj []) (:user_id r)))
                                        {} vm-rows)
          relation-layers-by-span-layer (group-by :span_layer_id relation-layer-rows)
          span-layers-by-token-layer (group-by :token_layer_id span-layer-rows)
          token-layers-by-text-layer (group-by :text_layer_id token-layer-rows)
          text-by-text-layer (into {} (map (juxt :text_layer_id identity)) text-rows)
          links-by-token-layer (reduce (fn [acc [vl-id tlids]]
                                         (reduce (fn [a tlid]
                                                   (update a tlid (fnil conj []) vl-id))
                                                 acc tlids))
                                       {} vl->token-layers)
          vl-by-id (into {} (map (juxt :id identity)) vl-rows)
          ;; --- Builders (all pure functions over the maps above). ---
          build-token (fn [r]
                        (attach-meta meta-idx "token" (:id r)
                                     {:token/id (:id r)
                                      :token/document (:document_id r)
                                      :token/text (:text_id r)
                                      :token/begin (:begin r)
                                      :token/end (:end_ r)
                                      :token/precedence (:precedence r)}))
          build-span (fn [r]
                       (attach-meta meta-idx "span" (:id r)
                                    {:span/id (:id r)
                                     :span/document (:document_id r)
                                     :span/value (psc/read-json (:value r))
                                     :span/tokens (or (decode-token-id-array (:token_ids r))
                                                      [])}))
          build-relation (fn [r]
                           (attach-meta meta-idx "relation" (:id r)
                                        {:relation/id (:id r)
                                         :relation/document (:document_id r)
                                         :relation/source (:source_span_id r)
                                         :relation/target (:target_span_id r)
                                         :relation/value (psc/read-json (:value r))}))
          build-vocab-item (fn [vi-id]
                             (when-let [row (vi-by-id vi-id)]
                               (attach-meta meta-idx "vocab-item" vi-id
                                            {:vocab-item/id vi-id
                                             :vocab-item/layer (:vocab_layer_id row)
                                             :vocab-item/form (:form row)})))
          build-link (fn [vl-id]
                       (let [row (vl-by-id vl-id)
                             tok-vec (or (decode-token-id-array (:token_ids row)) [])
                             base {:vocab-link/id vl-id
                                   :vocab-link/vocab-item (build-vocab-item
                                                           (:vocab_item_id row))
                                   :vocab-link/tokens tok-vec}]
                         (attach-meta meta-idx "vocab-link" vl-id base)))
          build-vocabs-for-token-layer
          (fn [tl-id]
            (let [vl-ids (clojure.core/get links-by-token-layer tl-id [])
                  links (mapv build-link vl-ids)
                  ;; Group these links by their vocab-layer (via the
                  ;; vocab_item they point to).
                  links-by-vlayer (group-by (fn [l]
                                              (:vocab-item/layer
                                               (:vocab-link/vocab-item l)))
                                            links)]
              (->> links-by-vlayer
                   (keep (fn [[vlayer-id ls]]
                           (when-let [row (vlayer-by-id vlayer-id)]
                             {:vocab/id vlayer-id
                              :vocab/name (:name row)
                              :vocab/maintainers (vec (clojure.core/get
                                                       maintainers-by-vlayer
                                                       vlayer-id []))
                              :config (psc/parse-config (:config row))
                              :vocab-layer/vocab-links ls})))
                   vec)))
          build-relation-layer
          (fn [rl-row]
            (let [rels (->> (clojure.core/get rel-rows-by-layer (:id rl-row) [])
                            (mapv build-relation))]
              {:relation-layer/id (:id rl-row)
               :relation-layer/name (:name rl-row)
               :config (psc/parse-config (:config rl-row))
               :relation-layer/relations rels}))
          build-span-layer
          (fn [sl-row]
            (let [spans (->> (clojure.core/get span-rows-by-layer (:id sl-row) [])
                             (mapv build-span))
                  rls (->> (clojure.core/get relation-layers-by-span-layer
                                             (:id sl-row) [])
                           (sort-by :order_idx)
                           (mapv build-relation-layer))]
              {:span-layer/id (:id sl-row)
               :span-layer/name (:name sl-row)
               :config (psc/parse-config (:config sl-row))
               :span-layer/spans spans
               :span-layer/relation-layers rls}))
          build-token-layer
          (fn [tl-row]
            (let [raw-tokens (->> (clojure.core/get token-rows-by-layer
                                                    (:id tl-row) [])
                                  (mapv build-token))
                  tokens (vec (token-layer/sort-token-records raw-tokens))
                  sls (->> (clojure.core/get span-layers-by-token-layer
                                             (:id tl-row) [])
                           (sort-by :order_idx)
                           (mapv build-span-layer))
                  vocabs (build-vocabs-for-token-layer (:id tl-row))]
              {:token-layer/id (:id tl-row)
               :token-layer/name (:name tl-row)
               :config (psc/parse-config (:config tl-row))
               :token-layer/overlap-mode (some-> (:overlap_mode tl-row) keyword)
               :token-layer/parent-token-layer (:parent_token_layer_id tl-row)
               :token-layer/tokens tokens
               :token-layer/span-layers sls
               :token-layer/vocabs vocabs}))
          build-text-layer
          (fn [txtl-row]
            (let [text-row (text-by-text-layer (:id txtl-row))
                  text (when text-row
                         (attach-meta meta-idx "text" (:id text-row)
                                      {:text/id (:id text-row)
                                       :text/document (:document_id text-row)
                                       :text/body (:body text-row)}))
                  tls (->> (clojure.core/get token-layers-by-text-layer
                                             (:id txtl-row) [])
                           (sort-by :order_idx)
                           (mapv build-token-layer))]
              {:text-layer/id (:id txtl-row)
               :text-layer/name (:name txtl-row)
               :config (psc/parse-config (:config txtl-row))
               :text-layer/text text
               :text-layer/token-layers tls}))]
      (assoc doc :document/text-layers (mapv build-text-layer text-layer-rows)))))

;; ============================================================
;; Writes
;; ============================================================

(defn create
  "Create a new document.

  attrs must include :document/name and :document/project. Optional
  metadata-map maps key->value for entity_metadata population.

  Returns {:success true :extra <new-id>} on success."
  ([db attrs user-id]
   (create db attrs user-id nil))
  ([db attrs user-id metadata-map]
   (let [{:document/keys [name project]} attrs
         new-id (psc/new-uuid)
         now (psc/now-iso)]
     (submit-operation! [tx db {:type :document/create
                                :project project
                                :document new-id
                                :description (str "Create document \"" name "\" in project " project
                                                  (when metadata-map
                                                    (str " with " (count metadata-map) " metadata keys")))
                                :user user-id
                                ;; Body INSERTs at version=1; skip the post-body bump
                                ;; (otherwise fresh documents would start at v2 and the
                                ;; first audit row would be the version-update, not the
                                ;; INSERT).
                                :skip-doc-version-bump? true}]
                        ;; Validation inside the body (task #47) so a bad
                        ;; name produces {:success false :code 400} via the
                        ;; outer catch in submit-operation*.
                        (psc/valid-name? name)
                        (when (nil? (psc/fetch-by-id tx :projects project))
                          (throw (ex-info (psc/err-msg-not-found "Project" project)
                                          {:id project :code 400})))
                        (psc/insert! tx :documents
                                     {:id new-id
                                      :name name
                                      :project_id project
                                      :version 1
                                      :created_at now
                                      :modified_at now})
                        (when (seq metadata-map)
                          (metadata/insert-metadata! tx "document" new-id metadata-map))
                        new-id))))

(defn merge
  "Update mutable document fields. Currently supports :document/name.
  Always bumps `version` and `modified_at`."
  [db eid m user-id]
  (submit-operation! [tx db {:type :document/update
                             :project (project-id db eid)
                             :document eid
                             :description (str "Update document " eid
                                               (when (:document/name m)
                                                 (str " name to \"" (:document/name m) "\"")))
                             :user user-id
                             ;; Body itself sets `:version (inc version)`; skip the
                             ;; post-body bump so we don't double-increment and don't
                             ;; emit a duplicate audit row over the body's update.
                             :skip-doc-version-bump? true}]
                     (when-let [n (:document/name m)]
                       (psc/valid-name? n))
                     (let [existing (psc/fetch-by-id tx :documents eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Document" eid) {:code 404 :id eid})))
                       (let [attrs (cond-> {:modified_at (psc/now-iso)
                                            :version (inc (or (:version existing) 1))}
                                     (some? (:document/name m))
                                     (assoc :name (:document/name m)))]
                         (psc/update-by-id! tx :documents eid attrs)
                         eid))))

(defn cascade-delete!
  "Tx-level cascade for a document. Walks texts/tokens (via
  token/multi-delete!, which audits spans/relations/vocab_links), then
  sweeps any remaining spans/relations/vocab_links scoped to the
  document (defensive — `multi-delete!` only catches entities whose
  ENTIRE token list lives under the deleted set). Finally cleans up
  entity_metadata for the document and its texts and drops the row."
  [tx eid]
  (let [text-ids (->> (psc/q tx {:select [:id]
                                 :from :texts
                                 :where [:= :document_id eid]})
                      (mapv :id))
        multi-delete! (requiring-resolve 'plaid.sql.token/multi-delete!)]
    (doseq [text-id text-ids]
      (let [tok-ids (->> (psc/q tx {:select [:id]
                                    :from :tokens
                                    :where [:= :text_id text-id]})
                         (mapv :id))]
        (when (seq tok-ids)
          (multi-delete! tx tok-ids)))
      (psc/delete-by-id! tx :texts text-id))
    (when (seq text-ids)
      (psc/execute! tx
                    {:delete-from :entity_metadata
                     :where [:and
                             [:= :entity_type "text"]
                             [:in :entity_id text-ids]]})))
  ;; Defensive sweep: any spans/relations/vocab_links left attached to
  ;; the document but not removed via the token cascade (orphans the
  ;; partition-spans-by-deletion split can't see because their token
  ;; lists were already empty).
  (let [rel-ids (->> (psc/q tx {:select [:id]
                                :from :relations
                                :where [:= :document_id eid]})
                     (mapv :id))]
    (doseq [rid rel-ids]
      (psc/delete-by-id! tx :relations rid))
    (when (seq rel-ids)
      (psc/execute! tx
                    {:delete-from :entity_metadata
                     :where [:and
                             [:= :entity_type "relation"]
                             [:in :entity_id rel-ids]]})))
  (let [span-ids (->> (psc/q tx {:select [:id]
                                 :from :spans
                                 :where [:= :document_id eid]})
                      (mapv :id))]
    (doseq [sid span-ids]
      (psc/delete-by-id! tx :spans sid))
    (when (seq span-ids)
      (psc/execute! tx
                    {:delete-from :entity_metadata
                     :where [:and
                             [:= :entity_type "span"]
                             [:in :entity_id span-ids]]})))
  (let [vl-ids (->> (psc/q tx {:select [:id]
                               :from :vocab_links
                               :where [:= :document_id eid]})
                    (mapv :id))]
    (doseq [vlid vl-ids]
      (psc/delete-by-id! tx :vocab_links vlid))
    (when (seq vl-ids)
      (psc/execute! tx
                    {:delete-from :entity_metadata
                     :where [:and
                             [:= :entity_type "vocab-link"]
                             [:in :entity_id vl-ids]]})))
  ;; Document's own metadata + row.
  (metadata/delete-metadata! tx "document" eid)
  (psc/delete-by-id! tx :documents eid))

(defn delete
  "Delete a document. Walks the descendant subtree (texts/tokens via
  token/multi-delete!, then any orphan spans/relations/vocab_links
  still attached to the doc by document_id) and audits each row
  deletion through the audited helpers — FK ON DELETE CASCADE would
  otherwise silently sweep them. Also deletes the on-disk media file
  (if any) after a successful tx commit."
  [db eid user-id]
  (let [prj-id (project-id db eid)
        result (submit-operation! [tx db {:type :document/delete
                                          :project prj-id
                                          :document eid
                                          :description (str "Delete document " eid)
                                          :user user-id
                                          :skip-doc-version-bump? true}]
                                  (let [existing (psc/fetch-by-id tx :documents eid)]
                                    (when (nil? existing)
                                      (throw (ex-info (psc/err-msg-not-found "Document" eid)
                                                      {:code 404 :id eid})))
                                    (cascade-delete! tx eid)
                                    eid))]
    (when (and (:success result) (media/media-exists? eid))
      (try
        (media/delete-media-file! eid)
        (catch Exception e
          (log/warn e "Failed to delete media file for" eid))))
    result))

;; ============================================================
;; Metadata
;; ============================================================

(defn set-metadata
  "Replace all metadata on the document with metadata-map."
  [db eid metadata-map user-id]
  (submit-operation! [tx db {:type :document/set-metadata
                             :project (project-id db eid)
                             :document eid
                             :description (str "Set metadata on document " eid
                                               " with " (count metadata-map) " keys")
                             :user user-id}]
                     (metadata/validate-entity-type! "document")
                     (when (nil? (psc/fetch-by-id tx :documents eid))
                       (throw (ex-info (psc/err-msg-not-found "Document" eid) {:code 404 :id eid})))
                     (metadata/replace-metadata! tx "document" eid metadata-map)
                     eid))

(defn patch-metadata
  "Shallow-merge a metadata patch on the document: keys present set/overwrite,
  a null value deletes that key, omitted keys are untouched. See
  `plaid.sql.metadata/patch-metadata!`."
  [db eid patch user-id]
  (submit-operation! [tx db {:type :document/patch-metadata
                             :project (project-id db eid)
                             :document eid
                             :description (str "Patch metadata on document " eid
                                               " with " (count patch) " keys")
                             :user user-id}]
                     (metadata/validate-entity-type! "document")
                     (when (nil? (psc/fetch-by-id tx :documents eid))
                       (throw (ex-info (psc/err-msg-not-found "Document" eid) {:code 404 :id eid})))
                     (metadata/patch-metadata! tx "document" eid patch)
                     eid))

(defn delete-metadata
  "Remove all metadata for the document."
  [db eid user-id]
  (submit-operation! [tx db {:type :document/delete-metadata
                             :project (project-id db eid)
                             :document eid
                             :description (str "Delete all metadata from document " eid)
                             :user user-id}]
                     (metadata/validate-entity-type! "document")
                     (when (nil? (psc/fetch-by-id tx :documents eid))
                       (throw (ex-info (psc/err-msg-not-found "Document" eid) {:code 404 :id eid})))
                     (metadata/delete-metadata! tx "document" eid)
                     eid))
