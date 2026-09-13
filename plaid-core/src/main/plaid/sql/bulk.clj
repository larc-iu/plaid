(ns plaid.sql.bulk
  "The one bulk-update path, shared by spans, relations and tokens.

  `PATCH /spans/bulk`, `/relations/bulk` and `/tokens/bulk` are the same
  operation over three tables: set values, patch metadata, refuse an
  unknown id, and bump every document the entries touch. The three
  namespaces differ only in the table, the layer table that carries the
  project id, the audit op type, and whether the entity has a value at
  all, so they hand those in as a spec map instead of each keeping a
  copy of the body.

  Not in `plaid.sql.common`: this needs `plaid.sql.operation` and
  `plaid.sql.metadata`, both of which require common."
  (:require [clojure.string :as str]
            [plaid.server.locks :as locks]
            [plaid.sql.common :as psc]
            [plaid.sql.metadata :as metadata]
            [plaid.sql.operation :as op :refer [submit-operation!]]))

(defn- project-id-of-row
  "Project id of one entity row, via the denormalized project_id on its layer."
  [db {:keys [layer-key layer-table]} row]
  (when row
    (:project_id (psc/fetch-by-id db layer-table (layer-key row)))))

(defn- project-ids
  "Distinct project ids the rows belong to. One lookup per distinct LAYER,
  not per entity, so a bulk of thousands costs a handful of reads."
  [tx {:keys [layer-key layer-table]} rows]
  (->> rows
       (map layer-key)
       distinct
       (map #(:project_id (psc/fetch-by-id tx layer-table %)))
       distinct))

(defn bulk-update!
  "Update the value of, and/or patch the metadata on, many entities of one
  kind in ONE operation. `items` is a vector of maps, each with `:id` and
  either or both of `:value` (set when the key is PRESENT, so nil means
  JSON null) and `:metadata` (a patch with `plaid.sql.metadata/patch-metadata!`
  semantics: a nil value deletes that key).

  The entities may lie in several documents of one project: every document
  touched has its version bumped and its lock checked, and the operation
  header names a document only when there is exactly one, so the OCC
  middleware and document-scoped events see it as a single-document op.
  `?document-version=` speaks for one document, so it is refused outright
  once the entries reach more than one.

  Unknown ids are refused (404) rather than dropped: an update that
  silently skips an entity the caller named would leave the caller
  believing it landed.

  `spec` is `{:table :entity-type :layer-table :layer-key :op-type :noun
  :values?}`. Returns `{:count n :documents [doc-id …]}`."
  [db items user-id {:keys [table entity-type op-type noun values?] :as spec}]
  (let [ids (mapv :id items)
        pre-rows (psc/fetch-ids db table ids)
        pre-doc-ids (distinct (map :document_id pre-rows))
        Noun (str/capitalize noun)]
    (submit-operation!
     [tx db {:type op-type
             :project (project-id-of-row db spec (first pre-rows))
             :document (when (= 1 (count pre-doc-ids)) (first pre-doc-ids))
             :description (str "Bulk update " (count items) " " noun "s")
             :user user-id}]
     (when (empty? items)
       (throw (ex-info (str Noun " list is empty") {:code 400})))
     (when (not= (count ids) (count (distinct ids)))
       (throw (ex-info (str "A " noun " may appear only once in a bulk update") {:code 400})))
     (when-not values?
       (when (some #(contains? % :value) items)
         (throw (ex-info (str "A " noun " has no value to update") {:code 400}))))
     (metadata/validate-entity-type! entity-type)
     (let [rows (psc/fetch-ids tx table ids)
           by-id (into {} (map (juxt :id identity)) rows)
           missing (remove by-id ids)]
       (when (seq missing)
         (throw (ex-info (str Noun "s not found: " (str/join ", " missing))
                         {:code 404 :ids (vec missing)})))
       (when (not= 1 (count (project-ids tx spec rows)))
         (throw (ex-info (str Noun "s must all belong to one project") {:code 400})))
       (when values?
         (doseq [it items :when (contains? it :value)]
           (psc/validate-atomic-value! Noun (:value it))))
       (let [doc-ids (vec (distinct (map :document_id rows)))]
         (when (> (count doc-ids) 1)
           (when psc/*expected-document-version*
             (throw (ex-info (str "document-version names one document, and this update reaches "
                                  (count doc-ids) ". Send it without document-version, or one "
                                  "request per document.")
                             {:code 400 :document-ids doc-ids})))
           (let [result (locks/check-document-locks doc-ids user-id)]
             (when (not= :ok result)
               (throw (ex-info (str "Document " (:document-id result) " is locked by " (:user-id result))
                               {:code 423 :document-id (:document-id result) :locked-by (:user-id result)})))))
         (when values?
           (let [value-pairs (vec (for [it items :when (contains? it :value)]
                                    [(:id it) {:value (psc/write-json (:value it))}]))]
             (when (seq value-pairs)
               (psc/bulk-update-by-id! tx table value-pairs))))
         (doseq [it items :when (seq (:metadata it))]
           (metadata/patch-metadata! tx entity-type (:id it) (:metadata it)))
         (when (> (count doc-ids) 1)
           (op/bump-document-versions! tx doc-ids))
         {:count (count items) :documents doc-ids})))))
