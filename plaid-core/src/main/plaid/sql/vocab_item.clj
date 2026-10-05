(ns plaid.sql.vocab-item
  "Vocab items: the `vocab_items` table, keyed by their vocab via
  `vocab_layer_id`."
  (:require [clojure.data.json]
            [clojure.string :as str]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.cascade-statistics :as cascade-stats]
            [plaid.sql.common :as psc]
            [plaid.sql.crud :as crud]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.sql.metadata :as metadata]
            [plaid.util.storable-text :as storable])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:vocab-item/id
                :vocab-item/layer
                :vocab-item/form])

;; ============================================================
;; Linked documents
;;
;; An entry is global: its op carries `:project nil :document nil`, so the
;; post-body `bump-document-version!` hook never fires. But a deep document
;; read embeds the entry's `form` on every vocab_link that points at it
;; (`plaid.sql.document/get-with-layer-data`), so a rename makes those
;; documents' bodies stale, and a delete removes rows from them outright,
;; while nothing in the documents themselves has changed. Every writer here
;; that renames or removes an entry has to walk the affected documents and
;; bump them explicitly, the same shape vocab-layer/delete and
;; project/remove-vocab already use.
;;
;; Without it a client's optimistic-concurrency version never moves, the
;; op's `:audit/documents` set comes back empty so document-scoped SSE
;; listeners are never told their view went stale, and any consumer caching
;; a body against `documents.version` (the agent does, keyed on
;; `(id, version)`) serves the old headword indefinitely.
;; ============================================================

(defn- linked-document-ids
  "Document ids holding a vocab_link to any of `item-ids`, duplicates and all
  (`bump-document-versions!` dedups). Must be read BEFORE the links go away."
  [tx item-ids]
  (if-let [ids (seq item-ids)]
    (->> (psc/q tx {:select [:document_id]
                    :from :vocab_links
                    :where [:in :vocab_item_id (vec ids)]})
         (mapv :document_id))
    []))

;; ============================================================
;; Row mapper
;; ============================================================

(defn- row->vocab-item
  [row]
  (when row
    {:vocab-item/id    (:id row)
     :vocab-item/layer (:vocab_layer_id row)
     :vocab-item/form  (:form row)}))

;; ============================================================
;; Reads
;; ============================================================

(defn get
  "Get a vocab item by ID, with metadata attached if present."
  [db id]
  (when-let [item (row->vocab-item (psc/fetch-by-id db :vocab_items id))]
    (metadata/add-metadata-to-response db item "vocab-item" id)))

(defn get-all-in-layer
  "Get all vocab items in a specific vocab layer, each with metadata
  attached, in creation order. The order is load-bearing: plaid-igt numbers
  the entries spelled alike, and the senses under an entry that carry no
  order of their own, by their place in this list, and its exports write
  those numbers. The table has no timestamp, so the rowid is the order."
  [db layer-id]
  (let [rows (psc/q db {:select [:*]
                        :from [:vocab_items]
                        :where [:= :vocab_layer_id layer-id]
                        :order-by [:rowid]})]
    (mapv (fn [r]
            (let [item (row->vocab-item r)]
              (metadata/add-metadata-to-response db item "vocab-item" (:id r))))
          rows)))

;; ============================================================
;; Writes: create / merge
;;
;; No `delete` — items are removed transitively via the cascade from
;; vocab_layers (matches v2 behavior).
;; ============================================================

(defn- assert-document-version!
  "The version check of an entry made for a link in a document the caller
  holds at a version (`?document-id=` beside `?document-version=`, bound by
  `wrap-document-version`). An entry belongs to no document, so the check
  `submit-operation*` makes for a document's own writes never fires here.
  A document that is gone has moved on from every version, so it answers
  409 too."
  [tx doc-id]
  (psaw/check-expected-document-version! tx doc-id :conflict))

(defn create
  "Create a new vocab item.

  attrs must include :vocab-item/layer and :vocab-item/form.
  Optional metadata-map maps key->value for entity_metadata rows.
  `:vocab-item/id` names the new item's id (a client's UUIDv7), else the
  server mints one.

  Returns {:success true :extra <new-id>}."
  ([db attrs user-id]
   (create db attrs user-id nil))
  ([db attrs user-id metadata-map]
   (create db attrs user-id metadata-map nil))
  ([db attrs user-id metadata-map doc-id]
   (let [{:vocab-item/keys [layer form]} attrs
         new-id (or (:vocab-item/id attrs) (psc/new-uuid))
         row {:id new-id
              :form form
              :vocab_layer_id layer}]
     (submit-operation! [tx db {:type :vocab-item/create
                                :project nil
                                :document nil
                                :description (str "Create vocab item '" form "'")
                                :user user-id}]
                        (assert-document-version! tx doc-id)
                        (storable/assert-storable! "Form" form)
                        (psc/claim-ids! tx :vocab_items "vocabulary item" [(:vocab-item/id attrs)])
                        (when (nil? (psc/fetch-by-id tx :vocab_layers layer))
                          (throw (ex-info (psc/err-msg-not-found "Vocab layer" layer)
                                          {:code 400 :id layer})))
                        (if (seq metadata-map)
                          ;; Manual insert + audit so the post_image folds
                          ;; in :metadata, avoiding a separate :update
                          ;; audit row from the metadata helper (task #59,
                          ;; missed for vocab-item in Wave 5 — task #74).
                          (do
                            (psc/execute! tx {:insert-into :vocab_items
                                              :values [row]})
                            (metadata/insert-metadata! tx "vocab-item" new-id
                                                       metadata-map
                                                       {:skip-parent-audit? true})
                            (let [post-row (psc/fetch-by-id tx :vocab_items new-id)
                                  post-image (assoc post-row :metadata metadata-map)]
                              (psaw/record-audit-write! tx :vocab_items new-id
                                                        :insert nil post-image)))
                          ;; No metadata: use the audited insert! helper as before.
                          (crud/insert! tx :vocab_items row))
                        (op/touch-vocab-layer! tx layer)
                        new-id))))

(defn merge
  "Update mutable fields on a vocab item. Currently supports
  :vocab-item/form."
  [db eid m user-id]
  (submit-operation! [tx db {:type :vocab-item/merge
                             :project nil
                             :document nil
                             :description (str "Update vocab item " eid)
                             :user user-id}]
                     (let [existing (psc/fetch-by-id tx :vocab_items eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Vocab item" eid)
                                         {:code 404 :id eid})))
                       (storable/assert-storable! "Form" (:vocab-item/form m))
                       (let [attrs (cond-> {}
                                     (some? (:vocab-item/form m))
                                     (assoc :form (:vocab-item/form m)))
                             ;; Only a real change to the form restates the
                             ;; documents: a PATCH that sets the form it
                             ;; already has must not bump every document that
                             ;; links the entry.
                             renamed? (and (contains? attrs :form)
                                           (not= (:form attrs) (:form existing)))
                             doc-ids (when renamed? (linked-document-ids tx [eid]))]
                         (when (seq attrs)
                           (crud/update-by-id! tx :vocab_items eid attrs)
                           (op/touch-vocab-layer! tx (:vocab_layer_id existing)))
                         (op/bump-document-versions! tx doc-ids)
                         eid))))

(defn- delete*
  "The operation of `delete`. `links-found` is an atom it sets to the number
  of links the entry has, read inside the transaction."
  [db eid user-id expected-link-count links-found]
  (submit-operation! [tx db {:type :vocab-item/delete
                             :project nil
                             :document nil
                             :description (str "Delete vocab item " eid)
                             :user user-id}]
                     (let [existing (psc/fetch-by-id tx :vocab_items eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Vocab item" eid)
                                         {:code 404 :id eid})))
                       (let [vl-rows (crud/select-in tx :vocab_links "id, document_id" :vocab_item_id
                                                     "idx_vocab_links_item" [eid])
                             vl-ids (mapv :id vl-rows)]
                         (reset! links-found (count vl-rows))
                         (when (and (some? expected-link-count)
                                    (not= expected-link-count (count vl-rows)))
                           (throw (ex-info (str "This entry has " (count vl-rows) " links now, not "
                                                expected-link-count)
                                           {:code 409 :id eid :links (count vl-rows)})))
                         (when (seq vl-ids)
                           (cascade-stats/prepare! tx))
                         (crud/delete-ids! tx :vocab_links vl-ids)
                         (crud/delete-entity-metadata! tx "vocab-link" vl-ids)
                         (op/bump-document-versions! tx (mapv :document_id vl-rows)))
                       (psc/execute! tx
                                     {:delete-from :entity_metadata
                                      :where [:and
                                              [:= :entity_type "vocab-item"]
                                              [:= :entity_id eid]]})
                       (crud/delete-by-id! tx :vocab_items eid)
                       (op/touch-vocab-layer! tx (:vocab_layer_id existing))
                       eid)))

(defn delete
  "Delete a vocab item. Walks the descendant subtree (vocab_links
  pointing at this item) and audits each row deletion through the
  audited helpers so audit_writes captures every change — FK ON DELETE
  CASCADE would otherwise silently sweep them. Vocab_link metadata is
  cleaned up alongside each link; this item's own entity_metadata is
  swept here too (no FK on entity_metadata). With `expected-link-count`
  the delete is refused (409) when the entry has any other number of
  links, read inside the transaction, and the refusal carries that number
  as `:links` beside its message, for the dialog to show."
  ([db eid user-id]
   (delete db eid user-id nil))
  ([db eid user-id expected-link-count]
   (let [links-found (atom nil)
         result (delete* db eid user-id expected-link-count links-found)]
     (cond-> result
       (and (= 409 (:code result)) (some? @links-found)) (assoc :links @links-found)))))

;; ============================================================
;; Bulk create / delete
;;
;; The sibling of plaid.sql.vocab-link's bulk pair (commit b8ec4af).
;; Vocab items differ in one structural way: they hang off a vocab LAYER,
;; not a document, so there is no document/OCC version and no
;; single-parent constraint — entries may target DIFFERENT vocab layers
;; in one call (the REST handler gates write access per distinct layer).
;; ============================================================

(defn get-layer-ids
  "Distinct vocab-layer ids for the given item ids (existing items only;
  unknown ids contribute nothing). Used by the bulk endpoint's per-layer
  write-access gate, keeping column-name knowledge inside this namespace."
  [db ids]
  (->> (psc/fetch-ids db :vocab_items (vec (distinct ids)))
       (map :vocab_layer_id)
       distinct
       vec))

(defn renamed-layer-ids
  "Distinct vocab-layer ids of the entries in `items` whose form would
  change: each item is a map with `:id` and, when it sets one,
  `:vocab-item/form`. Unknown ids contribute nothing. Used by the REST gate
  that keeps renames to the vocabulary's maintainers."
  [db items]
  (let [setting (filterv #(contains? % :vocab-item/form) items)
        by-id (psc/fetch-ids-as-map db :vocab_items (vec (distinct (map :id setting))))]
    (->> setting
         (keep (fn [{:keys [id] :as it}]
                 (when-let [row (clojure.core/get by-id id)]
                   (when (not= (:vocab-item/form it) (:form row))
                     (:vocab_layer_id row)))))
         distinct
         vec)))

(defn bulk-create
  "Bulk-create vocab items in a single operation. Each entry in `attrs-vec`
  requires :vocab-item/layer and :vocab-item/form and optionally :metadata
  and :vocab-item/id (a client's UUIDv7 for the new item).
  Entries may reference DIFFERENT vocab layers.

  The audit shape mirrors single `create`: ONE synthetic :insert per item
  whose post_image folds :metadata when present, so history replay
  reconstructs each item from one record (task #59). Returns
  {:success true :extra [ids]} with ids in input order."
  ([db attrs-vec user-id]
   (bulk-create db attrs-vec user-id nil))
  ([db attrs-vec user-id doc-id]
   (submit-operation! [tx db {:type :vocab-item/bulk-create
                              :project nil
                              :document nil
                              :description (str "Bulk create " (count attrs-vec) " vocab items")
                              :user user-id}]
                     ;; Validation runs inside the tx so submit-operation* projects
                     ;; ExceptionInfo to a structured 4xx response.
                      (assert-document-version! tx doc-id)
                      (when (empty? attrs-vec)
                        (throw (ex-info "Bulk create requires at least one vocab item" {:code 400})))
                      (doseq [a attrs-vec] (storable/assert-storable! "Form" (:vocab-item/form a)))
                      (psc/claim-ids! tx :vocab_items "vocabulary item" (map :vocab-item/id attrs-vec))
                      (let [layer-ids (->> attrs-vec (map :vocab-item/layer) distinct vec)
                            existing-layers (set (->> (psc/fetch-ids tx :vocab_layers layer-ids)
                                                      (map :id)))]
                        (doseq [lid layer-ids]
                          (when-not (contains? existing-layers lid)
                            (throw (ex-info (psc/err-msg-not-found "Vocab layer" lid)
                                            {:code 400 :id lid}))))
                        (let [records (mapv (fn [a]
                                              {:id (or (:vocab-item/id a) (psc/new-uuid))
                                               :layer (:vocab-item/layer a)
                                               :form (:vocab-item/form a)
                                               :metadata (:metadata a)})
                                            attrs-vec)]
                         ;; Parent rows in one (chunked) multi-row INSERT — unaudited;
                         ;; the synthetic :insert per item below carries the real audit
                         ;; image. Chunked because a lexicon import can exceed SQLite's
                         ;; statement parameter ceiling (SQLITE_MAX_VARIABLE_NUMBER).
                          (doseq [chunk (partition-all 4000 records)]
                            (psc/execute! tx {:insert-into :vocab_items
                                              :values (mapv (fn [r]
                                                              {:id (:id r)
                                                               :form (:form r)
                                                               :vocab_layer_id (:layer r)})
                                                            chunk)}))
                         ;; Metadata with skip-parent-audit? so no separate :update row
                         ;; fires; it is folded into the synthetic :insert below.
                          (doseq [r records]
                            (when (seq (:metadata r))
                              (metadata/insert-metadata! tx "vocab-item" (:id r) (:metadata r)
                                                         {:skip-parent-audit? true})))
                         ;; One synthetic :insert per item with the full image.
                          (let [row-by-id (psc/fetch-ids-as-map tx :vocab_items (mapv :id records))]
                            (doseq [r records]
                              (let [post-image (cond-> (clojure.core/get row-by-id (:id r))
                                                 (seq (:metadata r)) (assoc :metadata (:metadata r)))]
                                (psaw/record-audit-write! tx :vocab_items (:id r) :insert nil post-image))))
                          (op/touch-vocab-layers! tx layer-ids)
                          (mapv :id records))))))

(defn bulk-merge
  "Update many vocab items in ONE operation: set forms and/or patch metadata.
  `items` is a vector of maps, each with `:id` and either or both of
  `:vocab-item/form` (set when the key is PRESENT) and `:metadata` (a list
  of ops for `plaid.sql.metadata/patch-metadata!`). Entries may span several vocab layers; the caller has already
  checked write access on each.

  Unknown ids are refused (404) rather than dropped, and an id may appear
  only once — the contract `plaid.sql.bulk/bulk-update!` sets for spans,
  tokens and relations. That path cannot be reused here: it finds the
  project through the layer's `project_id` and bumps the entities' own
  document, and a vocab layer has neither. Instead, as in single `merge`,
  only a form that actually CHANGES restates the documents linking the
  entry, so re-writing the form an entry already has bumps nothing.

  Returns the vector of ids updated."
  [db items user-id]
  (let [ids (mapv :id items)]
    (submit-operation! [tx db {:type :vocab-item/bulk-merge
                               :project nil
                               :document nil
                               :description (str "Bulk update " (count items) " vocab items")
                               :user user-id}]
                       ;; Validation runs inside the tx so submit-operation* projects
                       ;; ExceptionInfo to a structured 4xx response.
                       (when (empty? items)
                         (throw (ex-info "Bulk update requires at least one vocab item" {:code 400})))
                       (when (not= (count ids) (count (distinct ids)))
                         (throw (ex-info "A vocab item may appear only once in a bulk update"
                                         {:code 400})))
                       (doseq [it items] (storable/assert-storable! "Form" (:vocab-item/form it)))
                       (let [rows (psc/fetch-ids tx :vocab_items ids)
                             by-id (into {} (map (juxt :id identity)) rows)
                             missing (remove by-id ids)]
                         (when (seq missing)
                           (throw (ex-info (str "Vocab items not found: " (str/join ", " missing))
                                           {:code 404 :ids (vec missing)})))
                         (let [renamed (filterv (fn [it]
                                                  (and (contains? it :vocab-item/form)
                                                       (not= (:vocab-item/form it)
                                                             (:form (by-id (:id it))))))
                                                items)
                               ;; Read BEFORE the forms change, like every other
                               ;; writer in this namespace.
                               doc-ids (linked-document-ids tx (mapv :id renamed))]
                           (when (seq renamed)
                             (crud/bulk-update-by-id! tx :vocab_items
                                                      (mapv (juxt :id #(hash-map :form (:vocab-item/form %)))
                                                            renamed)))
                           (doseq [it items :when (seq (:metadata it))]
                             (metadata/patch-metadata! tx "vocab-item" (:id it) (:metadata it)))
                           (op/touch-vocab-layers! tx (distinct (map :vocab_layer_id rows)))
                           (op/bump-document-versions! tx doc-ids)
                           ids)))))

(defn bulk-delete
  "Bulk-delete vocab items in a single operation. For each existing item the
  descendant vocab_links (and their metadata) are deleted first, then the
  item's own metadata, then the item itself — mirroring single `delete`,
  audited so audit_writes captures every change (FK ON DELETE CASCADE would
  otherwise sweep the links silently).

  Ids that don't resolve to an existing row are silently dropped (mirrors
  span/vocab-link bulk-delete) — without the filter they'd reach
  `delete-where!` and emit phantom :delete audit rows with pre = nil.
  Returns the vector of ids actually deleted."
  [db eids user-id]
  (let [eids (vec (distinct eids))]
    (submit-operation! [tx db {:type :vocab-item/bulk-delete
                               :project nil
                               :document nil
                               :description (str "Bulk delete " (count eids) " vocab items")
                               :user user-id}]
                       (let [existing-ids (->> (psc/fetch-ids tx :vocab_items eids)
                                               (keep :id) vec)
                             ;; Resolved BEFORE the rows go away: afterwards there is
                             ;; nothing left to read the parent layer off of.
                             layer-ids (get-layer-ids tx existing-ids)]
                         (when (seq existing-ids)
                           (cascade-stats/prepare! tx)
                           ;; Descendant vocab_links (audited per row), then their
                           ;; metadata (unaudited sweep, no FK on entity_metadata).
                           (let [link-ids (mapv :id (crud/select-in tx :vocab_links "id" :vocab_item_id
                                                                    "idx_vocab_links_item" existing-ids))
                                 link-rows (crud/delete-ids! tx :vocab_links link-ids)]
                             (crud/delete-entity-metadata! tx "vocab-link" link-ids)
                             (op/bump-document-versions! tx (mapv :document_id link-rows)))
                           ;; The items' own metadata, then the items (audited per row).
                           (crud/delete-entity-metadata! tx "vocab-item" existing-ids)
                           (crud/delete-ids! tx :vocab_items existing-ids)
                           (op/touch-vocab-layers! tx layer-ids))
                         existing-ids))))

;; ============================================================
;; Merge
;; ============================================================

(defn- link-token-keys
  "Link id -> the set of token ids it covers, for `link-ids`. Two links on
  the same words are the same link, whatever order their tokens were given
  in."
  [tx link-ids]
  (reduce (fn [acc chunk]
            (reduce (fn [acc {:keys [vocab_link_id token_id]}]
                      (update acc vocab_link_id (fnil conj #{}) token_id))
                    acc
                    (psc/q tx {:select [:vocab_link_id :token_id]
                               :from :vocab_link_tokens
                               :where [:in :vocab_link_id (vec chunk)]})))
          {}
          (partition-all 4000 link-ids)))

(defn- delete-links!
  "Delete vocab links by id, audited per row, and sweep their metadata."
  [tx link-ids]
  (crud/delete-ids! tx :vocab_links link-ids)
  (crud/delete-entity-metadata! tx "vocab-link" link-ids))

(defn- repoint-value
  "`v` with every string equal to a key of `from->to` replaced by its value,
  at any depth. In a list, a replaced id the list already holds is dropped,
  so a list never names the survivor twice."
  [v from->to]
  (cond
    (string? v) (clojure.core/get from->to v v)
    (map? v) (update-vals v #(repoint-value % from->to))
    (sequential? v) (let [kept (set (remove from->to (filter string? v)))]
                      (first
                       (reduce (fn [[out seen] x]
                                 (if-let [to (and (string? x) (from->to x))]
                                   (if (or (kept to) (seen to))
                                     [out seen]
                                     [(conj out to) (conj seen to)])
                                   [(conj out (repoint-value x from->to)) seen]))
                               [[] #{}]
                               v)))
    :else v))

(def ^:private document-held-metadata
  "Entity type -> [table, the column naming its document]: every entity
  that carries metadata inside a document."
  {"document" [:documents :id]
   "text" [:texts :document_id]
   "token" [:tokens :document_id]
   "span" [:spans :document_id]
   "relation" [:relations :document_id]
   "vocab-link" [:vocab_links :document_id]})

(defn- repoint-metadata-refs!
  "Rewrite every metadata value that names a loser to name the survivor
  instead, wherever the vocabulary can be used: the other entries of the
  vocabulary, and every entity in a document of a project the vocabulary is
  linked to. A value names an entry when it is a string equal to the entry's
  id, at any depth. The survivor's own metadata is left as it is, where the
  same rewrite would make the entry name itself. Each rewrite is audited as
  a metadata write. Returns the ids of the documents written."
  [tx vocab-id survivor-id loser-ids]
  (let [from->to (zipmap (map str loser-ids) (repeat (str survivor-id)))
        names-a-loser (into [:or] (map (fn [id] [:> [:instr :em.value id] 0])) (keys from->to))
        doc-ids {:select [:d.id]
                 :from [[:documents :d]]
                 :join [[:project_vocabs :pv] [:= :pv.project_id :d.project_id]]
                 :where [:= :pv.vocab_layer_id vocab-id]}
        rows (concat
              (for [r (psc/q tx {:select [:em.entity_id :em.key :em.value]
                                 :from [[:entity_metadata :em]]
                                 :where [:and
                                         [:= :em.entity_type "vocab-item"]
                                         [:in :em.entity_id {:select [:id]
                                                             :from :vocab_items
                                                             :where [:and [:= :vocab_layer_id vocab-id]
                                                                     [:<> :id (str survivor-id)]]}]
                                         names-a-loser]})]
                (assoc r :entity_type "vocab-item"))
              (mapcat (fn [[etype [table doc-col]]]
                        (for [r (psc/q tx {:select [:em.entity_id :em.key :em.value [(keyword (str "x." (name doc-col))) :doc]]
                                           :from [[:entity_metadata :em]]
                                           :join [[table :x] [:= :x.id :em.entity_id]]
                                           :where [:and
                                                   [:= :em.entity_type etype]
                                                   [:in (keyword (str "x." (name doc-col))) doc-ids]
                                                   names-a-loser]})]
                          (assoc r :entity_type etype)))
                      document-held-metadata))
        written (for [{:keys [entity_type entity_id key value doc]} rows
                      :let [old (clojure.data.json/read-str value)
                            new (repoint-value old from->to)]
                      :when (not= old new)]
                  (do (metadata/patch-metadata! tx entity_type entity_id
                                                [{:op "set" :path [key] :value new}])
                      doc))]
    (vec (keep identity (doall written)))))

(defn merge-into
  "Merge the entries `loser-ids` into the entry `survivor-id`, in ONE
  operation: every link to a loser is re-pointed to the survivor (the link
  keeps its id, its words and its metadata), a link on words the survivor
  is already linked to is deleted instead, and then the losers are deleted.

  Every metadata value elsewhere that names a loser by its id is rewritten
  to name the survivor (see `repoint-metadata-refs!`), so a reference an
  app keeps in its own metadata follows the merge as the links do.

  Links are read inside the transaction, so a link someone made to a loser
  after the caller planned the merge moves with the rest. That is the point
  of doing it here: a client that re-links the links it saw and then
  deletes the losers loses every link made in between.

  The survivor must exist (404) and every loser must be in its vocabulary
  (400). A loser that no longer exists is skipped, as in `bulk-delete`, so
  a retry of a merge that already landed changes nothing. The survivor's
  own metadata that refers to a loser (its parent was one) is the caller's:
  it rewrites that in the same batch.

  Every document holding a moved or deleted link has its version bumped.
  Returns {:moved n :duplicates n :removed [loser ids deleted]}."
  [db survivor-id loser-ids user-id]
  (let [loser-ids (vec (distinct loser-ids))]
    (submit-operation! [tx db {:type :vocab-item/merge-into
                               :project nil
                               :document nil
                               :description (str "Merge " (count loser-ids) " vocab items into " survivor-id)
                               :user user-id}]
                       (let [survivor (psc/fetch-by-id tx :vocab_items survivor-id)]
                         (when (nil? survivor)
                           (throw (ex-info (psc/err-msg-not-found "Vocab item" survivor-id)
                                           {:code 404 :id survivor-id})))
                         (when (empty? loser-ids)
                           (throw (ex-info "A merge needs at least one entry to merge" {:code 400})))
                         (when (some #{survivor-id} loser-ids)
                           (throw (ex-info "An entry cannot be merged into itself" {:code 400})))
                         (let [losers (psc/fetch-ids tx :vocab_items loser-ids)
                               layer (:vocab_layer_id survivor)]
                           (when-let [other (first (remove #(= layer (:vocab_layer_id %)) losers))]
                             (throw (ex-info (str "Vocab item " (:id other) " is in another vocabulary")
                                             {:code 400 :id (:id other)})))
                           (cascade-stats/prepare! tx)
                           (let [existing-ids (mapv :id losers)
                                 survivor-links (psc/q tx {:select [:id]
                                                           :from :vocab_links
                                                           :where [:= :vocab_item_id survivor-id]})
                                 loser-links (if (seq existing-ids)
                                               (psc/q tx {:select [:id :document_id]
                                                          :from :vocab_links
                                                          :where [:in :vocab_item_id existing-ids]
                                                          :order-by [:rowid]})
                                               [])
                                 words (link-token-keys tx (into (mapv :id survivor-links)
                                                                 (map :id) loser-links))
                                 [moved dups] (loop [[l & more] loser-links
                                                     seen (into #{} (map (comp words :id)) survivor-links)
                                                     moved []
                                                     dups []]
                                                (if (nil? l)
                                                  [moved dups]
                                                  (let [k (words (:id l))]
                                                    (if (contains? seen k)
                                                      (recur more seen moved (conj dups (:id l)))
                                                      (recur more (conj seen k) (conj moved (:id l)) dups)))))]
                             (when (seq moved)
                               (crud/bulk-update-by-id! tx :vocab_links
                                                        (mapv (fn [id] [id {:vocab_item_id survivor-id}]) moved)))
                             (delete-links! tx dups)
                             (crud/delete-entity-metadata! tx "vocab-item" existing-ids)
                             (crud/delete-ids! tx :vocab_items existing-ids)
                             (let [repointed-docs (if (seq existing-ids)
                                                    (repoint-metadata-refs! tx layer survivor-id existing-ids)
                                                    [])]
                               ;; As strings, so a document named both ways is bumped once.
                               (op/bump-document-versions! tx (map str (into (mapv :document_id loser-links)
                                                                             repointed-docs))))
                             (op/touch-vocab-layer! tx layer)
                             {:moved (count moved)
                              :duplicates (count dups)
                              :removed existing-ids}))))))

;; ============================================================
;; Metadata
;; ============================================================

(def ^:private metadata-fns
  ;; A vocab item has no project and no document: its vocabulary is global,
  ;; granted to projects. Its layer is touched after every metadata write so
  ;; readers see the vocabulary change.
  (metadata/metadata-fns {:table :vocab_items
                          :entity-type "vocab-item"
                          :noun "vocab item"
                          :after-fn (fn [tx row] (op/touch-vocab-layer! tx (:vocab_layer_id row)))}))

(def ^{:doc "Replace all metadata on the vocab item with metadata-map."
       :arglists '([db eid metadata-map user-id])}
  set-metadata (:set-metadata metadata-fns))

(def ^{:doc "Shallow-merge a metadata patch on the vocab item: keys present set/overwrite,
  a null value deletes that key, omitted keys are untouched. See
  `plaid.sql.metadata/patch-metadata!`."
       :arglists '([db eid patch user-id])}
  patch-metadata (:patch-metadata metadata-fns))

(def ^{:doc "Remove all metadata for the vocab item."
       :arglists '([db eid user-id])}
  delete-metadata (:delete-metadata metadata-fns))
