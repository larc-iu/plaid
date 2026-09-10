(ns plaid.history.restore
  "Restore a document to its state at an earlier time, on the server, as
  one operation.

  The state at T is what the audit log folds for the document
  (`plaid.history.read/document-rows-at`): every document-scoped row
  with the id it had, plus the `:tokens` junction fold on spans and
  vocab links and the `:metadata` fold on everything. The current state
  is read from the OLTP tables. The two are diffed BY ID, table by
  table, and the differences are applied inside one transaction:

    - a row present now and absent at T is deleted, bottom-up
      (relations, vocab links, spans, tokens, texts), each with its own
      audit row, since a foreign-key cascade would sweep dependents
      without one;
    - a row present at T and absent now is inserted again UNDER ITS OLD
      ID, top-down, so anything that still names that id (a comment, a
      bookmark, another app's reference) finds it again;
    - a row present on both sides is set back where its columns, its
      token list or its metadata differ.

  Every write goes through the audited helpers with a full post-image,
  so history after a restore reads correctly (the as-of fold rebuilds a
  resurrected id from its new insert row) and the restore is itself
  restorable. What cannot come back is skipped and reported, never
  guessed: a row whose layer was deleted since T, a link whose
  vocabulary entry is gone or whose vocabulary left the project, and
  whatever depends on those. The final state is validated once, layer
  by layer (bounds, overlap mode, nesting); a violation rolls the whole
  operation back with a 409 naming the layer.

  A dry run builds the same plan from a plain read and reports what
  would change without opening an operation."
  (:require [plaid.history.read :as hread]
            [plaid.sql.common :as psc]
            [plaid.sql.constraints.token :as tc]
            [plaid.sql.document-rows :as drows]
            [plaid.sql.metadata :as metadata]
            [plaid.sql.operation :refer [submit-operation!]])
  (:import (clojure.lang ExceptionInfo)))

;; ============================================================
;; What can come back
;; ============================================================

(defn- prune-target
  "Drop from the target what has nothing to attach to any more, closed
  under dependency, and say what was dropped. Returns `[target skipped]`."
  [db tgt]
  (let [prj (:project_id (:document tgt))
        ids-of (fn [rows] (set (map :id rows)))
        text-layer-ids (ids-of (psc/q db {:select [:id] :from [:text_layers] :where [:= :project_id prj]}))
        token-layer-ids (ids-of (drows/q-in db :token_layers :text_layer_id text-layer-ids))
        span-layer-ids (ids-of (drows/q-in db :span_layers :token_layer_id token-layer-ids))
        relation-layer-ids (ids-of (drows/q-in db :relation_layers :span_layer_id span-layer-ids))
        project-vocab-ids (set (map :vocab_layer_id
                                    (psc/q db {:select [:vocab_layer_id]
                                               :from [:project_vocabs]
                                               :where [:= :project_id prj]})))
        live-item-ids (->> (drows/q-in db :vocab_items :id (map :vocab_item_id (:vocab-links tgt)))
                           (filter #(contains? project-vocab-ids (:vocab_layer_id %)))
                           ids-of)
        texts (filterv #(contains? text-layer-ids (:text_layer_id %)) (:texts tgt))
        text-ids (ids-of texts)
        tokens (filterv #(and (contains? token-layer-ids (:token_layer_id %))
                              (contains? text-ids (:text_id %)))
                        (:tokens tgt))
        token-ids (ids-of tokens)
        spans (filterv #(and (contains? span-layer-ids (:span_layer_id %))
                             (every? token-ids (:tokens %)))
                       (:spans tgt))
        span-ids (ids-of spans)
        relations (filterv #(and (contains? relation-layer-ids (:relation_layer_id %))
                                 (contains? span-ids (:source_span_id %))
                                 (contains? span-ids (:target_span_id %)))
                           (:relations tgt))
        links (filterv #(and (contains? live-item-ids (:vocab_item_id %))
                             (every? token-ids (:tokens %)))
                       (:vocab-links tgt))
        skipped (->> [{:kind "text" :count (- (count (:texts tgt)) (count texts))
                       :reason "its layer no longer exists"}
                      {:kind "token" :count (- (count (:tokens tgt)) (count tokens))
                       :reason "its layer or text no longer exists"}
                      {:kind "span" :count (- (count (:spans tgt)) (count spans))
                       :reason "its layer no longer exists, or a token it covers cannot come back"}
                      {:kind "relation" :count (- (count (:relations tgt)) (count relations))
                       :reason "its layer no longer exists, or a span it joins cannot come back"}
                      {:kind "vocab-link" :count (- (count (:vocab-links tgt)) (count links))
                       :reason "the vocabulary entry no longer exists, or a token it covers cannot come back"}]
                     (remove #(zero? (:count %)))
                     vec)]
    [(assoc tgt :texts texts :tokens tokens :spans spans :relations relations :vocab-links links)
     skipped]))

;; ============================================================
;; The diff
;; ============================================================

(def ^:private layer-column
  {:tokens :token_layer_id :spans :span_layer_id :relations :relation_layer_id})

(defn- meta-of [row] (or (:metadata row) {}))

(defn- diff-table
  "Rows to delete (current rows), insert (target rows), and update
  (`{:id :row :attrs? :tokens? :meta?}` with the target row)."
  [table cur tgt]
  (let [cur-by-id (into {} (map (juxt :id identity)) cur)
        tgt-by-id (into {} (map (juxt :id identity)) tgt)
        cols (get drows/columns table)
        junction? (contains? drows/junction table)]
    {:delete (vec (remove #(contains? tgt-by-id (:id %)) cur))
     :insert (vec (remove #(contains? cur-by-id (:id %)) tgt))
     :update (vec (for [t tgt
                        :let [c (get cur-by-id (:id t))]
                        :when c
                        :let [attrs? (boolean (some #(not= (get t %) (get c %)) cols))
                              tokens? (and junction? (not= (drows/tokens-of t) (drows/tokens-of c)))
                              meta? (not= (meta-of t) (meta-of c))]
                        :when (or attrs? tokens? meta?)]
                    {:id (:id t) :row t :attrs? attrs? :tokens? tokens? :meta? meta?}))}))

(defn- plan
  "Everything the restore would do, from the target rows at T (already
  pruned) and the current rows."
  [tgt cur]
  {:name (let [n (:name (:document tgt))]
           (when (not= n (:name (:document cur))) n))
   :document-metadata? (not= (meta-of (:document tgt)) (meta-of (:document cur)))
   :texts (diff-table :texts (:texts cur) (:texts tgt))
   :tokens (diff-table :tokens (:tokens cur) (:tokens tgt))
   :spans (diff-table :spans (:spans cur) (:spans tgt))
   :relations (diff-table :relations (:relations cur) (:relations tgt))
   :vocab_links (diff-table :vocab_links (:vocab-links cur) (:vocab-links tgt))})

(defn- counts
  "`{:inserted :updated :deleted}` for one table's diff, plus `:by-layer`
  (a vector of `{:layer-id ...}` entries) for the layered tables."
  [table d]
  (let [base {:inserted (count (:insert d))
              :updated (count (:update d))
              :deleted (count (:delete d))}]
    (if-let [col (get layer-column table)]
      (let [tally (fn [k rows] (frequencies (map col rows)))
            ins (tally :inserted (:insert d))
            upd (tally :updated (map :row (:update d)))
            del (tally :deleted (:delete d))]
        (assoc base :by-layer
               (->> (distinct (concat (keys ins) (keys upd) (keys del)))
                    (mapv (fn [lid]
                            {:layer-id lid
                             :inserted (get ins lid 0)
                             :updated (get upd lid 0)
                             :deleted (get del lid 0)})))))
      base)))

(defn summarize
  "The counts a person confirms, from a plan. `:total` is zero only when
  nothing at all would change."
  [p skipped]
  (let [per-table (into {} (map (fn [t] [t (counts t (get p t))])) (keys drows/columns))
        n (fn [t] (let [c (get per-table t)] (+ (:inserted c) (:updated c) (:deleted c))))]
    {:name (some? (:name p))
     :document-metadata (boolean (:document-metadata? p))
     :texts (:texts per-table)
     :tokens (:tokens per-table)
     :spans (:spans per-table)
     :relations (:relations per-table)
     :vocab-links (:vocab_links per-table)
     :skipped skipped
     :total (+ (if (:name p) 1 0)
               (if (:document-metadata? p) 1 0)
               (reduce + (map n (keys drows/columns))))}))

;; ============================================================
;; Applying it
;; ============================================================

(defn- delete-rows! [tx table rows]
  (when (seq rows)
    (let [ids (mapv :id rows)]
      (doseq [chunk (partition-all drows/chunk-size ids)]
        (psc/delete-where! tx table [:in :id (vec chunk)])
        (metadata/sweep-metadata! tx (get drows/entity-type table) (vec chunk))))))

(defn- fetch-junction-tokens [tx [jtable jcol] id]
  (mapv :token_id (psc/q tx {:select [:token_id] :from [jtable]
                             :where [:= jcol id] :order-by [:order_idx]})))

(defn- update-rows! [tx table updates]
  (when (seq updates)
    (let [etype (get drows/entity-type table)
          j (get drows/junction table)
          cols (get drows/columns table)]
      (doseq [chunk (partition-all 1000 (for [u updates :when (:attrs? u)]
                                          [(:id u) (select-keys (:row u) cols)]))]
        (psc/bulk-update-by-id! tx table (vec chunk)))
      ;; A token list is rewritten in the junction table and audited as one
      ;; synthetic row on the parent carrying the new list (span/set-tokens).
      (doseq [u updates :when (:tokens? u)]
        (let [row (psc/fetch-by-id tx table (:id u))
              pre (fetch-junction-tokens tx j (:id u))]
          (psc/execute! tx {:delete-from (first j) :where [:= (second j) (:id u)]})
          (drows/insert-junction! tx j [(:row u)])
          (psc/record-audit-write! tx table (:id u) :update
                                   (assoc row :tokens pre)
                                   (assoc row :tokens (drows/tokens-of (:row u))))))
      (doseq [u updates :when (:meta? u)]
        (metadata/replace-metadata! tx etype (:id u) (meta-of (:row u)))))))

(defn- apply-plan! [tx doc-id p]
  ;; Deletes bottom-up, so nothing is swept by a foreign-key cascade.
  (delete-rows! tx :relations (get-in p [:relations :delete]))
  (delete-rows! tx :vocab_links (get-in p [:vocab_links :delete]))
  (delete-rows! tx :spans (get-in p [:spans :delete]))
  (delete-rows! tx :tokens (get-in p [:tokens :delete]))
  (delete-rows! tx :texts (get-in p [:texts :delete]))
  ;; The document row.
  (when-let [n (:name p)]
    (psc/update-by-id! tx :documents doc-id {:name n}))
  (when (:document-metadata? p)
    (metadata/replace-metadata! tx "document" doc-id (:document-metadata p)))
  ;; Inserts top-down, then the in-place changes.
  (doseq [table [:texts :tokens :spans :relations :vocab_links]]
    (drows/insert-rows! tx table (get-in p [table :insert])))
  (doseq [table [:texts :tokens :spans :relations :vocab_links]]
    (update-rows! tx table (get-in p [table :update]))))

;; ============================================================
;; Validating the result
;; ============================================================

(defn- code-points [^String s]
  (if s (.codePointCount s 0 (.length s)) 0))

(defn- violation [layer detail]
  (ex-info (str "The state at that time no longer fits the layer "
                (pr-str (:name layer)) ": " detail)
           {:code 409 :layer (:id layer)}))

(defn- validate-final-state!
  "Every token layer of the document, checked in memory against its
  text: bounds, overlap mode, and containment in the parent layer. The
  state was valid when it was live, so this catches what changed
  around it since, and whatever the plan itself got wrong."
  [tx doc-id]
  (let [texts (psc/q tx {:select [:id :body] :from [:texts] :where [:= :document_id doc-id]})
        length-of (into {} (map (fn [t] [(:id t) (code-points (:body t))])) texts)
        tokens (psc/q tx {:select [:*] :from [:tokens] :where [:= :document_id doc-id]})
        layers (into {} (map (juxt :id identity))
                     (drows/q-in tx :token_layers :id (map :token_layer_id tokens)))
        by-layer-text (group-by (juxt :token_layer_id :text_id) tokens)]
    (doseq [[[lid tid] toks] by-layer-text]
      (let [layer (get layers lid)
            len (get length-of tid 0)
            mode (keyword (or (:overlap_mode layer) "any"))
            sorted (sort-by (juxt :begin :end_) toks)]
        (doseq [t toks]
          (when-not (<= 0 (:begin t) (:end_ t) len)
            (throw (violation layer (str "token " (:begin t) "-" (:end_ t)
                                         " falls outside the text of " len " code points")))))
        (case mode
          :partitioning
          (try
            (tc/validate-partition! (map (fn [t] {:token/id (:id t) :token/begin (:begin t) :token/end (:end_ t)})
                                         toks)
                                    len)
            (catch ExceptionInfo e
              (throw (violation layer (ex-message e)))))
          :non-overlapping
          (doseq [[a b] (partition 2 1 sorted)]
            (when (< (:begin b) (:end_ a))
              (throw (violation layer (str "tokens " (:begin a) "-" (:end_ a) " and "
                                           (:begin b) "-" (:end_ b) " overlap")))))
          nil)
        (when-let [pid (:parent_token_layer_id layer)]
          (let [parents (get by-layer-text [pid tid])]
            (doseq [t toks]
              (when-not (some #(and (<= (:begin %) (:begin t)) (<= (:end_ t) (:end_ %))) parents)
                (throw (violation layer (str "token " (:begin t) "-" (:end_ t)
                                             " has no containing token in its parent layer")))))))))))

;; ============================================================
;; Public API
;; ============================================================

(defn- target-rows!
  "The document's rows at `ts`, or a structured throw the REST layer maps."
  [db doc-id ts]
  (when (nil? (psc/fetch-by-id db :documents doc-id))
    (throw (ex-info (psc/err-msg-not-found "Document" doc-id) {:code 404 :id doc-id})))
  (or (hread/document-rows-at db doc-id ts)
      (throw (ex-info "The document did not exist at that time." {:code 400 :id doc-id}))))

(defn- build
  "Target (pruned), current, plan and skips, from one connection."
  [db doc-id ts]
  (let [[tgt skipped] (prune-target db (target-rows! db doc-id ts))
        cur (drows/read-rows db doc-id)
        p (assoc (plan tgt cur) :document-metadata (meta-of (:document tgt)))]
    {:plan p :skipped skipped :summary (summarize p skipped)}))

(defn preview
  "What restoring `doc-id` to `ts` would change, without writing. Throws
  ex-info with `:code` 404 (no such document now) or 400 (none at ts)."
  [db doc-id ts]
  (:summary (build db doc-id ts)))

(defn restore
  "Restore `doc-id` to its state at `ts` as one audited operation.
  Returns `{:success true :extra summary}` or `{:success false :code
  :error}` like every other operation."
  [db doc-id ts user-id]
  (let [prj-id (:project_id (psc/fetch-by-id db :documents doc-id))]
    (submit-operation!
     [tx db {:type :document/restore
             :project prj-id
             :document doc-id
             :description (str "Restore document to " (hread/->ts-iso ts))
             :user user-id}]
     (let [{:keys [plan summary]} (build tx doc-id ts)]
       (apply-plan! tx doc-id plan)
       (validate-final-state! tx doc-id)
       summary))))
