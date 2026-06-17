(ns plaid.sql.vocab-item
  "SQL port of plaid.xtdb2.vocab-item. Items live in `vocab_items`,
  keyed by their parent vocab via `vocab_layer_id`.

  Per v2 there is no public `delete` — items are removed transitively
  via the cascade from `vocab_layers`."
  (:require [plaid.sql.common :as psc]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.sql.metadata :as metadata])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:vocab-item/id
                :vocab-item/layer
                :vocab-item/form])

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
  attached."
  [db layer-id]
  (let [rows (psc/q db {:select [:*]
                        :from [:vocab_items]
                        :where [:= :vocab_layer_id layer-id]})]
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

(defn create
  "Create a new vocab item.

  attrs must include :vocab-item/layer and :vocab-item/form.
  Optional metadata-map maps key->value for entity_metadata rows.

  Returns {:success true :extra <new-id>}."
  ([db attrs user-id]
   (create db attrs user-id nil))
  ([db attrs user-id metadata-map]
   (let [{:vocab-item/keys [layer form]} attrs
         new-id (psc/new-uuid)
         row {:id new-id
              :form form
              :vocab_layer_id layer}]
     (submit-operation! [tx db {:type :vocab-item/create
                                :project nil
                                :document nil
                                :description (str "Create vocab item '" form "'")
                                :user user-id}]
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
                              (psc/record-audit-write! tx :vocab_items new-id
                                                       :insert nil post-image)))
                          ;; No metadata: use the audited insert! helper as before.
                          (psc/insert! tx :vocab_items row))
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
                       (let [attrs (cond-> {}
                                     (some? (:vocab-item/form m))
                                     (assoc :form (:vocab-item/form m)))]
                         (when (seq attrs)
                           (psc/update-by-id! tx :vocab_items eid attrs))
                         eid))))

(defn delete
  "Delete a vocab item. Walks the descendant subtree (vocab_links
  pointing at this item) and audits each row deletion through the
  audited helpers so audit_writes captures every change — FK ON DELETE
  CASCADE would otherwise silently sweep them. Vocab_link metadata is
  cleaned up alongside each link; this item's own entity_metadata is
  swept here too (no FK on entity_metadata)."
  [db eid user-id]
  (submit-operation! [tx db {:type :vocab-item/delete
                             :project nil
                             :document nil
                             :description (str "Delete vocab item " eid)
                             :user user-id}]
                     (let [existing (psc/fetch-by-id tx :vocab_items eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Vocab item" eid)
                                         {:code 404 :id eid})))
                       (let [vl-ids (->> (psc/q tx {:select [:id]
                                                    :from :vocab_links
                                                    :where [:= :vocab_item_id eid]})
                                         (mapv :id))]
                         (doseq [vlid vl-ids]
                           (psc/delete-by-id! tx :vocab_links vlid))
                         (when (seq vl-ids)
                           (psc/execute! tx
                                         {:delete-from :entity_metadata
                                          :where [:and
                                                  [:= :entity_type "vocab-link"]
                                                  [:in :entity_id vl-ids]]})))
                       (psc/execute! tx
                                     {:delete-from :entity_metadata
                                      :where [:and
                                              [:= :entity_type "vocab-item"]
                                              [:= :entity_id eid]]})
                       (psc/delete-by-id! tx :vocab_items eid)
                       eid)))

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

(defn bulk-create
  "Bulk-create vocab items in a single operation. Each entry in `attrs-vec`
  requires :vocab-item/layer and :vocab-item/form and optionally :metadata.
  Entries may reference DIFFERENT vocab layers.

  The audit shape mirrors single `create`: ONE synthetic :insert per item
  whose post_image folds :metadata when present, so history replay
  reconstructs each item from one record (task #59). Returns
  {:success true :extra [ids]} with ids in input order."
  [db attrs-vec user-id]
  (submit-operation! [tx db {:type :vocab-item/bulk-create
                             :project nil
                             :document nil
                             :description (str "Bulk create " (count attrs-vec) " vocab items")
                             :user user-id}]
                     ;; Validation runs inside the tx so submit-operation* projects
                     ;; ExceptionInfo to a structured 4xx response.
                     (when (empty? attrs-vec)
                       (throw (ex-info "Bulk create requires at least one vocab item" {:code 400})))
                     (let [layer-ids (->> attrs-vec (map :vocab-item/layer) distinct vec)
                           existing-layers (set (->> (psc/fetch-ids tx :vocab_layers layer-ids)
                                                     (map :id)))]
                       (doseq [lid layer-ids]
                         (when-not (contains? existing-layers lid)
                           (throw (ex-info (psc/err-msg-not-found "Vocab layer" lid)
                                           {:code 400 :id lid}))))
                       (let [records (mapv (fn [a]
                                             {:id (psc/new-uuid)
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
                               (psc/record-audit-write! tx :vocab_items (:id r) :insert nil post-image))))
                         (mapv :id records)))))

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
                                               (keep :id) vec)]
                         (when (seq existing-ids)
                           ;; Descendant vocab_links (audited per row), then their
                           ;; metadata (unaudited sweep, no FK on entity_metadata).
                           (let [link-ids (->> (psc/delete-where! tx :vocab_links
                                                                  [:in :vocab_item_id existing-ids])
                                               (mapv :id))]
                             (when (seq link-ids)
                               (psc/execute! tx {:delete-from :entity_metadata
                                                 :where [:and
                                                         [:= :entity_type "vocab-link"]
                                                         [:in :entity_id link-ids]]})))
                           ;; The items' own metadata, then the items (audited per row).
                           (psc/execute! tx {:delete-from :entity_metadata
                                             :where [:and
                                                     [:= :entity_type "vocab-item"]
                                                     [:in :entity_id existing-ids]]})
                           (psc/delete-where! tx :vocab_items [:in :id existing-ids]))
                         existing-ids))))

;; ============================================================
;; Metadata
;; ============================================================

(defn set-metadata
  "Replace all metadata on the vocab item with metadata-map."
  [db eid metadata-map user-id]
  (submit-operation! [tx db {:type :vocab-item/set-metadata
                             :project nil
                             :document nil
                             :description (str "Set metadata on vocab item " eid
                                               " with " (count metadata-map) " keys")
                             :user user-id}]
                     (metadata/validate-entity-type! "vocab-item")
                     (when (nil? (psc/fetch-by-id tx :vocab_items eid))
                       (throw (ex-info (psc/err-msg-not-found "Vocab item" eid)
                                       {:code 404 :id eid})))
                     (metadata/replace-metadata! tx "vocab-item" eid metadata-map)
                     eid))

(defn patch-metadata
  "Shallow-merge a metadata patch on the vocab item: keys present set/overwrite,
  a null value deletes that key, omitted keys are untouched. See
  `plaid.sql.metadata/patch-metadata!`."
  [db eid patch user-id]
  (submit-operation! [tx db {:type :vocab-item/patch-metadata
                             :project nil
                             :document nil
                             :description (str "Patch metadata on vocab item " eid
                                               " with " (count patch) " keys")
                             :user user-id}]
                     (metadata/validate-entity-type! "vocab-item")
                     (when (nil? (psc/fetch-by-id tx :vocab_items eid))
                       (throw (ex-info (psc/err-msg-not-found "Vocab item" eid)
                                       {:code 404 :id eid})))
                     (metadata/patch-metadata! tx "vocab-item" eid patch)
                     eid))

(defn delete-metadata
  "Remove all metadata for the vocab item."
  [db eid user-id]
  (submit-operation! [tx db {:type :vocab-item/delete-metadata
                             :project nil
                             :document nil
                             :description (str "Delete all metadata from vocab item " eid)
                             :user user-id}]
                     (metadata/validate-entity-type! "vocab-item")
                     (when (nil? (psc/fetch-by-id tx :vocab_items eid))
                       (throw (ex-info (psc/err-msg-not-found "Vocab item" eid)
                                       {:code 404 :id eid})))
                     (metadata/delete-metadata! tx "vocab-item" eid)
                     eid))
