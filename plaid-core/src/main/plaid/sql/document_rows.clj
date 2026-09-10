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
  a live read and an as-of read are diffable row for row."
  (:require [clojure.data.json :as json]
            [plaid.sql.common :as psc]
            [plaid.sql.metadata :as metadata]))

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
        by-doc (fn [table] (psc/q db {:select [:*] :from [table] :where [:= :document_id doc-id]}))
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
          (psc/record-audit-writes!
           tx table :insert
           (mapv (fn [r]
                   (let [post (get post-by-id (:id r))]
                     [(:id r) nil (cond-> post
                                    j (assoc :tokens (tokens-of r))
                                    (seq (:metadata r)) (assoc :metadata (:metadata r)))]))
                 chunk)))))))
