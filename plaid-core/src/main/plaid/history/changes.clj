(ns plaid.history.changes
  "What one audit unit changed, row by row.

  A unit is what an audit entry is (`plaid.sql.audit`): a logical group, else
  an atomic batch, else one operation, named by its id (`:audit/id`, the
  `?entry-id=` of every audit read). Its rows are every row of a document or
  a vocabulary that one of its operations wrote, each with

    `:before`  the row just before the unit's FIRST write to it, absent when
               the unit made it,
    `:after`   the row just after the unit's LAST write to it, absent when the
               unit deleted it,
    `:changed-since`    whether an operation after the unit's last write to
                        the row changed it,
    `:changed-between`  whether an operation outside the unit changed it
                        between the unit's first and last write to it.

  Per row, never \"the document at the start against the document at the
  end\": a group is not contiguous, and other people write between its
  batches. Their writes are not the unit's rows, and where they wrote one of
  the unit's rows in between, `:changed-between` says so.

  Each image is the entity a deep read serves for that row
  (`plaid.sql.document-rows`, the builders the live and the as-of read share),
  so a client draws it as it draws a past document. A document's own row is
  its name, project and metadata, a vocabulary's its name, project and
  configuration: versions and modification times are left out, since every
  write moves them. A row that shows the same before and after (written and
  written back, or touched only in its time) is left out, and \"changed\"
  means the same thing: what the image shows changed.

  Rows of other tables (layers, projects, people) are not listed: a unit's
  rows here are the rows of documents and vocabularies, which is what a reader
  of either can be given row by row.

  Rows come in two runs, each in a fixed order, so a page cursor stays good
  while the unit, or anything else, goes on writing:
    1. every row the unit wrote that the audit log names, at the place of the
       unit's first write to it (`ts`, `seq`);
    2. the rows an import made in a document the unit created that no audit
       row names, or that were recorded whole only later
       (`plaid.sql.audit-write`, \"Lazy rows\"), by document, table and id.

  Cost: a page walks the unit's own audit rows from its cursor
  (`idx_audit_writes_op_seq`) and reads the whole history of each row on it
  (`idx_audit_writes_target`), so a page costs its rows times the depth of
  their histories. A document's version bumps are not read."
  (:require [plaid.history.read :as hread]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.common :as psc]
            [plaid.sql.document-rows :as drows]
            [plaid.sql.pagination :as pagination]))

(def ^:private kind-of
  {"documents" "document" "texts" "text" "tokens" "token" "spans" "span"
   "relations" "relation" "vocab_links" "vocab-link" "vocab_items" "vocab-item"
   "vocab_layers" "vocab-layer"})

(def ^:private tables (vec (keys kind-of)))

(def ^:private lazy-tables
  "The tables of a document's own rows, in the order the second run reads them."
  ["texts" "tokens" "spans" "relations" "vocab_links"])

(def ^:private layer-column
  {"texts" :text_layer_id "tokens" :token_layer_id "spans" :span_layer_id
   "relations" :relation_layer_id})

(def ^:private bump "doc-version-bump")

(def ^:private ops-per-step 200)
(def ^:private rows-per-step 500)

;; ============================================================
;; The unit
;; ============================================================

(defn unit-ops
  "The operations of unit `unit-id` (`{:id :ts :project_id}`, oldest first),
  found as the audit reads find a unit's members: by its group, else its
  batch, else the operation itself. An operation of a project being removed,
  or removed, is left out, as every audit read leaves it out."
  [db unit-id]
  (let [id (str unit-id)
        live [:or [:= [:raw "+project_id"] nil]
              [:in [:raw "+project_id"] {:select [:id] :from [:projects] :where [:= :deleted_at nil]}]]
        branch (fn [w] {:select [:id :ts :project_id] :from [:operations] :where [:and w live]})]
    (psc/q db {:union [(branch [:= :group_id id])
                       (branch [:and [:= :batch_id id] [:= :group_id nil]])
                       (branch [:and [:= :id id] [:= :group_id nil] [:= :batch_id nil]])]
               :order-by [:ts]})))

(defn unit-scopes
  "`{:projects #{...} :documents #{...} :vocabs #{...}}`: the projects the
  unit's operations name, and the documents and vocabularies its rows are
  in. Reads every audit row of the unit, so it is for a gate that the
  projects alone did not settle."
  [db ops]
  (let [rows (psc/in-chunks #(psc/q db {:select-distinct [:document_id :vocab_layer_id]
                                        :from [:audit_writes]
                                        :where [:in :op_id (vec %)]})
                            (map :id ops))]
    {:projects (into #{} (keep :project_id) ops)
     :documents (into #{} (keep :document_id) rows)
     :vocabs (into #{} (keep :vocab_layer_id) rows)}))

(defn document-project
  "The project of document `doc-id`: its row's, or for a document deleted
  since, the one its creation recorded (a document never changes project)."
  [db doc-id]
  (or (:project_id (psc/q1 db {:select [:project_id] :from [:documents] :where [:= :id (str doc-id)]}))
      (some-> (psc/q1 db {:select [:target_table :target_id :document_id :post_image]
                          :from [:audit_writes]
                          :where [:and [:= :target_table "documents"] [:= :target_id (str doc-id)]
                                  [:= :change_type "insert"]]
                          :limit 1})
              hread/parse-image
              :project_id)))

;; ============================================================
;; Images
;; ============================================================

(defn- fold
  "The row as `rows` (one target's audit rows, in order) leave it, or nil
  when they leave it absent."
  [rows]
  (reduce (fn [m r]
            (if (= "delete" (:change_type r))
              nil
              (merge m (hread/parse-image r))))
          nil rows))

(defn- with-metadata [built row]
  (let [m (:metadata row)]
    (if (and (map? m) (seq m)) (assoc built :metadata m) built)))

(defn- entity
  "The deep-read entity of folded row `raw` of `table`, or nil. `item-by-id`
  gives a link's entry row."
  [table raw item-by-id]
  (when raw
    (let [r (hread/coerce-entity raw)]
      (case table
        "documents" (with-metadata {:document/id (:id r)
                                    :document/name (:name r)
                                    :document/project (:project_id r)}
                      r)
        "texts" (drows/text-entity r)
        "tokens" (drows/token-entity r)
        "spans" (drows/span-entity r)
        "relations" (drows/relation-entity r)
        "vocab_links" (drows/link-entity r item-by-id)
        "vocab_items" (with-metadata {:vocab-item/id (:id r)
                                      :vocab-item/layer (:vocab_layer_id r)
                                      :vocab-item/form (:form r)}
                        r)
        "vocab_layers" {:vocab/id (:id r)
                        :vocab/name (:name r)
                        :vocab/project (:project_id r)
                        :config (psc/parse-config (:config r))}))))

(defn- shape
  "What the row shows, for telling whether a write changed it: its entity,
  with a link's entry named by id alone (an entry renamed is the entry's
  change, not the link's)."
  [table raw]
  (entity table raw (constantly {})))

;; ============================================================
;; One row's change, from its whole history
;; ============================================================

(defn- position [r] [(str (:ts r)) (long (:seq r))])

(defn- histories
  "`{[table id] [audit row ...]}`: every audit row of each of `targets`
  (`[table id]` pairs), in (ts, seq) order, a document's version bumps
  left out."
  [db targets]
  (->> (group-by first targets)
       (mapcat (fn [[table ts]]
                 (psc/in-chunks #(psc/q db {:select [:target_table :target_id :change_type :post_image
                                                     :document_id :vocab_layer_id :ts :seq :op_id]
                                            :from [:audit_writes]
                                            :where [:and
                                                    [:= :target_table table]
                                                    [:in :target_id (vec %)]
                                                    [:<> :change_type bump]]
                                            :order-by [:ts :seq]})
                                (map second ts))))
       (group-by (fn [r] [(:target_table r) (str (:target_id r))]))
       (into {} (map (fn [[k v]] [k (vec v)])))))

(defn- changed-at?
  "Did row `i` of `hist` change what the row shows? `prev` and `cur` are
  the folds before and after it."
  [table prev cur]
  (not= (shape table prev) (shape table cur)))

(defn- row-change
  "The unit's change to one row, from its whole history `hist`, or nil when
  the unit did not write it. `unit?` says whether an operation id is the
  unit's."
  [table hist unit?]
  (let [idx (into [] (keep-indexed (fn [i r] (when (unit? (:op_id r)) i))) hist)]
    (when (seq idx)
      (let [first-i (first idx)
            last-i (peek idx)
            ;; the fold after each row from the unit's first write on
            folds (reductions (fn [m r] (if (= "delete" (:change_type r)) nil (merge m (hread/parse-image r))))
                              (fold (subvec hist 0 first-i))
                              (subvec hist first-i))
            folds (vec folds)
            ;; folds[k] is the state before hist[first-i + k]
            state-before (fn [i] (folds (- i first-i)))
            state-after (fn [i] (folds (inc (- i first-i))))
            others-changed? (fn [from to]
                              (boolean (some (fn [i]
                                               (and (not (unit? (:op_id (hist i))))
                                                    (changed-at? table (state-before i) (state-after i))))
                                             (range from to))))]
        {:first (hist first-i)
         :before-pos (position (hist first-i))
         :after-pos (position (hist last-i))
         :before (state-before first-i)
         :after (state-after last-i)
         :changed-between (others-changed? (inc first-i) last-i)
         :changed-since (others-changed? (inc last-i) (count hist))}))))

;; ============================================================
;; Entries
;; ============================================================

(defn- item-lookup
  "A function of an entry id and a position, giving the entry's row as the
  log had it at that position (`:<` strictly before it, `:<=` up to and
  including it), from `item-hists`."
  [item-hists]
  (fn [item-id pos inclusive?]
    (let [rows (get item-hists ["vocab_items" (str item-id)])
          upto (take-while (fn [r] (let [c (compare (position r) pos)]
                                     (if inclusive? (<= c 0) (neg? c))))
                           rows)]
      (fold upto))))

(defn- place
  "The ids that place a row: its document or vocabulary, and its layer, and a
  token's text. Every one of these columns is fixed for the life of a row."
  [table id raw]
  (let [r (hread/coerce-entity raw)]
    (cond-> {}
      (= table "documents") (assoc :document (psc/->uuid id))
      (psaw/document-table? table) (assoc :document (:document_id r))
      (= table "vocab_items") (assoc :vocab-layer (:vocab_layer_id r))
      (= table "vocab_layers") (assoc :vocab-layer (psc/->uuid id))
      (layer-column table) (assoc :layer (get r (layer-column table)))
      (= table "tokens") (assoc :text (:text_id r)))))

(defn- entry
  "The listed form of `change` to row `id` of `table`, or nil when the row
  shows the same before and after. `item-at` reads an entry's row at a
  position."
  [table id {:keys [before after before-pos after-pos changed-since changed-between]} item-at]
  (when (not= (shape table before) (shape table after))
    (let [items (fn [pos inclusive?] (fn [item-id] (some-> (item-at item-id pos inclusive?) hread/coerce-entity)))
          b (entity table before (items before-pos false))
          a (entity table after (items after-pos true))]
      (cond-> (merge {:kind (kind-of table)
                      :id (psc/->uuid id)
                      :changed-since changed-since
                      :changed-between changed-between}
                     (place table id (or after before)))
        b (assoc :before b)
        a (assoc :after a)))))

(defn- link-items
  "The entry ids the links among `changes` name, before or after."
  [changes]
  (into #{}
        (comp (filter #(= "vocab_links" (:table %)))
              (mapcat (juxt (comp :vocab_item_id :before) (comp :vocab_item_id :after)))
              (remove nil?)
              (map str))
        changes))

(defn- entries-of
  "Entries for `changes` (`{:table :id ...}` maps from `row-change`), in
  their order, each with its `:pos`, keeping those `keep?` passes."
  [db changes keep?]
  (let [item-at (item-lookup (histories db (map (fn [i] ["vocab_items" i]) (link-items changes))))]
    (into []
          (keep (fn [{:keys [table id pos] :as c}]
                  (when-let [e (entry table id c item-at)]
                    (when (keep? e)
                      (assoc e ::pos pos)))))
          changes)))

;; ============================================================
;; Run 1: the rows the audit log names, at the unit's first write to each
;; ============================================================

(defn- beyond [[ts sq]]
  [:or [:> :ts ts] [:and [:= :ts ts] [:> :seq sq]]])

(defn- walk-rows
  "Up to `rows-per-step` of the unit's own audit rows (not lazy records, not
  version bumps) beyond `pos`, from the operations `op-ids`, in (ts, seq)
  order."
  [db op-ids pos narrow]
  (psc/q db {:select [:target_table :target_id :ts :seq]
             :from [:audit_writes]
             :where (cond-> [:and
                             [:in :op_id (vec op-ids)]
                             [:>= :seq 0]
                             [:<> :change_type bump]
                             [:in :target_table tables]]
                      pos (conj (beyond pos))
                      narrow (conj narrow))
             :order-by [:ts :seq]
             :limit rows-per-step}))

(defn- run-1
  "Entries of the first run beyond position `pos` (nil for the start), at
  most `n`. Returns `[entries done?]`."
  [db ops unit? pos n narrow keep?]
  (loop [pos pos
         out []]
    (let [ahead (->> ops
                     (drop-while #(and pos (neg? (compare (str (:ts %)) (first pos)))))
                     (take ops-per-step))]
      (if (empty? ahead)
        [out true]
        (let [rows (walk-rows db (map :id ahead) pos narrow)
              hists (histories db (distinct (map (fn [r] [(:target_table r) (str (:target_id r))]) rows)))
              changes (keep (fn [r]
                              (let [k [(:target_table r) (str (:target_id r))]
                                    c (row-change (first k) (get hists k []) unit?)]
                                ;; listed here only at the unit's first write to
                                ;; it, which a lazy record (seq < 0) never is
                                (when (and c (= (position (:first c)) (position r)))
                                  (assoc c :table (first k) :id (second k) :pos (position r)))))
                            rows)
              out (into out (entries-of db changes keep?))]
          (cond
            (>= (count out) n) [(subvec out 0 n) false]
            (= (count rows) rows-per-step) (recur (position (peek (vec rows))) out)
            ;; these operations are done: on past the last of them
            :else (let [last-ts (str (:ts (last ahead)))
                        more? (some #(pos? (compare (str (:ts %)) last-ts)) ops)]
                    (if more?
                      (recur [last-ts Long/MAX_VALUE] out)
                      [out true]))))))))

;; ============================================================
;; Run 2: an import's rows the log names late or not at all
;; ============================================================

(defn- created-documents
  "`[{:doc id-string :op creating-op-id}]`, by document id: the documents the
  unit created."
  [db op-ids]
  (->> (psc/in-chunks #(psc/q db {:select [:target_id :op_id]
                                  :from [:audit_writes]
                                  :where [:and
                                          [:in :op_id (vec %)]
                                          [:= :target_table "documents"]
                                          [:= :change_type "insert"]]})
                      op-ids)
       (map (fn [r] {:doc (str (:target_id r)) :op (:op_id r)}))
       (sort-by :doc)))

(defn- named-ids
  "The ids among `ids` (strings) of `table` that some audit row names."
  [db table ids]
  (into #{}
        (map (comp str :target_id))
        (psc/in-chunks #(psc/q db {:select-distinct [:target_id] :from [:audit_writes]
                                   :where [:and [:= :target_table table] [:in :target_id (vec %)]]})
                       ids)))

(defn- lazy-ids
  "Up to `n` ids of `table` in document `doc` beyond `after`, in id order,
  that the unit made without an audit row: recorded whole later under the
  creating operation `op` (a negative seq), or never recorded and still
  there. Returns `[ids live-unrecorded done?]`."
  [db doc op table after n]
  (let [recorded (mapv (comp str :target_id)
                       (psc/q db {:select [:target_id] :from [:audit_writes]
                                  :where [:and [:= :op_id op] [:< :seq 0]
                                          [:= :target_table table] [:= :document_id doc]
                                          (when after [:> :target_id after])]
                                  :order-by [:target_id] :limit n}))
        live (mapv (comp str :id)
                   (psc/q db {:select [:id] :from [(keyword table)]
                              :where [:and [:= :document_id doc] (when after [:> :id after])]
                              :order-by [:id] :limit n}))
        ;; each list is complete up to its last id only when it came back short
        bound (->> [(when (= n (count recorded)) (peek recorded))
                    (when (= n (count live)) (peek live))]
                   (remove nil?)
                   sort
                   first)
        upto (fn [ids] (if bound (filterv #(<= (compare % bound) 0) ids) ids))
        named (named-ids db table live)
        unrecorded (into #{} (remove named) (upto live))]
    [(vec (sort (into (set (upto recorded)) unrecorded))) unrecorded (nil? bound) bound]))

(defn- run-2
  "Entries of the second run beyond `pos` (`[doc table id]`, nil for the
  start), at most `n`. Returns `[entries done?]`."
  [db ops unit? pos n only-doc keep-doc? keep?]
  (let [unit-end [(str (:ts (last ops))) Long/MAX_VALUE]
        docs (cond->> (created-documents db (map :id ops))
               only-doc (filter #(= (str only-doc) (:doc %))))
        [pdoc ptable pid] pos
        steps (for [{:keys [doc op]} docs
                    :when (or (nil? pdoc) (>= (compare doc pdoc) 0))
                    :when (keep-doc? doc)
                    table lazy-tables
                    :when (or (nil? pdoc) (pos? (compare doc pdoc))
                              (>= (.indexOf ^java.util.List lazy-tables table)
                                  (.indexOf ^java.util.List lazy-tables ptable)))]
                {:doc doc :op op :table table
                 :after (when (and (= doc pdoc) (= table ptable)) pid)})]
    (loop [steps steps
           after nil
           out []]
      (if-let [{:keys [doc op table] :as step} (first steps)]
        (let [after (or after (:after step))
              [ids unrecorded done? bound] (lazy-ids db doc op table after rows-per-step)
              recorded (remove unrecorded ids)
              hists (histories db (map (fn [i] [table i]) recorded))
              live (update-keys (psaw/entity-images db table unrecorded) str)
              changes (keep (fn [i]
                              (if (contains? unrecorded i)
                                {:table table :id i :pos [doc table i]
                                 :before nil
                                 :after (get live i)
                                 :after-pos unit-end
                                 :changed-since false :changed-between false}
                                (some-> (row-change table (get hists [table i] []) unit?)
                                        (assoc :table table :id i :pos [doc table i]))))
                            ids)
              out (into out (entries-of db changes keep?))]
          (cond
            (>= (count out) n) [(subvec out 0 n) false]
            done? (recur (rest steps) nil out)
            :else (recur steps bound out)))
        [out true]))))

;; ============================================================
;; The read
;; ============================================================

(defn- parse-cursor
  "`[:run-1 [ts seq]]` or `[:run-2 [doc table id]]` from a decoded cursor,
  or a 400."
  [vals]
  (let [bad #(throw (ex-info "Invalid pagination cursor" {:code 400}))]
    (case (first vals)
      nil [:run-1 nil]
      "a" (let [[_ ts sq] vals]
            (if-let [n (and (string? ts) (some-> sq str parse-long))] [:run-1 [ts n]] (bad)))
      "b" (let [[_ doc table id] vals]
            (if (and (string? doc) (some #{table} lazy-tables) (string? id))
              [:run-2 [doc table id]]
              (bad)))
      (bad))))

(defn changes-page
  "One page of the rows unit `unit-id` changed, in the uniform envelope
  `{:entries [...] :next-cursor vals-or-nil}`, or nil when no unit has that
  id (none of its operations is left, see `unit-ops`).

  Options:
    `:limit` `:cursor-vals`   the page (default 100, at most 1000);
    `:document-id`            only the rows of that document;
    `:vocab-id`               only the rows of that vocabulary (its entries
                              and itself);
    `:readable-document?`     a predicate on a document id: a row of a
                              document it refuses is left out (nil: all);
    `:readable-vocab?`        the same for a vocabulary id.

  Each entry: `:kind` (document, text, token, span, relation, vocab-link,
  vocab-item, vocab-layer), `:id`, `:document` or `:vocab-layer`, `:layer`
  (texts, tokens, spans, relations), `:text` (tokens), `:before` and
  `:after` where the row was there, `:changed-since`, `:changed-between`."
  [db unit-id {:keys [limit cursor-vals document-id vocab-id readable-document? readable-vocab?]}]
  (let [ops (unit-ops db unit-id)]
    (when (seq ops)
      (let [n (pagination/clamp-limit limit)
            unit-ids (into #{} (map :id) ops)
            unit? #(contains? unit-ids %)
            readable-document? (or readable-document? (constantly true))
            readable-vocab? (or readable-vocab? (constantly true))
            keep? (fn [e] (if-let [d (:document e)]
                            (readable-document? d)
                            (readable-vocab? (:vocab-layer e))))
            narrow (cond
                     document-id [:= :document_id (str document-id)]
                     vocab-id [:= :vocab_layer_id (str vocab-id)])
            [run pos] (parse-cursor cursor-vals)
            [out1 done1?] (if (= run :run-1)
                            (run-1 db ops unit? pos n narrow keep?)
                            [[] true])
            [out2 _] (if (and done1? (< (count out1) n) (not vocab-id))
                       (run-2 db ops unit? (when (= run :run-2) pos) (- n (count out1))
                              document-id #(readable-document? (psc/->uuid %)) keep?)
                       [[] true])
            out (into out1 out2)
            lst (peek out)]
        {:entries (mapv #(dissoc % ::pos) out)
         :next-cursor (when (= (count out) n)
                        (let [p (::pos lst)]
                          (if (= 2 (count p)) (into ["a"] p) (into ["b"] p))))}))))
