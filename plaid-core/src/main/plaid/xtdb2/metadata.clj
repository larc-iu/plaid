(ns plaid.xtdb2.metadata
  "Shared utilities for handling metadata across different entity types.

   Metadata is stored as a single JSON string in :entity-type/metadata.
   - External: {'confidence' 0.95, 'source' 'model'}
   - Internal: {:span/metadata \"{\\\"confidence\\\":0.95,\\\"source\\\":\\\"model\\\"}\"
   - Response: {:metadata {'confidence' 0.95, 'source' 'model'}}"
  (:require [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.operation :as op :refer [submit-operations!]]
            [clojure.data.json :as json])
  (:refer-clojure :exclude [get]))

;; Metadata extraction and transformation ------------------------------------------

(defn- parse-metadata
  "Parse a metadata value from storage. Handles JSON strings and maps (legacy)."
  [v]
  (cond
    (string? v) (json/read-str v)
    (map? v)    v
    :else       nil))

(defn- serialize-metadata
  "Serialize a metadata map to a JSON string for storage."
  [m]
  (json/write-str (or m {})))

(defn add-metadata-to-response
  "Add metadata to an entity response map if metadata exists."
  [core-attrs entity entity-type]
  (let [meta-key (keyword entity-type "metadata")
        raw-val  (clojure.core/get entity meta-key)]
    (if-let [parsed (when raw-val (parse-metadata raw-val))]
      (if (empty? parsed)
        core-attrs
        (assoc core-attrs :metadata parsed))
      core-attrs)))

(defn transform-metadata-for-storage
  "Transform external metadata map to internal entity attribute."
  [metadata entity-type]
  (when metadata
    {(keyword entity-type "metadata") (serialize-metadata metadata)}))

;; Transaction operation builders -----------------------------------------------

(defn set-metadata-tx-ops*
  "Build transaction ops for replacing all metadata on an entity."
  [xt-map eid metadata entity-type]
  (let [node     (pxc/->node xt-map)
        table    (pxc/entity-table (keyword entity-type "id"))
        id-key   (keyword entity-type "id")
        existing (pxc/entity-with-sys-from node table eid)
        updates  (transform-metadata-for-storage metadata entity-type)]
    (pxc/merge* xt-map table id-key eid updates existing)))

(defn delete-metadata-tx-ops*
  "Build transaction ops for removing all metadata from an entity."
  [xt-map eid entity-type]
  (let [node     (pxc/->node xt-map)
        table    (pxc/entity-table (keyword entity-type "id"))
        id-key   (keyword entity-type "id")
        existing (pxc/entity-with-sys-from node table eid)
        meta-key (keyword entity-type "metadata")]
    (pxc/merge* xt-map table id-key eid {meta-key nil} existing)))

;; Generic operation builders ---------------------------------------------------

(defn make-set-metadata-operation
  "Build an operation for replacing all metadata on an entity."
  [xt-map eid metadata entity-type project-id-fn document-id-fn]
  (let [node       (pxc/->node xt-map)
        table      (pxc/entity-table (keyword entity-type "id"))
        entity     (pxc/entity node table eid)
        project-id (project-id-fn node eid)
        doc-id     (document-id-fn entity)
        tx-ops     (set-metadata-tx-ops* xt-map eid metadata entity-type)
        op-type    (keyword entity-type "set-metadata")]
    (op/make-operation
     {:type        op-type
      :project     project-id
      :document    doc-id
      :description (str "Set metadata on " entity-type " " eid " with " (count metadata) " keys")
      :tx-ops      tx-ops})))

(defn make-delete-metadata-operation
  "Build an operation for removing all metadata from an entity."
  [xt-map eid entity-type project-id-fn document-id-fn]
  (let [node       (pxc/->node xt-map)
        table      (pxc/entity-table (keyword entity-type "id"))
        entity     (pxc/entity node table eid)
        project-id (project-id-fn node eid)
        doc-id     (document-id-fn entity)
        tx-ops     (delete-metadata-tx-ops* xt-map eid entity-type)
        op-type    (keyword entity-type "delete-metadata")]
    (op/make-operation
     {:type        op-type
      :project     project-id
      :document    doc-id
      :description (str "Delete all metadata from " entity-type " " eid)
      :tx-ops      tx-ops})))

;; Generic metadata management functions ----------------------------------------

(def ^:private valid-entity-types
  #{"document" "text" "token" "span" "relation" "vocab-item" "vocab-link"})

(defn- validate-entity-type! [entity-type]
  (when-not (valid-entity-types entity-type)
    (throw (ex-info (str "Entity type '" entity-type "' does not support metadata operations.")
                    {:entity-type entity-type :code 400}))))

(defn set-metadata
  "Set metadata on an entity using the generic metadata system."
  [xt-map eid metadata user-id entity-type project-id-fn document-id-fn]
  (validate-entity-type! entity-type)
  (submit-operations! xt-map
                      [(make-set-metadata-operation xt-map eid metadata entity-type
                                                    project-id-fn document-id-fn)]
                      user-id))

(defn delete-metadata
  "Delete all metadata from an entity using the generic metadata system."
  [xt-map eid user-id entity-type project-id-fn document-id-fn]
  (validate-entity-type! entity-type)
  (submit-operations! xt-map
                      [(make-delete-metadata-operation xt-map eid entity-type
                                                       project-id-fn document-id-fn)]
                      user-id))
