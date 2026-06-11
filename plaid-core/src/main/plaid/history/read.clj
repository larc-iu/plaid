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
            [plaid.sql.token-layer :as token-layer])
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
;; Builders — mirror plaid.sql.document/get-with-layer-data exactly
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
  (let [doc-deleted? (nil? (psc/fetch-by-id db :documents doc-id))]
    (cond-> m
      (and (not doc-deleted?) (media/media-exists? doc-id))
      (assoc :document/media-url (str "/api/v1/documents/" doc-id "/media")))))

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

(def ^:private token-order
  "Canonical token order (begin, precedence NULLS LAST, end, id) — the
  OLTP deep read's SQL ORDER BY, reproduced for the in-memory rows."
  (juxt :begin
        (fn [t] (if (nil? (:precedence t)) 1 0))
        :precedence
        :end_
        (comp str :id)))

;; ============================================================
;; Public API
;; ============================================================

(defn get-at
  "Shape of `plaid.sql.document/get` at time `ts`. Returns nil if the
  document didn't exist at `ts`."
  [db doc-id ts]
  (let [ts-iso (->ts-iso ts)
        _ (check-retention! db ts-iso)
        bound (effective-bound db ts-iso)
        folded (fold-rows (q-doc-row-only db doc-id bound))
        entity (clojure.core/get folded ["documents" (str doc-id)])]
    (when entity
      (build-document db (coerce-entity entity)))))

(defn exists-at?
  "Cheap presence probe: did `doc-id` exist at `ts`?"
  [db doc-id ts]
  (let [ts-iso (->ts-iso ts)
        _ (check-retention! db ts-iso)
        bound (effective-bound db ts-iso)]
    (contains? (fold-rows (q-doc-row-only db doc-id bound))
               ["documents" (str doc-id)])))

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
    (when doc-entity
      (let [doc (build-document db doc-entity)
            prj-id (:project_id doc-entity)
            ;; --- layer skeleton at T, filtered to this project ---
            layer-folded (fold-rows (q-layer-rows db bound))
            layers-of (fn [table]
                        (->> (entities-of layer-folded table)
                             (filterv #(= prj-id (:project_id %)))))
            text-layer-rows (->> (layers-of "text_layers")
                                 (sort-by :order_idx))
            tl-ids (set (map :id text-layer-rows))
            token-layer-rows (->> (entities-of layer-folded "token_layers")
                                  (filter #(contains? tl-ids (:text_layer_id %)))
                                  (sort-by :order_idx))
            tokl-ids (set (map :id token-layer-rows))
            span-layer-rows (->> (entities-of layer-folded "span_layers")
                                 (filter #(contains? tokl-ids (:token_layer_id %)))
                                 (sort-by :order_idx))
            sl-ids (set (map :id span-layer-rows))
            relation-layer-rows (->> (entities-of layer-folded "relation_layers")
                                     (filter #(contains? sl-ids (:span_layer_id %)))
                                     (sort-by :order_idx))
            ;; --- document-scoped entities at T ---
            text-rows (->> (entities-of folded "texts")
                           (filterv #(contains? tl-ids (:text_layer_id %))))
            token-rows (->> (entities-of folded "tokens")
                            (sort-by token-order))
            span-rows (->> (entities-of folded "spans")
                           (sort-by (comp str :id)))
            relation-rows (->> (entities-of folded "relations")
                               (sort-by (comp str :id)))
            vl-rows (->> (entities-of folded "vocab_links")
                         (sort-by (comp str :id)))
            ;; --- vocab hydration (by referenced id) ---
            vi-ids (->> vl-rows (map :vocab_item_id) distinct (remove nil?) vec)
            vi-rows (entities-of (fold-rows (q-target-rows db "vocab_items" vi-ids bound))
                                 "vocab_items")
            vlayer-ids (->> vi-rows (map :vocab_layer_id) distinct (remove nil?) vec)
            vlayer-rows (entities-of (fold-rows (q-target-rows db "vocab_layers" vlayer-ids bound))
                                     "vocab_layers")
            ;; --- grouping ---
            token-rows-by-layer (group-by :token_layer_id token-rows)
            span-rows-by-layer (group-by :span_layer_id span-rows)
            rel-rows-by-layer (group-by :relation_layer_id relation-rows)
            relation-layers-by-span-layer (group-by :span_layer_id relation-layer-rows)
            span-layers-by-token-layer (group-by :token_layer_id span-layer-rows)
            token-layers-by-text-layer (group-by :text_layer_id token-layer-rows)
            text-by-text-layer (into {} (map (juxt :text_layer_id identity)) text-rows)
            token-id->layer (into {} (map (juxt :id :token_layer_id)) token-rows)
            vi-by-id (into {} (map (juxt :id identity)) vi-rows)
            vlayer-by-id (into {} (map (juxt :id identity)) vlayer-rows)
            vl->token-layers (reduce (fn [acc vl]
                                       (assoc acc (:id vl)
                                              (->> (or (:tokens vl) [])
                                                   (map token-id->layer)
                                                   (remove nil?)
                                                   distinct
                                                   vec)))
                                     {} vl-rows)
            vl-by-id (into {} (map (juxt :id identity)) vl-rows)
            links-by-token-layer (reduce (fn [acc [vl-id tlids]]
                                           (reduce (fn [a tlid]
                                                     (update a tlid (fnil conj []) vl-id))
                                                   acc tlids))
                                         {} vl->token-layers)
            ;; --- builders (shape-identical to the OLTP deep read) ---
            build-token (fn [r]
                          (-> {:token/id (:id r)
                               :token/document (:document_id r)
                               :token/text (:text_id r)
                               :token/begin (:begin r)
                               :token/end (:end_ r)
                               :token/precedence (:precedence r)}
                              (attach-meta r)))
            build-span (fn [r]
                         (-> {:span/id (:id r)
                              :span/document (:document_id r)
                              :span/value (psc/read-json (:value r))
                              :span/tokens (or (:tokens r) [])}
                             (attach-meta r)))
            build-relation (fn [r]
                             (-> {:relation/id (:id r)
                                  :relation/document (:document_id r)
                                  :relation/source (:source_span_id r)
                                  :relation/target (:target_span_id r)
                                  :relation/value (psc/read-json (:value r))}
                                 (attach-meta r)))
            build-vocab-item (fn [vi-id]
                               (when-let [row (vi-by-id vi-id)]
                                 (-> {:vocab-item/id vi-id
                                      :vocab-item/layer (:vocab_layer_id row)
                                      :vocab-item/form (:form row)}
                                     (attach-meta row))))
            build-link (fn [vl-id]
                         (let [row (vl-by-id vl-id)]
                           (-> {:vocab-link/id vl-id
                                :vocab-link/vocab-item (build-vocab-item (:vocab_item_id row))
                                :vocab-link/tokens (or (:tokens row) [])}
                               (attach-meta row))))
            build-vocabs-for-token-layer
            (fn [tl-id]
              (let [vl-ids (clojure.core/get links-by-token-layer tl-id [])
                    links (mapv build-link vl-ids)
                    links-by-vlayer (group-by (fn [l]
                                                (:vocab-item/layer
                                                 (:vocab-link/vocab-item l)))
                                              links)]
                (->> links-by-vlayer
                     (keep (fn [[vlayer-id ls]]
                             (when-let [row (vlayer-by-id vlayer-id)]
                               {:vocab/id vlayer-id
                                :vocab/name (:name row)
                                ;; Sorted: matches the OLTP read's
                                ;; ORDER BY user_id on the maintainers
                                ;; join (the folded list is the
                                ;; synthetic image's running value).
                                :vocab/maintainers (vec (sort (map str (or (:maintainers row) []))))
                                :config (psc/parse-config (:config row))
                                :vocab-layer/vocab-links ls})))
                     vec)))
            build-relation-layer
            (fn [rl]
              {:relation-layer/id (:id rl)
               :relation-layer/name (:name rl)
               :config (psc/parse-config (:config rl))
               :relation-layer/relations (->> (clojure.core/get rel-rows-by-layer (:id rl) [])
                                              (mapv build-relation))})
            build-span-layer
            (fn [sl]
              {:span-layer/id (:id sl)
               :span-layer/name (:name sl)
               :config (psc/parse-config (:config sl))
               :span-layer/spans (->> (clojure.core/get span-rows-by-layer (:id sl) [])
                                      (mapv build-span))
               :span-layer/relation-layers (->> (clojure.core/get relation-layers-by-span-layer (:id sl) [])
                                                (sort-by :order_idx)
                                                (mapv build-relation-layer))})
            build-token-layer
            (fn [tl]
              (let [raw-tokens (->> (clojure.core/get token-rows-by-layer (:id tl) [])
                                    (mapv build-token))
                    tokens (vec (token-layer/sort-token-records raw-tokens))]
                {:token-layer/id (:id tl)
                 :token-layer/name (:name tl)
                 :config (psc/parse-config (:config tl))
                 :token-layer/overlap-mode (some-> (:overlap_mode tl) keyword)
                 :token-layer/parent-token-layer (:parent_token_layer_id tl)
                 :token-layer/tokens tokens
                 :token-layer/span-layers (->> (clojure.core/get span-layers-by-token-layer (:id tl) [])
                                               (sort-by :order_idx)
                                               (mapv build-span-layer))
                 :token-layer/vocabs (build-vocabs-for-token-layer (:id tl))}))
            build-text-layer
            (fn [txtl]
              (let [text-row (text-by-text-layer (:id txtl))
                    text (when text-row
                           (-> {:text/id (:id text-row)
                                :text/document (:document_id text-row)
                                :text/body (:body text-row)}
                               (attach-meta text-row)))]
                {:text-layer/id (:id txtl)
                 :text-layer/name (:name txtl)
                 :config (psc/parse-config (:config txtl))
                 :text-layer/text text
                 :text-layer/token-layers (->> (clojure.core/get token-layers-by-text-layer (:id txtl) [])
                                               (sort-by :order_idx)
                                               (mapv build-token-layer))}))]
        (assoc doc :document/text-layers (mapv build-text-layer text-layer-rows))))))
