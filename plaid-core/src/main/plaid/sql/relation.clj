(ns plaid.sql.relation
  "SQL port of plaid.xtdb2.relation. Relations live in the `relations`
  table; source/target are FK references onto `spans`.

  External API mirrors xtdb2 (same fn names + arglists). `db` replaces
  `node-or-map`. Relations have no junction tables — the FK CASCADE on
  spans deletes them when a parent span is removed (and the span
  module audits that cascade explicitly)."
  (:require [taoensso.timbre :as log]
            [plaid.sql.common :as psc]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.sql.metadata :as metadata])
  (:refer-clojure :exclude [get merge format]))

(def attr-keys [:relation/id
                :relation/layer
                :relation/document
                :relation/source
                :relation/target
                :relation/value])

;; ============================================================
;; Row mappers
;; ============================================================

(defn- row->relation
  [row]
  (when row
    {:relation/id       (:id row)
     :relation/layer    (:relation_layer_id row)
     :relation/document (:document_id row)
     :relation/source   (:source_span_id row)
     :relation/target   (:target_span_id row)
     :relation/value    (psc/read-json (:value row))}))

;; ============================================================
;; Public reads
;; ============================================================

(defn format
  "Format a relation record for external consumption (core attrs +
  optional :metadata)."
  [db raw]
  (when raw
    (let [core (select-keys raw attr-keys)]
      (metadata/add-metadata-to-response db core "relation" (:relation/id raw)))))

(defn get
  "Look up a relation by id. Returns the formatted (API-shape) map or
  nil."
  [db id]
  (when-let [row (psc/fetch-by-id db :relations id)]
    (format db (row->relation row))))

(defn project-id
  "Find the project id for a relation. Single-entity lookup via the
  denormalized relation_layers.project_id column."
  [db id]
  (when-let [rl-id (:relation_layer_id (psc/fetch-by-id db :relations id))]
    (:project_id (psc/fetch-by-id db :relation_layers rl-id))))

;; ============================================================
;; Internal helpers
;; ============================================================

(defn- validate-atomic-value!
  [value]
  (when-not (or (nil? value) (string? value) (number? value) (boolean? value))
    (throw (ex-info "Relation value must be atomic (string, number, boolean, or null)"
                    {:value value :code 400}))))

;; Task #100 V1: self-loops (source == target) are intentionally allowed.
;; Annotation projects routinely encode "this span refers back to itself"
;; (reflexives, dependency self-arcs, coreference singletons) and the
;; downstream consumers all handle the case. The invariant check below
;; does NOT reject source == target.
(defn- check-relation-invariants!
  "Validates:
   - source and target span exist
   - both share the same span_layer
   - both share the same document
   - the relation layer's parent span_layer matches the spans' span_layer

   Does NOT reject source == target — see the comment above the defn
   for the design rationale."
  [tx relation-layer-id source-id target-id source-row target-row]
  (when (nil? source-row)
    (throw (ex-info (str "Source span " source-id " does not exist")
                    {:id source-id :code 400})))
  (when (nil? target-row)
    (throw (ex-info (str "Target span " target-id " does not exist")
                    {:id target-id :code 400})))
  (when-not (= (:span_layer_id source-row) (:span_layer_id target-row))
    (throw (ex-info "Source and target relations must be contained in a single span layer."
                    {:source-layer (:span_layer_id source-row)
                     :target-layer (:span_layer_id target-row)
                     :code 400})))
  (when-not (= (:document_id source-row) (:document_id target-row))
    (throw (ex-info "Source and target relations must be in a single document."
                    {:code 400})))
  (let [rl-row (psc/fetch-by-id tx :relation_layers relation-layer-id)]
    (when (nil? rl-row)
      (throw (ex-info (psc/err-msg-not-found "Relation layer" relation-layer-id)
                      {:id relation-layer-id :code 400})))
    (when-not (= (:span_layer_id rl-row) (:span_layer_id source-row))
      (throw (ex-info (str "Relation layer " relation-layer-id
                           " is not connected to span layer "
                           (:span_layer_id source-row))
                      {:relation-layer relation-layer-id
                       :span-layer (:span_layer_id source-row)
                       :code 400})))))

;; ============================================================
;; Create
;; ============================================================

(defn create
  "Create a relation. `attrs` requires :relation/layer, :relation/source,
  :relation/target; optional :relation/value. `metadata` is a map of
  key->value inserted into entity_metadata when provided.

  Audit shape: ONE audit_writes row against `:relations` with
  change_type :insert. pre = nil; post = the inserted relation row,
  augmented with a `:metadata` key when `metadata` is non-empty.
  Folding metadata in avoids the noisy :insert + :update pair we'd
  otherwise emit (task #59). Relations have no junction-table
  tokens, so only `:metadata` is folded.

  Returns {:success true :extra <new-id>}."
  ([db attrs user-id] (create db attrs user-id nil))
  ([db attrs user-id metadata]
   (let [{:relation/keys [layer source target value]} attrs
         new-id (psc/new-uuid)]
     (submit-operation!
      [tx db {:type :relation/create
              :project (when layer
                         (:project_id (psc/fetch-by-id db :relation_layers layer)))
              :document (when source
                          (:document_id (psc/fetch-by-id db :spans source)))
              :description (str "Create relation from span " source
                                " to span " target " in layer " layer)
              :user user-id}]
      ;; Validation inside the body (task #47).
      (validate-atomic-value! value)
      (when (psc/fetch-by-id tx :relations new-id)
        (throw (ex-info (psc/err-msg-already-exists "Relation" new-id)
                        {:id new-id :code 409})))
      (let [source-row (psc/fetch-by-id tx :spans source)
            target-row (psc/fetch-by-id tx :spans target)
            row {:id new-id
                 :relation_layer_id layer
                 :document_id (:document_id source-row)
                 :source_span_id source
                 :target_span_id target
                 :value (psc/write-json value)}]
        (check-relation-invariants! tx layer source target source-row target-row)
        (if (seq metadata)
          ;; Manual insert + audit so the post_image folds in
          ;; :metadata, avoiding a separate :update audit row
          ;; (task #59).
          (do
            (psc/execute! tx {:insert-into :relations :values [row]})
            (metadata/insert-metadata! tx "relation" new-id metadata
                                       {:skip-parent-audit? true})
            (let [post-row (psc/fetch-by-id tx :relations new-id)
                  post-image (assoc post-row :metadata metadata)]
              (psc/record-audit-write! tx :relations new-id :insert nil post-image)))
          ;; No metadata: use the audited insert! helper as before.
          (psc/insert! tx :relations row))
        new-id)))))

;; ============================================================
;; Merge (update mutable attrs)
;; ============================================================

(defn merge
  "Update mutable relation fields. Currently supports :relation/value."
  [db eid m user-id]
  (submit-operation!
   [tx db {:type :relation/update-attributes
           :project (project-id db eid)
           :document (:document_id (psc/fetch-by-id db :relations eid))
           :description (str "Update attributes of relation " eid)
           :user user-id}]
   (when (contains? m :relation/value)
     (validate-atomic-value! (:relation/value m)))
   (let [existing (psc/fetch-by-id tx :relations eid)]
     (when (nil? existing)
       (throw (ex-info (psc/err-msg-not-found "Relation" eid)
                       {:code 404 :id eid})))
     (let [attrs (cond-> {}
                   (contains? m :relation/value)
                   (assoc :value (psc/write-json (:relation/value m))))]
       (when (seq attrs)
         (psc/update-by-id! tx :relations eid attrs))
       eid))))

;; ============================================================
;; Delete
;; ============================================================

(defn delete
  "Delete a relation."
  [db eid user-id]
  (let [pre (psc/fetch-by-id db :relations eid)]
    (submit-operation!
     [tx db {:type :relation/delete
             :project (project-id db eid)
             :document (:document_id pre)
             :description (str "Delete relation " eid)
             :user user-id}]
     (when (nil? (psc/fetch-by-id tx :relations eid))
       (throw (ex-info (psc/err-msg-not-found "Relation" eid)
                       {:code 404 :id eid})))
     (psc/delete-by-id! tx :relations eid)
     (psc/execute! tx
                   {:delete-from :entity_metadata
                    :where [:and
                            [:= :entity_type "relation"]
                            [:= :entity_id eid]]})
     eid)))

;; ============================================================
;; Metadata
;; ============================================================

(defn set-metadata
  "Replace all metadata on a relation."
  [db eid metadata-map user-id]
  (submit-operation!
   [tx db {:type :relation/set-metadata
           :project (project-id db eid)
           :document (:document_id (psc/fetch-by-id db :relations eid))
           :description (str "Set metadata on relation " eid
                             " with " (count metadata-map) " keys")
           :user user-id}]
   (metadata/validate-entity-type! "relation")
   (when (nil? (psc/fetch-by-id tx :relations eid))
     (throw (ex-info (psc/err-msg-not-found "Relation" eid)
                     {:code 404 :id eid})))
   (metadata/replace-metadata! tx "relation" eid metadata-map)
   eid))

(defn patch-metadata
  "Shallow-merge a metadata patch on a relation: keys present set/overwrite,
  a null value deletes that key, omitted keys are untouched. See
  `plaid.sql.metadata/patch-metadata!`."
  [db eid patch user-id]
  (submit-operation!
   [tx db {:type :relation/patch-metadata
           :project (project-id db eid)
           :document (:document_id (psc/fetch-by-id db :relations eid))
           :description (str "Patch metadata on relation " eid
                             " with " (count patch) " keys")
           :user user-id}]
   (metadata/validate-entity-type! "relation")
   (when (nil? (psc/fetch-by-id tx :relations eid))
     (throw (ex-info (psc/err-msg-not-found "Relation" eid)
                     {:code 404 :id eid})))
   (metadata/patch-metadata! tx "relation" eid patch)
   eid))

(defn delete-metadata
  "Remove all metadata from a relation."
  [db eid user-id]
  (submit-operation!
   [tx db {:type :relation/delete-metadata
           :project (project-id db eid)
           :document (:document_id (psc/fetch-by-id db :relations eid))
           :description (str "Delete all metadata from relation " eid)
           :user user-id}]
   (metadata/validate-entity-type! "relation")
   (when (nil? (psc/fetch-by-id tx :relations eid))
     (throw (ex-info (psc/err-msg-not-found "Relation" eid)
                     {:code 404 :id eid})))
   (metadata/delete-metadata! tx "relation" eid)
   eid))

(defn get-doc-id-of-span
  "Return the document id that owns `span-id`."
  [db span-id]
  (:document_id (psc/fetch-by-id db :spans span-id)))

;; ============================================================
;; Bulk create
;; ============================================================

(defn- check-relations-consistency!
  "All relations in a bulk-create must target the same relation layer (v2 contract)."
  [relations-attrs]
  (when (empty? relations-attrs)
    (throw (ex-info "Relation list is empty" {:code 400})))
  (when-not (= 1 (->> relations-attrs (map :relation/layer) distinct count))
    (throw (ex-info "Relations must all belong to the same layer" {:code 400}))))

(defn bulk-create
  "Bulk-create relations. All entries in `attrs-vec` must share the same
  :relation/layer. Each entry requires :relation/source and
  :relation/target; :relation/value and :metadata are optional. Returns
  {:success true :extra <ids>} on success."
  [db attrs-vec user-id]
  (let [layer-id (-> attrs-vec first :relation/layer)
        ;; Resolve doc-id outside the tx for the operation header.
        first-source (-> attrs-vec first :relation/source)
        outer-doc-id (when first-source (get-doc-id-of-span db first-source))]
    (submit-operation!
     [tx db {:type :relation/bulk-create
             :project (when layer-id
                        (:project_id (psc/fetch-by-id db :relation_layers layer-id)))
             :document outer-doc-id
             :description (str "Bulk create " (count attrs-vec) " relations in layer " layer-id)
             :user user-id}]
     ;; Validation runs inside the tx so submit-operation* can catch
     ;; ExceptionInfo and surface a structured 4xx response.
     (check-relations-consistency! attrs-vec)
     (doseq [a attrs-vec]
       (validate-atomic-value! (:relation/value a)))
     ;; Layer existence (relation-layer is reused by every record).
     (when (nil? (psc/fetch-by-id tx :relation_layers layer-id))
       (throw (ex-info (psc/err-msg-not-found "Relation layer" layer-id)
                       {:id layer-id :code 400})))
     (let [;; One bulk fetch of every referenced span.
           all-span-ids (->> attrs-vec
                             (mapcat (fn [a] [(:relation/source a) (:relation/target a)]))
                             distinct vec)
           span-rows (psc/fetch-ids tx :spans all-span-ids)
           span-by-id (into {} (map (juxt :id identity)) span-rows)
           ;; Per-relation validation + row build.
           records (mapv
                    (fn [a]
                      (let [{:relation/keys [source target value]} a
                            source-row (clojure.core/get span-by-id source)
                            target-row (clojure.core/get span-by-id target)]
                        (check-relation-invariants! tx layer-id source target source-row target-row)
                        {:id (psc/new-uuid)
                         :relation_layer_id layer-id
                         :document_id (:document_id source-row)
                         :source_span_id source
                         :target_span_id target
                         :value (psc/write-json value)
                         ::metadata (:metadata a)}))
                    attrs-vec)
           ;; v2 contract: all relations in the batch must share a document.
           doc-ids (->> records (map :document_id) distinct)]
       (when (> (count doc-ids) 1)
         (throw (ex-info "Not all relations belong to the same document"
                         {:document-ids doc-ids :code 400})))
       (psc/insert-many! tx :relations (mapv #(dissoc % ::metadata) records))
       (doseq [r records]
         (when (seq (::metadata r))
           (metadata/insert-metadata! tx "relation" (:id r) (::metadata r))))
       (mapv :id records)))))

;; ============================================================
;; Bulk delete
;; ============================================================

(defn bulk-delete
  "Bulk-delete relations. Relations are leaves in the entity graph
  (nothing references them), so we delete each row + its entity_metadata
  and we're done."
  [db eids user-id]
  (let [eids (vec (distinct eids))
        rel-rows (psc/fetch-ids db :relations eids)
        first-row (first rel-rows)
        outer-doc-id (:document_id first-row)
        outer-project (when first-row
                        (:project_id (psc/fetch-by-id db :relation_layers
                                                      (:relation_layer_id first-row))))]
    (submit-operation!
     [tx db {:type :relation/bulk-delete
             :project outer-project
             :document outer-doc-id
             :description (str "Bulk delete " (count eids) " relations")
             :user user-id}]
     (when (seq eids)
       (let [doc-ids (->> rel-rows (map :document_id) distinct)]
         (when (> (count doc-ids) 1)
           (throw (ex-info "Not all relations belong to the same document"
                           {:document-ids doc-ids :code 400}))))
       (doseq [rid eids]
         (psc/delete-by-id! tx :relations rid))
       (psc/execute! tx
                     {:delete-from :entity_metadata
                      :where [:and
                              [:= :entity_type "relation"]
                              [:in :entity_id eids]]}))
     eids)))

;; ============================================================
;; Set endpoint (source/target swap)
;; ============================================================

(defn set-end
  "Replace one endpoint of `relation-id`. `end-key` is one of
  :relation/source or :relation/target. The new span must exist, share
  the relation's current span-layer (via the other endpoint), and share
  the relation's document. Single audited UPDATE on the relations row."
  [db eid end-key new-span-id user-id]
  (let [pre (psc/fetch-by-id db :relations eid)
        end-type (if (= end-key :relation/source) "source" "target")]
    (submit-operation!
     [tx db {:type :relation/update-endpoint
             :project (when pre (project-id db eid))
             :document (:document_id pre)
             :description (str "Update " end-type " of relation " eid
                               " to span " new-span-id)
             :user user-id}]
     ;; Validation inside the body (task #47): bad end-key and missing
     ;; relation both surface as structured 4xx via the outer catch.
     (when-not (#{:relation/source :relation/target} end-key)
       (throw (ex-info "Key must be either :relation/source or :relation/target"
                       {:code 400 :key end-key})))
     (when (nil? pre)
       (throw (ex-info (psc/err-msg-not-found "Relation" eid) {:code 404 :id eid})))
     (let [r-row (psc/fetch-by-id tx :relations eid)
           {:keys [relation_layer_id source_span_id target_span_id]} r-row
           new-source (if (= end-key :relation/source) new-span-id source_span_id)
           new-target (if (= end-key :relation/target) new-span-id target_span_id)
           new-source-row (psc/fetch-by-id tx :spans new-source)
           new-target-row (psc/fetch-by-id tx :spans new-target)]
       ;; The same invariant check used by `create` covers everything:
       ;; both spans exist, share span-layer, share document, and the
       ;; relation layer is linked to that span-layer.
       (check-relation-invariants! tx relation_layer_id
                                   new-source new-target
                                   new-source-row new-target-row)
       (let [col (if (= end-key :relation/source) :source_span_id :target_span_id)]
         (psc/update-by-id! tx :relations eid {col new-span-id}))
       eid))))
