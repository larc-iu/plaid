(ns plaid.history.undo
  "Undo one audit entry: put every row it wrote back as it was just before
  it, as one operation, and leave alone what people did since.

  The entry is what every audit read names (`:audit/id`): a group, a batch,
  one operation, or an action inside one. Its rows are what the changes read
  folds (`plaid.history.changes/unit-rows`): each row of a document or a
  vocabulary it wrote, with the row just before its first write (`before`)
  and just after its last (`after`). Undoing a row puts its `before` back:
  a row the entry made is deleted, one it deleted is inserted again under
  its old id, one it changed is set back.

  A row is left as it is, and listed with a reason, when:

    changed-since       a later operation wrote it, or it is not now as the
                        entry left it,
    changed-between     someone else wrote it between the entry's own writes,
    not-permitted       the caller may not maintain its document or
                        vocabulary,
    locked              another user holds its document's lock,
    not-undone          it is a vocabulary's own row (its name or settings),
                        which undo does not take back, as it takes back no
                        project's or layer's,
    built-on            the entry made it and a row that stays names it
                        (`by`): a span, link or child token on a token, a
                        token on a text, a relation on a span, a link to an
                        entry or a reference to it in metadata, a comment,
                        and for a document anything written in it since,
    needs               it needs a row that will not be there (`needs`): its
                        parent, gone since, or a row of this undo that is
                        left,
    text-changed-since  its offsets belong to a text that does not go back:
                        something in its document wrote a text or a token
                        since the entry began, or a token of the entry on the
                        text is left,
    name-taken          a document's name, which another document holds now,
    does-not-fit        its document's layers would not hold (restore's final
                        check, or a rule a layer declares), so every row of
                        that document is left,
    value-not-allowed   a closed list of its layer no longer allows its value.

  Leaving is closed under dependency: a fixpoint checks each row against the
  state the undo would leave, so a row that needs a left row is left, and so
  is a made row that a left row names.

  The rows are applied inside ONE transaction, in this order: documents
  inserted again, entries inserted again and set back, each document's rows
  by document restore's own apply (`plaid.history.restore/apply-plan!`:
  deletes bottom-up, inserts top-down under the old ids, updates, held
  deletes), documents the entry made deleted whole, entries the entry made
  deleted. Then each document written is checked as restore checks it, and
  the layer rules are read (`plaid.sql.constraints.layer/pending-violations`).
  A misfit rolls the transaction back, the rows it names are left (the
  document's, or the one value's row), and the undo is planned again, so no
  layer rule's remedy ever writes past what the undo puts back. A dry run is
  the same transaction rolled back at its end, so it says exactly what the
  call would do."
  (:require [clojure.string :as str]
            [plaid.history.changes :as changes]
            [plaid.history.read :as hread]
            [plaid.history.restore :as restore]
            [plaid.media.storage :as media]
            [plaid.server.locks :as locks]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.common :as psc]
            [plaid.sql.constraints.layer :as constraints]
            [plaid.sql.crud :as crud]
            [plaid.sql.document :as document]
            [plaid.sql.document-names :as names]
            [plaid.sql.metadata :as metadata]
            [plaid.sql.operation :as op]
            [plaid.sql.vocab-item :as vocab-item]
            [taoensso.timbre :as log])
  (:import (clojure.lang ExceptionInfo)))

;; ============================================================
;; Limits
;; ============================================================

(def max-rows
  "The most rows an undo takes at once. Above it the undo is refused (413):
  it is one transaction, which holds the write lock its whole time while
  every other write waits."
  20000)

(def max-listed
  "The most skipped rows a summary lists. `skipped-count` counts them all."
  1000)

(def ^:private max-attempts
  "Each attempt that misfits leaves at least one more row, so this is a
  backstop only."
  25)

;; ============================================================
;; Rows
;; ============================================================

(def ^:private kind-of
  {"documents" "document" "texts" "text" "tokens" "token" "spans" "span"
   "relations" "relation" "vocab_links" "vocab-link" "vocab_items" "vocab-item"
   "vocab_layers" "vocab-layer"})

(def ^:private doc-tables #{"texts" "tokens" "spans" "relations" "vocab_links"})

(def ^:private bump "doc-version-bump")

(def ^:private comment-type
  {"documents" "document" "texts" "text" "tokens" "token" "spans" "span"
   "relations" "relation" "vocab_items" "vocab-item"})

(def ^:private table-of-etype
  {"document" "documents" "text" "texts" "token" "tokens" "span" "spans"
   "relation" "relations" "vocab-link" "vocab_links" "vocab-item" "vocab_items"})

(defn- norm
  "A folded or live row with its ids as UUIDs."
  [row]
  (some-> row hread/coerce-entity))

(defn- with-meta-of [rows metas]
  (into {} (map (fn [r]
                  (let [m (get metas (str (:id r)))]
                    [(:id r) (cond-> r (seq m) (assoc :metadata m))])))
        rows))

(defn- live-rows
  "`{id row}` for the rows of `table` among `ids` that exist now, read whole
  as the fold has them (token lists and metadata)."
  [db table ids]
  (if (empty? ids)
    {}
    (cond
      (doc-tables table)
      (into {} (map (fn [[k v]] [(psc/->uuid k) (norm v)])) (psaw/entity-images db table ids))

      (#{"documents" "vocab_items"} table)
      (let [rows (psc/fetch-ids db (keyword table) (mapv str ids))]
        (with-meta-of rows (psc/metadata-by-entity db (comment-type table) (map :id rows))))

      :else
      (into {} (map (juxt :id identity)) (psc/fetch-ids db (keyword table) (mapv str ids))))))

(defn- item
  "One row of the entry, as undo plans it."
  [{:keys [table id before after changed-since changed-between]}]
  (let [b (norm before)
        a (norm after)
        r (or b a)]
    {:k [table (psc/->uuid id)]
     :table table
     :id (psc/->uuid id)
     :op (cond (nil? b) :delete (nil? a) :insert :else :update)
     :before b
     :after a
     :doc (cond (= table "documents") (psc/->uuid id)
                (doc-tables table) (:document_id r))
     :vocab (case table
              "vocab_items" (:vocab_layer_id r)
              "vocab_layers" (psc/->uuid id)
              nil)
     :changed-since changed-since
     :changed-between changed-between}))

(def ^:private parent-kind
  {"text_layers" "text-layer" "token_layers" "token-layer" "span_layers" "span-layer"
   "relation_layers" "relation-layer" "projects" "project"})

(defn- row-ref [[table id]] {:kind (or (kind-of table) (parent-kind table) table) :id id})

;; ============================================================
;; Reading what the plan is checked against
;; ============================================================

(defn- ids-of [items table op]
  (into [] (comp (filter #(and (= table (:table %)) (or (nil? op) (op (:op %))))) (map :id)) items))

(defn- comments-on
  "`{[table id] true}` for the rows among `keys` with a comment."
  [db ks]
  (into {}
        (mapcat (fn [[table ids]]
                  (when-let [etype (comment-type table)]
                    (for [r (psc/in-chunks #(psc/q db {:select-distinct [:entity_id] :from [:comments]
                                                       :where [:and [:= :entity_type etype]
                                                               [:in :entity_id (mapv str %)]]})
                                           (map second ids))]
                      [[table (psc/->uuid (:entity_id r))] true]))))
        (group-by first ks)))

(defn- doc-comments
  "The documents among `doc-ids` that hold any comment."
  [db doc-ids]
  (into #{} (map (comp psc/->uuid :document_id))
        (psc/in-chunks #(psc/q db {:select-distinct [:document_id] :from [:comments]
                                   :where [:in :document_id (mapv str %)]})
                       doc-ids)))

(defn- live-dependents
  "`{[table id] [dep ...]}`: for each row the entry made, the live rows that
  name it, each `{:k [table id]}`, a child token `{:k .. :inside? true}`, a
  comment `{:k [\"comments\" id]}`. A document's own are read apart."
  [db items]
  (let [made (fn [t] (ids-of items t #{:delete}))
        add (fn [m k dep] (update m k (fnil conj []) dep))
        texts (made "texts")
        tokens (made "tokens")
        spans (made "spans")
        entries (made "vocab_items")
        q (fn [f ids] (psc/in-chunks f ids))
        m (reduce (fn [m r] (add m ["texts" (:text_id r)] {:k ["tokens" (:id r)]}))
                  {}
                  (q #(psc/q db {:select [:id :text_id] :from [:tokens] :where [:in :text_id (mapv str %)]}) texts))
        m (reduce (fn [m r] (add m ["tokens" (:token_id r)] {:k ["spans" (:span_id r)]}))
                  m
                  (q #(psc/q db {:select [:span_id :token_id] :from [:span_tokens] :where [:in :token_id (mapv str %)]}) tokens))
        m (reduce (fn [m r] (add m ["tokens" (:token_id r)] {:k ["vocab_links" (:vocab_link_id r)]}))
                  m
                  (q #(psc/q db {:select [:vocab_link_id :token_id] :from [:vocab_link_tokens]
                                 :where [:in :token_id (mapv str %)]})
                     tokens))
        m (reduce (fn [m r] (add m ["tokens" (:parent r)] {:k ["tokens" (:child r)] :inside? true}))
                  m
                  (q #(psc/q db (into [(str "SELECT p.id AS parent, c.id AS child FROM tokens p"
                                            " JOIN token_layers cl ON cl.parent_token_layer_id = p.token_layer_id"
                                            " JOIN tokens c ON c.token_layer_id = cl.id AND c.text_id = p.text_id"
                                            " AND c.begin >= p.begin AND c.end_ <= p.end_"
                                            " WHERE p.id IN (" (str/join "," (repeat (count %) "?")) ")")]
                                      (map str %))
                             {:uuid-cols #{:parent :child}})
                     tokens))
        m (reduce (fn [m r]
                    (cond-> m
                      (some #{(:source_span_id r)} spans) (add ["spans" (:source_span_id r)] {:k ["relations" (:id r)]})
                      (some #{(:target_span_id r)} spans) (add ["spans" (:target_span_id r)] {:k ["relations" (:id r)]})))
                  m
                  (let [spans (set spans)]
                    (distinct
                     (concat (q #(psc/q db {:select [:id :source_span_id :target_span_id] :from [:relations]
                                            :where [:in :source_span_id (mapv str %)]})
                                spans)
                             (q #(psc/q db {:select [:id :source_span_id :target_span_id] :from [:relations]
                                            :where [:in :target_span_id (mapv str %)]})
                                spans)))))
        m (reduce (fn [m r] (add m ["vocab_items" (:vocab_item_id r)] {:k ["vocab_links" (:id r)]}))
                  m
                  (q #(psc/q db {:select [:id :vocab_item_id] :from [:vocab_links] :where [:in :vocab_item_id (mapv str %)]})
                     entries))
        made-keys (for [i items :when (and (= :delete (:op i)) (not= "documents" (:table i)))] (:k i))
        m (reduce (fn [m k] (add m k {:k ["comments" (second k)]})) m (keys (comments-on db made-keys)))]
    m))

(defn- metadata-refs
  "`{[\"vocab_items\" id] [{:k [table id]} ...]}`: for each entry the entry
  made, the rows whose metadata names it by its id, wherever its vocabulary
  can be used (its other entries, and every row of a document of a project
  linking it), as `plaid.sql.vocab-item` finds what a merge repoints."
  [db items]
  (let [made (filter #(and (= "vocab_items" (:table %)) (= :delete (:op %))) items)]
    (reduce
     (fn [m [vocab-id entries]]
       (let [ids-json (psc/write-json (mapv (comp str :id) entries))
             atom-in "jt.type = 'text' AND jt.atom IN (SELECT value FROM json_each(?))"
             docs-sql (str "SELECT d.id FROM project_vocabs pv CROSS JOIN documents d"
                           " WHERE pv.vocab_layer_id = ? AND d.project_id = pv.project_id")
             rows (concat
                   (for [r (psc/q db [(str "SELECT em.entity_id, jt.atom AS ref"
                                           " FROM vocab_items x CROSS JOIN entity_metadata em, json_tree(em.value) jt"
                                           " WHERE x.vocab_layer_id = ? AND em.entity_type = 'vocab-item'"
                                           " AND em.entity_id = x.id AND " atom-in)
                                      (str vocab-id) ids-json]
                                  {:string-cols #{:entity_id :ref}})]
                     (assoc r :etype "vocab-item"))
                   (mapcat (fn [[etype table col]]
                             (for [r (psc/q db [(str "SELECT em.entity_id, jt.atom AS ref"
                                                     " FROM (" docs-sql ") dd CROSS JOIN " table " x"
                                                     " CROSS JOIN entity_metadata em, json_tree(em.value) jt"
                                                     " WHERE x." col " = dd.id AND em.entity_type = ?"
                                                     " AND em.entity_id = x.id AND " atom-in)
                                                (str vocab-id) etype ids-json]
                                            {:string-cols #{:entity_id :ref}})]
                               (assoc r :etype etype)))
                           [["document" "documents" "id"] ["text" "texts" "document_id"]
                            ["token" "tokens" "document_id"] ["span" "spans" "document_id"]
                            ["relation" "relations" "document_id"] ["vocab-link" "vocab_links" "document_id"]]))]
         (reduce (fn [m {:keys [entity_id ref etype]}]
                   (let [dep [(table-of-etype etype) (psc/->uuid entity_id)]
                         k ["vocab_items" (psc/->uuid ref)]]
                     (if (= dep k) m (update m k (fnil conj []) {:k dep}))))
                 m rows)))
     {}
     (group-by :vocab made))))

(defn- foreign-writes
  "The documents among `doc-ids` that an operation outside the entry wrote
  in since the entry began, as `{doc #{tables}}` (`:op` when an operation
  names the document without writing a row of it, as a media upload does).
  A version bump is no write."
  [db doc-ids unit? start]
  (let [rows (psc/in-chunks #(psc/q db {:select-distinct [:document_id :target_table :op_id]
                                        :from [:audit_writes]
                                        :where [:and [:in :document_id (mapv str %)] [:>= :ts start]
                                                [:<> :change_type bump]]})
                            doc-ids)
        ops (psc/in-chunks #(psc/q db {:select [:document_id :id] :from [:operations]
                                       :where [:and [:in :document_id (mapv str %)] [:>= :ts start]]})
                           doc-ids)]
    (as-> {} m
      (reduce (fn [m r] (if (unit? (:op_id r))
                          m
                          (update m (psc/->uuid (str (:document_id r))) (fnil conj #{}) (:target_table r))))
              m rows)
      (reduce (fn [m r] (if (unit? (:id r)) m (update m (psc/->uuid (str (:document_id r))) (fnil conj #{}) :op)))
              m ops))))

(defn- existing
  "`{table #{id}}`: which of the ids each table names exist now."
  [db wanted]
  (into {}
        (for [[table ids] wanted]
          [table (into #{} (map :id)
                       (psc/in-chunks #(psc/q db (cond-> {:select [:id] :from [(keyword table)]
                                                          :where [:in :id (mapv str %)]}
                                                   (= table "projects")
                                                   (assoc :where [:and [:in :id (mapv str %)] [:= :deleted_at nil]])))
                                      ids))])))

;; ============================================================
;; What each row needs
;; ============================================================

(defn- parents-of
  "The rows `row` (a `before`) of `table` needs, as `[table id]`. Layers and
  projects are named by their tables."
  [table row]
  (case table
    "documents" [["projects" (:project_id row)]]
    "texts" [["documents" (:document_id row)] ["text_layers" (:text_layer_id row)]]
    "tokens" [["documents" (:document_id row)] ["token_layers" (:token_layer_id row)] ["texts" (:text_id row)]]
    "spans" (into [["documents" (:document_id row)] ["span_layers" (:span_layer_id row)]]
                  (map (fn [t] ["tokens" t])) (:tokens row))
    "relations" [["documents" (:document_id row)] ["relation_layers" (:relation_layer_id row)]
                 ["spans" (:source_span_id row)] ["spans" (:target_span_id row)]]
    "vocab_links" (into [["documents" (:document_id row)] ["vocab_items" (:vocab_item_id row)]]
                        (map (fn [t] ["tokens" t])) (:tokens row))
    "vocab_items" [["vocab_layers" (:vocab_layer_id row)]]
    []))

(defn- mentions?
  "Whether `row` names `id` anywhere: a column, its token list, or a string
  atom of its metadata."
  [row id]
  (let [s (str id)
        in-meta (fn walk [v]
                  (cond (string? v) (= v s)
                        (map? v) (some walk (vals v))
                        (sequential? v) (some walk v)
                        :else false))]
    (boolean (or (some #(= id %) (vals (dissoc row :id :tokens :metadata)))
                 (some #(= id %) (:tokens row))
                 (in-meta (:metadata row))))))

(defn- moves-offsets?
  "Whether undoing token item `i` puts offsets on its text."
  [i]
  (case (:op i)
    :insert true
    :update (or (not= (:begin (:before i)) (:begin (:after i)))
                (not= (:end_ (:before i)) (:end_ (:after i))))
    false))

;; ============================================================
;; The plan
;; ============================================================

(defn- base-reason
  "Why `i` is left whatever else the undo does, or nil."
  [i {:keys [may-document? may-vocab? live locked excluded]}]
  (let [live-row (get-in live [(:table i) (:id i)])]
    (cond
      (contains? excluded (:k i)) (get excluded (:k i))
      (and (:doc i) (contains? excluded [:doc (:doc i)])) (get excluded [:doc (:doc i)])
      (= "vocab_layers" (:table i)) {:reason "not-undone"}
      (if (:doc i) (not (may-document? (:doc i))) (not (may-vocab? (:vocab i)))) {:reason "not-permitted"}
      (:changed-between i) {:reason "changed-between"}
      (or (:changed-since i)
          (not= (changes/shape (:table i) live-row) (changes/shape (:table i) (:after i))))
      {:reason "changed-since"}
      (and (:doc i) (contains? locked (:doc i))) {:reason "locked"}
      :else nil)))

(defn- check
  "Why `i` cannot be undone in the state the applied rows leave, or nil.
  `on?` says whether a row is there in that state."
  [i {:keys [applied? item-of on? deps refs foreign doc-commented moving tokens-on rows-in project-of
             vocab-of linked? name-holder]}]
  (let [{:keys [table op before k]} i
        stays? (fn [{dk :k inside? :inside?}]
                 (let [d (item-of dk)]
                   (cond
                     (= "comments" (first dk)) true
                     (and d (applied? d)) (and (not inside?) (not= :delete (:op d)) (mentions? (:before d) (:id i)))
                     :else true)))]
    (case op
      :delete
      (or (when (= table "documents")
            (cond
              (contains? foreign (:id i)) {:reason "built-on"}
              (contains? doc-commented (:id i)) {:reason "built-on"}
              :else (when-let [left (first (remove applied? (get rows-in (:id i))))]
                      {:reason "built-on" :by (row-ref (:k left))})))
          (when-let [d (first (filter stays? (concat (get deps k) (get refs k))))]
            {:reason "built-on" :by (when-not (= "comments" (first (:k d))) (row-ref (:k d)))}))

      (:insert :update)
      (or (when-let [missing (first (remove on? (parents-of table before)))]
            {:reason "needs" :needs (row-ref missing)})
          (when (and (= table "vocab_links") (not (linked? (project-of (:document_id before)) (vocab-of (:vocab_item_id before)))))
            {:reason "needs" :needs {:kind "vocab-layer" :id (vocab-of (:vocab_item_id before))}})
          (when (and (= table "documents")
                     (or (= op :insert) (not= (:name before) (:name (:after i))))
                     (name-holder i))
            {:reason "name-taken"})
          (when (and (= table "texts") (contains? moving (:id i)))
            (or (when (contains? (get foreign (:doc i)) "tokens") {:reason "text-changed-since"})
                (when (contains? (get foreign (:doc i)) "texts") {:reason "text-changed-since"})
                (when-let [left (first (remove applied? (get tokens-on (:id i))))]
                  {:reason "needs" :needs (row-ref (:k left))})))
          (when (and (= table "tokens") (moves-offsets? i) (contains? moving (:text_id before))
                     (not (applied? (item-of ["texts" (:text_id before)]))))
            {:reason "text-changed-since"})))))

(defn- fixpoint
  "`{[table id] reason}` for every row left: the base reasons, then each
  row's checks against what the others leave, until nothing more is left."
  [items ctx]
  (let [base (into {} (keep (fn [i] (when-let [r (base-reason i ctx)] [(:k i) r]))) items)]
    (loop [left base]
      (let [applied? (fn [i] (and i (not (contains? left (:k i)))))
            item-of (:item-of ctx)
            live? (fn [[table id]] (contains? (get (:exists ctx) table) id))
            on? (fn [k]
                  (let [d (item-of k)]
                    (if (and d (applied? d))
                      (not= :delete (:op d))
                      (and (live? k)
                           ;; a row of a document deleted whole goes with it
                           (not (when-let [doc-item (and d (:doc d) (item-of ["documents" (:doc d)]))]
                                  (and (applied? doc-item) (= :delete (:op doc-item)))))))))
            ctx (assoc ctx :applied? applied? :on? on?)
            more (into {} (keep (fn [i]
                                  (when (applied? i)
                                    (when-let [r (check i ctx)] [(:k i) r]))))
                       items)]
        (if (empty? more)
          left
          (recur (merge left more)))))))

;; ============================================================
;; Applying it
;; ============================================================

(defn- meta-of [row] (or (:metadata row) {}))

(defn- last-version
  "The highest version document `doc-id` ever had, from every audit row of
  it, its version bumps among them (the fold leaves those out)."
  [tx doc-id]
  (reduce max 0 (keep #(some-> % hread/parse-image :version)
                      (psc/q tx {:select [:target_table :target_id :document_id :post_image]
                                 :from [:audit_writes]
                                 :where [:and [:= :target_table "documents"] [:= :target_id (str doc-id)]
                                         [:<> :change_type "delete"]]}))))

(defn- insert-document!
  "Insert document row `i` again under its old id, at a version past every
  one it had, so a client holding an old version learns it moved."
  [tx i]
  (let [b (:before i)]
    (crud/insert! tx :documents {:id (:id i)
                                 :name (:name b)
                                 :name_key (names/fold (:name b))
                                 :project_id (:project_id b)
                                 :version (inc (last-version tx (:id i)))
                                 :created_at (:created_at b)
                                 :modified_at (op/op-ts)})
    (when (seq (meta-of b))
      (metadata/insert-metadata! tx "document" (:id i) (meta-of b)))))

(defn- insert-entry! [tx i]
  (let [b (:before i)
        m (meta-of b)]
    (psc/execute! tx {:insert-into :vocab_items
                      :values [{:id (:id i) :form (:form b) :vocab_layer_id (:vocab_layer_id b)}]})
    (metadata/insert-metadata! tx "vocab-item" (:id i) m {:skip-parent-audit? true})
    (psaw/record-audit-write! tx :vocab_items (:id i) :insert nil
                              (cond-> (psc/fetch-by-id tx :vocab_items (:id i)) (seq m) (assoc :metadata m)))))

(defn- set-entry-back!
  "Returns the documents a form set back restates."
  [tx i live]
  (let [b (:before i)
        form? (not= (:form b) (:form live))
        docs (when form? (vocab-item/linked-document-ids tx [(:id i)]))]
    (when form?
      (crud/update-by-id! tx :vocab_items (:id i) {:form (:form b)}))
    (when (not= (meta-of b) (meta-of live))
      (metadata/replace-metadata! tx "vocab-item" (:id i) (meta-of b)))
    docs))

(defn- document-plan
  "Document restore's plan for the rows of one document the undo applies."
  [doc-items live]
  (let [by-table (group-by :table doc-items)
        cur (fn [t] (vec (keep #(when (#{:delete :update} (:op %)) (get-in live [t (:id %)])) (get by-table t))))
        tgt (fn [t] (vec (keep #(when (#{:insert :update} (:op %)) (:before %)) (get by-table t))))
        doc-row (first (filter #(= :update (:op %)) (get by-table "documents")))
        doc-live (when doc-row (get-in live ["documents" (:id doc-row)]))]
    {:plan {:name (when (and doc-row (not= (:name (:before doc-row)) (:name doc-live))) (:name (:before doc-row)))
            :document-metadata? (boolean (and doc-row (not= (meta-of (:before doc-row)) (meta-of doc-live))))
            :document-metadata (meta-of (:before doc-row))
            :texts (restore/diff-table :texts (cur "texts") (tgt "texts"))
            :tokens (restore/diff-table :tokens (cur "tokens") (tgt "tokens"))
            :spans (restore/diff-table :spans (cur "spans") (tgt "spans"))
            :relations (restore/diff-table :relations (cur "relations") (tgt "relations"))
            :vocab_links (restore/diff-table :vocab_links (cur "vocab_links") (tgt "vocab_links"))}
     :current {:texts (cur "texts") :tokens (cur "tokens") :spans (cur "spans")
               :relations (cur "relations") :vocab-links (cur "vocab_links")}}))

(defn- apply!
  "Write the applied rows. Returns the documents to check: every document
  written that still stands."
  [tx applied live]
  (let [of (fn [table op] (filter #(and (= table (:table %)) (= op (:op %))) applied))
        doc-deletes (set (map :id (of "documents" :delete)))
        bumped (atom #{})]
    (doseq [i (of "documents" :insert)]
      (insert-document! tx i))
    (doseq [i (of "vocab_items" :insert)]
      (insert-entry! tx i))
    (doseq [i (of "vocab_items" :update)]
      (swap! bumped into (set-entry-back! tx i (get-in live ["vocab_items" (:id i)]))))
    (let [per-doc (->> applied
                       (filter #(and (:doc %) (not (contains? doc-deletes (:doc %)))))
                       (remove #(and (= "documents" (:table %)) (= :insert (:op %))))
                       (group-by :doc)
                       (sort-by (comp str key)))]
      (doseq [[doc-id doc-items] per-doc]
        (let [{:keys [plan current]} (document-plan doc-items live)]
          (restore/apply-plan! tx doc-id plan current)))
      (doseq [d (sort-by str doc-deletes)]
        (document/cascade-delete! tx d))
      (let [entries (map :id (of "vocab_items" :delete))]
        (when (seq entries)
          (vocab-item/delete-items! tx entries)))
      (let [inserted (set (map :id (of "documents" :insert)))
            written (into (set (map key per-doc)) inserted)]
        (op/bump-document-versions! tx (remove inserted (into written (remove doc-deletes @bumped))))
        (op/touch-vocab-layers! tx (distinct (keep #(when (= "vocab_items" (:table %)) (:vocab %)) applied)))
        (sort-by str written)))))

(defn- misfits
  "`{key reason}` of what the written state breaks: a document that does not
  fit (`[:doc id]`), or a row whose value a closed list refuses."
  [tx docs applied-keys]
  (let [docs-bad (into {} (keep (fn [d] (when-let [e (restore/final-state-violation tx d)]
                                          (log/info "Undo leaves document" d ":" (ex-message e))
                                          [[:doc d] {:reason "does-not-fit"}])))
                       docs)
        vs (constraints/pending-violations tx)
        rows-bad (for [v vs
                       :let [table (if (= :span (:kind (:layer v))) "spans" "relations")
                             ks (map (fn [id] [table (psc/->uuid (str id))]) (:ids v))]
                       :when (and (= "value-set" (:type v)) (every? applied-keys ks))
                       k ks]
                   [k {:reason "value-not-allowed"}])
        other (for [v vs
                    :when (not (and (= "value-set" (:type v))
                                    (every? applied-keys (map (fn [id] [(if (= :span (:kind (:layer v))) "spans" "relations")
                                                                        (psc/->uuid (str id))])
                                                              (:ids v)))))
                    :when (:document v)]
                [[:doc (psc/->uuid (str (:document v)))] {:reason "does-not-fit"}])]
    (merge docs-bad (into {} rows-bad) (into {} other))))

;; ============================================================
;; The summary
;; ============================================================

(defn- place [i]
  (if (:doc i) {:document (:doc i)} {:vocab-layer (:vocab i)}))

(defn- summarize [items left]
  (let [applied (remove #(contains? left (:k %)) items)
        tally (fn [kind]
                (let [xs (filter #(= kind (kind-of (:table %))) applied)
                      n (fn [o] (count (filter #(= o (:op %)) xs)))]
                  {:inserted (n :insert) :updated (n :update) :deleted (n :delete)}))
        skipped (for [i items :let [r (get left (:k i))] :when r]
                  (merge {:kind (kind-of (:table i)) :id (:id i)} (place i) r))]
    {:undone {:documents (tally "document") :texts (tally "text") :tokens (tally "token")
              :spans (tally "span") :relations (tally "relation") :vocab-links (tally "vocab-link")
              :vocab-items (tally "vocab-item")}
     :total (count applied)
     :skipped (vec (take max-listed skipped))
     :skipped-count (count skipped)}))

;; ============================================================
;; One attempt, inside the transaction
;; ============================================================

(defn- link-vocab
  "A function of an entry id giving its vocabulary: from the entry's own
  rows, the live table, or the last audit row of the entry."
  [db items entry-ids]
  (let [from-items (into {} (keep (fn [i] (when (= "vocab_items" (:table i)) [(:id i) (:vocab i)]))) items)
        wanted (remove from-items entry-ids)
        live (into {} (map (juxt :id :vocab_layer_id)) (psc/fetch-ids db :vocab_items (mapv str wanted)))
        gone (remove live wanted)
        logged (into {} (map (fn [r] [(psc/->uuid (:target_id r)) (psc/->uuid (:vocab_layer_id r))]))
                     (psc/in-chunks #(psc/q db {:select-distinct [:target_id :vocab_layer_id] :from [:audit_writes]
                                                :where [:and [:= :target_table "vocab_items"]
                                                        [:in :target_id (mapv str %)]
                                                        [:<> :vocab_layer_id nil]]}
                                            {:string-cols #{:target_id :vocab_layer_id}})
                                    gone))]
    (merge logged live from-items)))

(defn- not-undone-ops
  "The operations of the entry that wrote rows undo does not take back (a
  project's, a layer's, a user's), as `[{:op-type :count}]`."
  [db ops]
  (->> (psc/in-chunks #(psc/q db {:select-distinct [:o.id :o.op_type]
                                  :from [[:audit_writes :aw]]
                                  :join [[:operations :o] [:= :o.id :aw.op_id]]
                                  :where [:and [:in :aw.op_id (mapv str %)]
                                          [:not-in :aw.target_table ["documents" "texts" "tokens" "spans" "relations"
                                                                     "vocab_links" "vocab_items" "vocab_layers"]]]})
                      (map :id ops))
       (map :op_type)
       frequencies
       (sort-by key)
       (mapv (fn [[t n]] {:op-type t :count n}))))

(defn- attempt!
  "Plan, and unless `plan-only?`, write. Returns `{:items :left :written}`
  or `{:too-many n}`."
  [tx entry-id {:keys [document-id vocab-id user excluded may-document? may-vocab?]}]
  (let [{:keys [ops rows]} (changes/unit-rows tx entry-id {:document-id document-id})
        unit-ids (into #{} (map (comp str :id)) ops)
        unit? #(contains? unit-ids (str %))
        start (str (:ts (first ops)))
        items (mapv item rows)
        entry-vocab (link-vocab tx items (distinct (keep (fn [i] (when (= "vocab_links" (:table i))
                                                                   (or (:vocab_item_id (:before i))
                                                                       (:vocab_item_id (:after i)))))
                                                         items)))
        items (cond->> items
                vocab-id (filterv (fn [i]
                                    (case (:table i)
                                      ("vocab_items" "vocab_layers") (= vocab-id (:vocab i))
                                      "vocab_links" (some #(= vocab-id (entry-vocab %))
                                                          [(:vocab_item_id (:before i)) (:vocab_item_id (:after i))])
                                      false))))]
    (if (> (count items) max-rows)
      {:too-many (count items) :ops ops}
      (let [by-table (group-by :table items)
            live (into {} (for [[t is] by-table] [t (live-rows tx t (map :id is))]))
            item-of (into {} (map (juxt :k identity)) items)
            docs (distinct (keep :doc items))
            locked (into #{} (filter #(not= :ok (locks/check-document-locks [%] user))) docs)
            deps (live-dependents tx items)
            refs (metadata-refs tx items)
            made-docs (ids-of items "documents" #{:delete})
            foreign (foreign-writes tx docs unit? start)
            moving (into #{} (comp (filter #(and (= "texts" (:table %)) (= :update (:op %))
                                                 (not= (:body (:before %)) (:body (:after %)))))
                                   (map :id))
                         items)
            tokens-on (group-by (fn [i] (:text_id (or (:before i) (:after i))))
                                (filter #(= "tokens" (:table %)) items))
            rows-in (group-by :doc (filter #(and (:doc %) (not= "documents" (:table %))) items))
            wanted (reduce (fn [m [t id]] (if id (update m t (fnil conj #{}) id) m))
                           {}
                           (concat (for [i items :when (#{:insert :update} (:op i)) p (parents-of (:table i) (:before i))] p)
                                   (for [i items] [(:table i) (:id i)])))
            exists (existing tx wanted)
            project-of (let [m (into {} (map (juxt :id :project_id)) (vals (get live "documents")))
                             from-items (into {} (keep (fn [i] (when (= "documents" (:table i))
                                                                 [(:id i) (:project_id (or (:before i) (:after i)))])))
                                              items)
                             more (remove (merge from-items m) (distinct (keep #(when (= "vocab_links" (:table %)) (:doc %)) items)))
                             fetched (into {} (map (juxt :id :project_id)) (psc/fetch-ids tx :documents (mapv str more)))]
                         (merge fetched from-items m))
            item-vocab (link-vocab tx items (distinct (keep #(when (= "vocab_links" (:table %)) (:vocab_item_id (:before %))) items)))
            pv (into #{} (map (juxt :project_id :vocab_layer_id))
                     (psc/in-chunks #(psc/q tx {:select [:project_id :vocab_layer_id] :from [:project_vocabs]
                                                :where [:in :project_id (mapv str %)]})
                                    (remove nil? (vals project-of))))
            ctx {:may-document? may-document? :may-vocab? may-vocab? :live live :locked locked
                 :excluded excluded :item-of item-of :exists exists :deps deps :refs refs
                 :foreign foreign :doc-commented (doc-comments tx made-docs) :moving moving
                 :tokens-on tokens-on :rows-in rows-in :project-of project-of :vocab-of item-vocab
                 :linked? (fn [p v] (contains? pv [p v]))
                 :name-holder (fn [i] (names/held tx (:project_id (:before i)) (:name (:before i)) (:id i)))}
            left (fixpoint items ctx)
            applied (remove #(contains? left (:k %)) items)]
        {:ops ops
         :items items
         :left left
         :applied applied
         :live live}))))

;; ============================================================
;; Public API
;; ============================================================

(defn entry-label
  "The words an undo's description names its entry by: the group's message,
  else the first operation's description."
  [db entry-id ops]
  (or (:message (psc/q1 db {:select [:message] :from [:operation_groups] :where [:= :id (str entry-id)]}))
      (:description (psc/q1 db {:select [:description] :from [:operations]
                                :where [:= :id (str (:id (first ops)))]}))
      (str entry-id)))

(defn undo
  "Undo entry `entry-id` as one operation of type `audit-entry/undo`, or with
  `:dry-run?` say what that would do without writing. nil when no entry has
  that id (`plaid.history.changes/unit-ops`).

  Options: `:user`, `:document-id` (only that document's rows),
  `:vocab-id` (only that vocabulary's entries, and the links naming one of
  them), `:may-document?` and `:may-vocab?` (may the caller maintain a
  document's rows, a vocabulary's entries), `:dry-run?`.

  Returns `{:summary {...}}`, where the summary has `:undone` (per kind,
  `{:inserted :updated :deleted}`), `:total`, `:skipped` (`{:kind :id
  :document|:vocab-layer :reason}`, with `:by` or `:needs` naming a row, the
  first `max-listed`), `:skipped-count`, `:not-undone` (the entry's operations
  that wrote what undo does not take back), `:permitted` (how many rows the
  caller may maintain), and on a real call that wrote, `:operation` (the
  undo's own id). `:documents` names the documents whose versions moved.
  `{:error msg :code n}` when it could not be done."
  [db entry-id {:keys [user dry-run?] :as opts}]
  (let [ops (changes/unit-ops db entry-id)]
    (when (seq ops)
      (let [description (str "Undo entry " entry-id ": " (entry-label db entry-id ops))
            project (some :project_id ops)
            not-undone (not-undone-ops db ops)]
        (loop [excluded {}
               n 1]
          (let [out (atom nil)
                result (op/submit-operation*
                        db
                        {:type :audit-entry/undo
                         :project project
                         :document nil
                         :description description
                         :user user
                         :unrecorded-if-empty? true}
                        (fn [tx]
                          (let [{:keys [too-many items left applied live] :as a}
                                (attempt! tx entry-id (assoc opts :excluded excluded))]
                            (if too-many
                              (do (reset! out a)
                                  (throw (ex-info "too many" {:code 413})))
                              (let [written (when (seq applied) (apply! tx applied live))
                                    bad (when (seq applied)
                                          (misfits tx written (into #{} (map :k) applied)))]
                                (reset! out (assoc a :bad bad))
                                (cond
                                  (seq bad) (throw (ex-info "misfit" {:code 409 ::retry true}))
                                  dry-run? (throw (ex-info "dry run" {:code 409 ::dry-run true}))
                                  :else (when (seq applied) (:id psaw/*op*))))))))
                {:keys [too-many items left bad]} @out]
            (cond
              too-many
              {:error (str "This entry changed " too-many " rows. An undo takes at most " max-rows ".")
               :code 413}

              (seq bad)
              (if (< n max-attempts)
                (recur (merge excluded bad) (inc n))
                (do (log/error "Undo of" entry-id "still misfit after" n "attempts:" (pr-str bad))
                    {:error "Internal error" :code 500}))

              (and (not (:success result)) (not dry-run?))
              {:error (:error result) :code (:code result)}

              (and (not (:success result)) (nil? items))
              {:error (:error result) :code (:code result)}

              :else
              (let [summary (summarize items left)
                    {:keys [may-document? may-vocab?]} opts
                    permitted (count (filter #(if (:doc %) (may-document? (:doc %)) (may-vocab? (:vocab %))) items))
                    operation (when (and (not dry-run?) (:success result)) (:extra result))]
                (when operation
                  (doseq [d (keep #(when (and (= "documents" (:table %)) (= :delete (:op %))
                                              (not (contains? left (:k %))))
                                     (:id %))
                                  items)]
                    (when (media/media-exists? d)
                      (try (media/delete-media-file! d)
                           (catch Exception e (log/warn e "Failed to delete media file for" d))))))
                {:summary (cond-> (assoc summary
                                         :entry entry-id
                                         :dry-run (boolean dry-run?)
                                         :rows (count items)
                                         :permitted permitted
                                         :not-undone not-undone)
                            operation (assoc :operation operation))
                 :documents (when operation (:documents result))}))))))))
