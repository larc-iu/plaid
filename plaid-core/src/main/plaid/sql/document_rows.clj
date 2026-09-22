(ns plaid.sql.document-rows
  "The rows a document owns, read whole and written whole.

  Five tables hang off `document_id` (texts, tokens, spans, relations,
  vocab_links), two of them carry an ordered token list in a junction
  table, and any of them can carry metadata. Reading all of that and
  inserting all of it is what a restore does against the state at an
  earlier time (`plaid.history.restore`) and what a copy does against
  another document (`plaid.sql.document/copy`), so the read shape, the
  column lists and the audited insert live here once.

  The read shape is deliberately the one
  `plaid.history.read/document-rows-at` folds out of the audit log, so
  a live read and an as-of read are diffable row for row. `assemble`
  builds the nested deep-read shape out of that one, for both."
  (:require [clojure.data.json :as json]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.common :as psc]
            [plaid.sql.metadata :as metadata]
            [plaid.sql.token-layer :as token-layer]))

(def chunk-size 4000)

(defn q-in
  "SELECT * FROM table WHERE col IN ids, chunked under SQLite's parameter
  ceiling. Empty ids reads nothing."
  [db table col ids]
  (into []
        (mapcat (fn [chunk]
                  (psc/q db {:select [:*]
                             :from [table]
                             :where [:in col (vec chunk)]})))
        (partition-all chunk-size (distinct (seq ids)))))

;; ============================================================
;; The shape
;; ============================================================

(def columns
  "The columns that carry a row's content, per table. The id and the
  document are the identity; everything else a row has is here."
  {:texts [:body :document_id :text_layer_id]
   :tokens [:text_id :token_layer_id :document_id :begin :end_ :precedence]
   :spans [:span_layer_id :document_id :value]
   :relations [:relation_layer_id :document_id :source_span_id :target_span_id :value]
   :vocab_links [:vocab_item_id :document_id]})

(def junction
  "Tables whose ordered token list lives in a junction table, as
  `[table parent-column]`."
  {:spans [:span_tokens :span_id]
   :vocab_links [:vocab_link_tokens :vocab_link_id]})

(def entity-type
  "The `entity_metadata.entity_type` spelling for each table."
  {:texts "text" :tokens "token" :spans "span" :relations "relation" :vocab_links "vocab-link"})

(defn tokens-of [row] (vec (or (:tokens row) [])))

;; ============================================================
;; Reads
;; ============================================================

(defn- token-lists
  "`{parent-id [token-id ...]}` in order_idx order, from a junction table."
  [db table parent-col parent-ids]
  (->> (q-in db table parent-col parent-ids)
       (group-by parent-col)
       (reduce-kv (fn [m k rows]
                    (assoc m k (mapv :token_id (sort-by :order_idx rows))))
                  {})))

(defn- decode-metadata-value [s]
  (try (json/read-str s) (catch Exception _ s)))

(defn- metadata-index
  "`{entity-id {key value}}` for the entities of one type."
  [db etype ids]
  (reduce (fn [m r]
            (update m (:entity_id r) (fnil assoc {}) (:key r) (decode-metadata-value (:value r))))
          {}
          (into []
                (mapcat (fn [chunk]
                          (psc/q db {:select [:entity_id :key :value]
                                     :from [:entity_metadata]
                                     :where [:and
                                             [:= :entity_type etype]
                                             [:in :entity_id (vec chunk)]]})))
                (partition-all chunk-size (distinct (seq ids))))))

(defn with-metadata
  "Attach `:metadata` to the rows that have any."
  [db etype rows]
  (let [idx (metadata-index db etype (map :id rows))]
    (mapv (fn [r]
            (let [m (get idx (:id r))]
              (cond-> r (seq m) (assoc :metadata m))))
          rows)))

(defn read-rows
  "Every row the document owns, keyed by kind, with token lists folded
  onto spans and vocab links and metadata folded onto everything."
  [db doc-id]
  (let [doc (psc/fetch-by-id db :documents doc-id)
        ;; By id, not by insertion order: a copy mints its fresh ids in the
        ;; order it reads these rows, and every read orders by id, so two
        ;; annotations on one token must be read here in the same order the
        ;; source serves them. A restore re-inserts resurrected rows under
        ;; their old ids, which leaves rowid order saying something else.
        by-doc (fn [table] (psc/q db {:select [:*] :from [table]
                                      :where [:= :document_id doc-id]
                                      :order-by [[:id :asc]]}))
        spans (by-doc :spans)
        links (by-doc :vocab_links)
        span-tokens (token-lists db :span_tokens :span_id (map :id spans))
        link-tokens (token-lists db :vocab_link_tokens :vocab_link_id (map :id links))]
    {:document (first (with-metadata db "document" [doc]))
     :texts (with-metadata db "text" (by-doc :texts))
     :tokens (with-metadata db "token" (by-doc :tokens))
     :spans (with-metadata db "span" (mapv #(assoc % :tokens (get span-tokens (:id %) [])) spans))
     :relations (with-metadata db "relation" (by-doc :relations))
     :vocab-links (with-metadata db "vocab-link"
                    (mapv #(assoc % :tokens (get link-tokens (:id %) [])) links))}))

;; ============================================================
;; Assembly: the deep read shape
;; ============================================================

(defn- attach-metadata
  "The row's `:metadata` onto the entity built from it, iff it has any:
  absent, not nil, when it has none."
  [built row]
  (let [m (:metadata row)]
    (if (and (map? m) (seq m))
      (assoc built :metadata m)
      built)))

(defn- by-id
  "Rows in id order. Ids are minted in order, and a client decides which
  of two annotations on one token it shows from the order they arrive in,
  so every read of them serves the same order."
  [rows]
  (vec (sort-by (comp str :id) rows)))

(defn assemble
  "The deep document read: `doc` with `:document/text-layers` under it —
  the layer tree of the document's project, and every row the document
  owns hanging under the layer it belongs to.

  `doc` is the formatted document map (`plaid.sql.document/get` or
  `plaid.history.read/get-at`). `rows` is the `read-rows` shape widened
  with the layer skeleton and the vocabulary its links name:

    `:text-layers` `:token-layers` `:span-layers` `:relation-layers`
      the layers of the document's project, in any order;
    `:texts` `:tokens` `:spans` `:relations` `:vocab-links`
      the document's own rows, in any order, with `:tokens` folded onto
      spans and vocab links and `:metadata` folded onto any of them;
    `:vocab-items` `:vocab-layers`
      the entries the links name and the layers those live in, with
      `:maintainers` folded onto a layer.

  ORDER IS DECIDED HERE, not by the caller: layers by `order_idx`,
  tokens by the canonical token order, spans, relations and links by id,
  a vocabulary's maintainers sorted. The live read
  (`plaid.sql.document/get-with-layer-data`) and the as-of read
  (`plaid.history.read/get-with-layer-data-at`) both hand their rows to
  this function, so the same state reads back the same way through
  either — pinned by `plaid.sql.deep-read-parity-test`."
  [doc {:keys [text-layers token-layers span-layers relation-layers
               texts tokens spans relations vocab-links
               vocab-items vocab-layers]}]
  (let [spans (by-id spans)
        relations (by-id relations)
        links (by-id vocab-links)
        tokens-by-layer (group-by :token_layer_id tokens)
        spans-by-layer (group-by :span_layer_id spans)
        relations-by-layer (group-by :relation_layer_id relations)
        relation-layers-by-span-layer (group-by :span_layer_id relation-layers)
        span-layers-by-token-layer (group-by :token_layer_id span-layers)
        token-layers-by-text-layer (group-by :text_layer_id token-layers)
        text-by-text-layer (into {} (map (juxt :text_layer_id identity)) texts)
        token-layer-of (into {} (map (juxt :id :token_layer_id)) tokens)
        item-by-id (into {} (map (juxt :id identity)) vocab-items)
        vocab-layer-by-id (into {} (map (juxt :id identity)) vocab-layers)
        ;; A link hangs off every token layer its tokens live in (the v2
        ;; contract), so a link over two layers appears under each. Built by
        ;; walking `links`, which is in id order: reducing over a uuid-keyed
        ;; hash map instead leaves each layer's list in the hash's order, which
        ;; shuffles run to run.
        links-by-token-layer
        (reduce (fn [acc link]
                  (reduce (fn [m tl-id] (update m tl-id (fnil conj []) link))
                          acc
                          (->> (tokens-of link)
                               (map token-layer-of)
                               (remove nil?)
                               distinct)))
                {} links)
        build-token (fn [r]
                      (attach-metadata {:token/id (:id r)
                                        :token/begin (:begin r)
                                        :token/end (:end_ r)
                                        :token/precedence (:precedence r)}
                                       r))
        build-span (fn [r]
                     (attach-metadata {:span/id (:id r)
                                       :span/value (psc/read-json (:value r))
                                       :span/tokens (tokens-of r)}
                                      r))
        build-relation (fn [r]
                         (attach-metadata {:relation/id (:id r)
                                           :relation/source (:source_span_id r)
                                           :relation/target (:target_span_id r)
                                           :relation/value (psc/read-json (:value r))}
                                          r))
        ;; A link names its entry by id, layer and form only: the entry's
        ;; metadata lives in the vocabulary read, and repeating it on every
        ;; link made up a quarter of a large document's body.
        build-item (fn [item-id]
                     (when-let [r (item-by-id item-id)]
                       {:vocab-item/id item-id
                        :vocab-item/layer (:vocab_layer_id r)
                        :vocab-item/form (:form r)}))
        build-link (fn [r]
                     (attach-metadata {:vocab-link/id (:id r)
                                       :vocab-link/vocab-item (build-item (:vocab_item_id r))
                                       :vocab-link/tokens (tokens-of r)}
                                      r))
        build-vocabs (fn [tl-id]
                       (->> (get links-by-token-layer tl-id [])
                            (mapv build-link)
                            (group-by (comp :vocab-item/layer :vocab-link/vocab-item))
                            (keep (fn [[vocab-layer-id ls]]
                                    (when-let [r (vocab-layer-by-id vocab-layer-id)]
                                      {:vocab/id vocab-layer-id
                                       :vocab/name (:name r)
                                       :vocab/maintainers (vec (sort (map str (or (:maintainers r) []))))
                                       :config (psc/parse-config (:config r))
                                       :vocab-layer/vocab-links ls})))
                            vec))
        build-relation-layer
        (fn [rl]
          {:relation-layer/id (:id rl)
           :relation-layer/name (:name rl)
           :config (psc/parse-config (:config rl))
           :relation-layer/relations (mapv build-relation
                                           (get relations-by-layer (:id rl) []))})
        build-span-layer
        (fn [sl]
          {:span-layer/id (:id sl)
           :span-layer/name (:name sl)
           :config (psc/parse-config (:config sl))
           :span-layer/spans (mapv build-span (get spans-by-layer (:id sl) []))
           :span-layer/relation-layers (->> (get relation-layers-by-span-layer (:id sl) [])
                                            (sort-by :order_idx)
                                            (mapv build-relation-layer))})
        build-token-layer
        (fn [tl]
          {:token-layer/id (:id tl)
           :token-layer/name (:name tl)
           :config (psc/parse-config (:config tl))
           :token-layer/overlap-mode (some-> (:overlap_mode tl) keyword)
           :token-layer/parent-token-layer (:parent_token_layer_id tl)
           :token-layer/tokens (vec (token-layer/sort-token-records
                                     (map build-token (get tokens-by-layer (:id tl) []))))
           :token-layer/span-layers (->> (get span-layers-by-token-layer (:id tl) [])
                                         (sort-by :order_idx)
                                         (mapv build-span-layer))
           :token-layer/vocabs (build-vocabs (:id tl))})
        build-text-layer
        (fn [txtl]
          (let [text-row (text-by-text-layer (:id txtl))]
            {:text-layer/id (:id txtl)
             :text-layer/name (:name txtl)
             :config (psc/parse-config (:config txtl))
             :text-layer/text (when text-row
                                (attach-metadata {:text/id (:id text-row)
                                                  :text/document (:document_id text-row)
                                                  :text/body (:body text-row)}
                                                 text-row))
             :text-layer/token-layers (->> (get token-layers-by-text-layer (:id txtl) [])
                                           (sort-by :order_idx)
                                           (mapv build-token-layer))}))]
    (assoc doc :document/text-layers
           (mapv build-text-layer (sort-by :order_idx text-layers)))))

;; ============================================================
;; Writes
;; ============================================================

(defn- plain-row [table r]
  (into {:id (:id r)} (map (fn [k] [k (get r k)])) (get columns table)))

(defn insert-junction!
  "Write the ordered token lists of `rows` into `[jtable jcol]`."
  [tx [jtable jcol] rows]
  (let [jrows (for [r rows
                    [i tid] (map-indexed vector (tokens-of r))]
                {jcol (:id r) :token_id tid :order_idx i})]
    (doseq [chunk (partition-all chunk-size jrows)]
      (psc/execute! tx {:insert-into jtable :values (vec chunk)}))))

(defn insert-rows!
  "Insert rows under the ids they carry, with their junction token lists
  and their metadata, and one :insert audit row each whose post-image
  folds both in, as the entity create paths do."
  [tx table rows]
  (when (seq rows)
    (let [etype (get entity-type table)
          j (get junction table)]
      (doseq [chunk (partition-all chunk-size rows)]
        (let [posts (psc/execute-returning! tx {:insert-into table
                                                :values (mapv #(plain-row table %) chunk)
                                                :returning [:*]})
              post-by-id (into {} (map (juxt :id identity)) posts)]
          (when j (insert-junction! tx j chunk))
          (metadata/insert-metadata-rows!
           tx etype (into {} (keep (fn [r] (when (seq (:metadata r)) [(:id r) (:metadata r)]))) chunk))
          (psaw/record-audit-writes!
           tx table :insert
           (mapv (fn [r]
                   (let [post (get post-by-id (:id r))]
                     [(:id r) nil (cond-> post
                                    j (assoc :tokens (tokens-of r))
                                    (seq (:metadata r)) (assoc :metadata (:metadata r)))]))
                 chunk)))))))
