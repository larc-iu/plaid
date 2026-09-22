(ns plaid.history.read
  "Time-travel document reads served DIRECTLY from the audit log.

  Replaces the XTDB history replica (see the xtdb-removal plan,
  2026-06-11): every audit_writes row carries a full post-image of the
  row it touched (RETURNING *), `operations.ts` is strictly monotonic
  and audit rows inherit it, so `(ts, seq)` totally orders the log and
  the state of any entity at time T is the key-merge of its post-images
  at-or-before T (absent after a `delete`). No replica, no replication
  lag, no staleness — a read is always served from the same database
  the write committed to.

  Scoping:
   - document-scoped entities (texts/tokens/spans/relations/vocab_links
     + the documents row itself) via the denormalized
     `audit_writes.document_id` (stamped from the row's own image, so
     cascade rows under NULL-document ops are included);
   - layer tables are reconstructed WHOLESALE at T and filtered by
     project — layers are low-cardinality by design (hundreds of audit
     rows total), so this is cheap and avoids a second denormalized
     scoping column;
   - vocab items/layers by target id (only the ones the doc's links
     reference).

  Batch atomicity: OLTP batches are all-or-nothing, and their sub-ops'
  timestamps are CONTIGUOUS (the batch holds the single-writer lock for
  its whole duration). A T that lands strictly inside a batch is
  clamped to just before the batch began, so as-of reads can never
  observe an intermediate state OLTP never exposed.

  Result shapes are the contract of `plaid.sql.document/get` /
  `get-with-layer-data` — REST consumers and the parity test depend on
  the exact key set."
  (:require [clojure.data.json :as json]
            [clojure.string :as str]
            [plaid.media.storage :as media]
            [plaid.sql.common :as psc]
            [plaid.sql.document-rows :as drows])
  (:import (java.time Instant ZonedDateTime)
           (java.util Date))
  (:refer-clojure :exclude [get]))

;; ============================================================
;; Timestamp handling
;; ============================================================

(defn ->ts-iso
  "Coerce a caller-supplied `ts` (Instant, ISO-8601 string, Date, or
  ZonedDateTime) to the canonical fixed-width ISO string used by
  `operations.ts` / `audit_writes.ts`, so lexicographic comparison is
  temporal comparison."
  ^String [ts]
  (psc/instant->iso
   (cond
     (instance? Instant ts) ts
     (string? ts) (Instant/parse ts)
     (instance? Date ts) (.toInstant ^Date ts)
     (instance? ZonedDateTime ts) (.toInstant ^ZonedDateTime ts)
     :else (throw (ex-info (str "Cannot coerce to a timestamp: "
                                (if (nil? ts) "nil" (.getName (class ts))))
                           {:type :history/invalid-timestamp :value ts})))))

;; ============================================================
;; Retention gate
;; ============================================================

(defn- check-retention!
  "Audit rows below the `audit_retention` marker have been pruned —
  reconstruction at or before that point would silently produce partial
  documents. Refuse with a typed error the REST layer maps to a
  structured 4xx. (No prune code exists yet; this honors the contract
  installed with the marker table.)"
  [db ts-iso]
  (when-let [marker (:pruned_below_ts
                     (psc/q1 db {:select [:pruned_below_ts]
                                 :from [:audit_retention]
                                 :where [:= :id 1]}))]
    (when (neg? (compare ts-iso (str marker)))
      (throw (ex-info "as-of timestamp predates pruned audit history"
                      {:type :history/pruned
                       :pruned-below-ts (str marker)
                       :requested-ts ts-iso})))))

;; ============================================================
;; Batch clamp
;; ============================================================

(defn- effective-bound
  "The upper ts bound for reconstruction at `ts-iso`: `{:lte ts}`
  normally, or `{:lt <batch-start>}` when ts lands strictly inside an
  atomic batch (see ns docstring)."
  [db ts-iso]
  (let [last-op (psc/q1 db {:select [:batch_id]
                            :from [:operations]
                            :where [:<= :ts ts-iso]
                            :order-by [[:ts :desc]]
                            :limit 1})]
    (if-let [bid (:batch_id last-op)]
      (if (some? (psc/q1 db {:select [:id]
                             :from [:operations]
                             :where [:and [:= :batch_id bid] [:> :ts ts-iso]]
                             :limit 1}))
        {:lt (str (:ts (psc/q1 db {:select [[[:min :ts] :ts]]
                                   :from [:operations]
                                   :where [:= :batch_id bid]})))}
        {:lte ts-iso})
      {:lte ts-iso})))

(defn- ts-clause [{:keys [lt lte]}]
  (if lt [:< :ts lt] [:<= :ts lte]))

;; ============================================================
;; Fetch + fold
;; ============================================================

(defn- parse-image
  "Audit image JSON → map with keyword TOP-LEVEL keys only; value
  subtrees (the `:metadata` fold) keep STRING keys — keywordizing them
  is lossy for keys containing '/' (the 8cc3ef3 contract)."
  [s]
  (when (and s (not= "" s))
    (-> (json/read-str s)
        (update-keys keyword))))

(def ^:private audit-cols
  [:target_table :target_id :change_type :post_image])

(defn- q-doc-rows
  [db doc-id bound]
  (psc/q db {:select audit-cols
             :from [:audit_writes]
             :where [:and [:= :document_id doc-id] (ts-clause bound)]
             :order-by [:ts :seq]}))

(defn- q-doc-row-only
  "Just the documents-row audit rows for `doc-id` — the cheap fetch
  behind `get-at`/`exists-at?`."
  [db doc-id bound]
  (psc/q db {:select audit-cols
             :from [:audit_writes]
             :where [:and
                     [:= :document_id doc-id]
                     [:= :target_table "documents"]
                     (ts-clause bound)]
             :order-by [:ts :seq]}))

(def ^:private layer-target-tables
  ["text_layers" "token_layers" "span_layers" "relation_layers"])

(defn- q-layer-rows
  "ALL layer-table audit rows at-or-before the bound. Layers are
  low-cardinality (a project has tens of layers; layer config edits are
  rare), so wholesale reconstruction is cheap and needs no extra
  scoping column. Uses the (target_table, target_id) index prefix."
  [db bound]
  (psc/q db {:select audit-cols
             :from [:audit_writes]
             :where [:and
                     [:in :target_table layer-target-tables]
                     (ts-clause bound)]
             :order-by [:ts :seq]}))

(defn- q-target-rows
  "Audit rows for specific entities of one table (vocab items/layers,
  fetched by the ids the doc's links reference)."
  [db table ids bound]
  (if (empty? ids)
    []
    (psc/q db {:select audit-cols
               :from [:audit_writes]
               :where [:and
                       [:= :target_table table]
                       [:in :target_id (mapv str ids)]
                       (ts-clause bound)]
               :order-by [:ts :seq]})))

(defn- coerce-entity
  "Image maps carry UUIDs as JSON strings; coerce :id / *_id columns and
  the `:tokens` junction fold back to UUIDs so the assembled shape
  matches the OLTP row shape exactly. `psc/->uuid` keeps non-UUID
  strings (user ids) as-is."
  [m]
  (reduce-kv
   (fn [acc k v]
     (cond
       (and (string? v)
            (or (= k :id) (str/ends-with? (name k) "_id")))
       (assoc acc k (psc/->uuid v))

       (and (= k :tokens) (sequential? v))
       (assoc acc k (mapv psc/->uuid v))

       :else acc))
   m m))

(defn- fold-rows
  "Reduce audit rows (already in (ts, seq) order) into
  `{[table id-string] <entity map>}`: key-merge of post-images, absent
  after a delete. Full-row images mean intrinsic columns fully replace
  on every update (and explicit JSON nulls null correctly); junction
  folds (`:tokens`, `:metadata`, ...) appear only on synthetic rows and
  last-write-wins-merge across them."
  [rows]
  (reduce (fn [m {:keys [target_table target_id change_type post_image]}]
            (let [k [target_table (str target_id)]]
              (if (= change_type "delete")
                (dissoc m k)
                (update m k clojure.core/merge (parse-image post_image)))))
          {} rows))

(defn- entities-of
  "All folded entities of `table`, coerced, as a vector."
  [folded table]
  (->> folded
       (keep (fn [[[t _] m]] (when (= t table) m)))
       (mapv coerce-entity)))

;; ============================================================
;; Builders for the document row itself. The layer tree under it is
;; assembled by `plaid.sql.document-rows/assemble`, the one the live
;; read uses too.
;; ============================================================

(defn- attach-meta
  "Folded `:metadata` (string-keyed map) → `:metadata` on the result iff
  non-empty, mirroring the OLTP attach (absent, not nil, when empty)."
  [result entity]
  (let [meta-map (:metadata entity)]
    (if (and (map? meta-map) (seq meta-map))
      (assoc result :metadata meta-map)
      result)))

(defn- attach-media-url
  "Media files are not versioned (one file on disk per doc-id), so this
  is a current-filesystem probe — same as the OLTP read. For a doc
  deleted from OLTP the URL is omitted: the media route's auth resolves
  the project from OLTP and would 403/404 (option B, task #138)."
  [m db doc-id]
  (let [doc-deleted? (nil? (psc/fetch-by-id db :documents doc-id))
        url (when-not doc-deleted? (media/media-url doc-id))]
    (cond-> m
      url (assoc :document/media-url url))))

(defn- build-document
  [db entity]
  (-> {:document/id (:id entity)
       :document/name (:name entity)
       :document/project (:project_id entity)
       :document/version (:version entity)
       :document/time-created (:created_at entity)
       :document/time-modified (:modified_at entity)}
      (attach-meta entity)
      (attach-media-url db (:id entity))))

;; ============================================================
;; Public API
;; ============================================================

(defn- project-live?
  "True iff `project-id` still exists in OLTP. A deleted project is truly
  gone and is NOT time-travelable: once its row is dropped (see
  `plaid.sql.project/delete`) the descendant deletions are intentionally
  left un-audited, so reconstructing those documents would serve a 'ghost'
  whose deletion the log never recorded. Gating every as-of read on the
  document's (immutable) project still existing makes deleted projects
  uniformly unreadable, while deleted documents in a LIVE project remain
  time-travelable. A nil project-id reads as not-live."
  [db project-id]
  (and (some? project-id)
       (some? (psc/fetch-by-id db :projects project-id))))

(defn get-at
  "Shape of `plaid.sql.document/get` at time `ts`. Returns nil if the
  document didn't exist at `ts`, or if its project has since been deleted
  (deleted projects are not time-travelable — see `project-live?`)."
  [db doc-id ts]
  (let [ts-iso (->ts-iso ts)
        _ (check-retention! db ts-iso)
        bound (effective-bound db ts-iso)
        folded (fold-rows (q-doc-row-only db doc-id bound))
        entity (some-> (clojure.core/get folded ["documents" (str doc-id)])
                       coerce-entity)]
    (when (and entity (project-live? db (:project_id entity)))
      (build-document db entity))))

(defn exists-at?
  "Cheap presence probe: did `doc-id` exist at `ts` (in a still-live
  project)?"
  [db doc-id ts]
  (let [ts-iso (->ts-iso ts)
        _ (check-retention! db ts-iso)
        bound (effective-bound db ts-iso)
        entity (some-> (clojure.core/get (fold-rows (q-doc-row-only db doc-id bound))
                                         ["documents" (str doc-id)])
                       coerce-entity)]
    (boolean (and entity (project-live? db (:project_id entity))))))

(defn document-rows-at
  "The document-scoped rows at time `ts`, as the audit log folds them and
  keyed the way the OLTP tables are: `{:document row :texts [row ...]
  :tokens [...] :spans [...] :relations [...] :vocab-links [...]}`. Each
  row is column-keyed with ids coerced, plus the `:tokens` fold on spans
  and vocab links and a string-keyed `:metadata` fold where the entity
  had any. This is the row-level view `plaid.history.restore` diffs
  against the current tables; `get-with-layer-data-at` is the same fold
  built into the nested read shape. nil when the document did not exist
  at `ts`, or when its project has since been deleted."
  [db doc-id ts]
  (let [ts-iso (->ts-iso ts)
        _ (check-retention! db ts-iso)
        bound (effective-bound db ts-iso)
        folded (fold-rows (q-doc-rows db doc-id bound))
        doc-entity (some-> (clojure.core/get folded ["documents" (str doc-id)])
                           coerce-entity)]
    (when (and doc-entity (project-live? db (:project_id doc-entity)))
      {:document doc-entity
       :texts (entities-of folded "texts")
       :tokens (entities-of folded "tokens")
       :spans (entities-of folded "spans")
       :relations (entities-of folded "relations")
       :vocab-links (entities-of folded "vocab_links")})))

(defn get-with-layer-data-at
  "Deep document read at time `ts`. Result shape mirrors
  `plaid.sql.document/get-with-layer-data` — same top-level keys, same
  nested layer tree, same junction folding. Returns nil if the document
  didn't exist at `ts`.

  Coherence: the entire read derives from one totally-ordered prefix of
  the audit log (rows with ts at-or-before the bound), so every entity
  reflects the same logical moment by construction."
  [db doc-id ts]
  (let [ts-iso (->ts-iso ts)
        _ (check-retention! db ts-iso)
        bound (effective-bound db ts-iso)
        folded (fold-rows (q-doc-rows db doc-id bound))
        doc-entity (some-> (clojure.core/get folded ["documents" (str doc-id)])
                           coerce-entity)]
    ;; A deleted project is not time-travelable (see `project-live?`): refuse
    ;; the read so reconstruction never serves a document whose project — and
    ;; thus the document itself — has been truly deleted.
    (when (and doc-entity (project-live? db (:project_id doc-entity)))
      (let [doc (build-document db doc-entity)
            prj-id (:project_id doc-entity)
            ;; --- the layer skeleton at T, filtered to this project ---
            layer-folded (fold-rows (q-layer-rows db bound))
            text-layer-rows (->> (entities-of layer-folded "text_layers")
                                 (filterv #(= prj-id (:project_id %))))
            tl-ids (set (map :id text-layer-rows))
            token-layer-rows (->> (entities-of layer-folded "token_layers")
                                  (filterv #(contains? tl-ids (:text_layer_id %))))
            tokl-ids (set (map :id token-layer-rows))
            span-layer-rows (->> (entities-of layer-folded "span_layers")
                                 (filterv #(contains? tokl-ids (:token_layer_id %))))
            sl-ids (set (map :id span-layer-rows))
            ;; --- the vocabulary the document's links name, by referenced id ---
            vl-rows (entities-of folded "vocab_links")
            vi-ids (->> vl-rows (map :vocab_item_id) distinct (remove nil?) vec)
            vi-rows (entities-of (fold-rows (q-target-rows db "vocab_items" vi-ids bound))
                                 "vocab_items")
            vlayer-ids (->> vi-rows (map :vocab_layer_id) distinct (remove nil?) vec)
            vlayer-rows (entities-of (fold-rows (q-target-rows db "vocab_layers" vlayer-ids bound))
                                     "vocab_layers")]
        ;; The fold above produced the rows; the shape they go into, and every
        ;; order inside it, is the assembler's — the same one the live read
        ;; goes through (`plaid.sql.document/get-with-layer-data`), so the two
        ;; cannot drift apart.
        (drows/assemble
         doc
         {:text-layers text-layer-rows
          :token-layers token-layer-rows
          :span-layers span-layer-rows
          :relation-layers (->> (entities-of layer-folded "relation_layers")
                                (filterv #(contains? sl-ids (:span_layer_id %))))
          :texts (->> (entities-of folded "texts")
                      (filterv #(contains? tl-ids (:text_layer_id %))))
          :tokens (entities-of folded "tokens")
          :spans (entities-of folded "spans")
          :relations (entities-of folded "relations")
          :vocab-links vl-rows
          :vocab-items vi-rows
          :vocab-layers vlayer-rows})))))
