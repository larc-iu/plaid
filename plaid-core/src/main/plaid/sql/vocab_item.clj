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
