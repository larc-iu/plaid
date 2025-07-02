(ns plaid.xtdb.metadata
  "Shared utilities for handling metadata across different entity types.
   
   Metadata is stored as entity attributes with a special naming convention:
   - External: {'confidence' 0.95, 'source' 'model'}
   - Internal: {:span/_confidence 0.95, :span/_source 'model'}
   - Response: {:metadata {'confidence' 0.95, 'source' 'model'}}"
  (:require [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations!]]
            [clojure.string :as str])
  (:refer-clojure :exclude [get]))

;; Metadata extraction and transformation ------------------------------------------

(defn extract-metadata-from-entity
  "Extract metadata attributes from an entity, returning them as a plain map.
   
   Args:
     entity - The entity map from XTDB
     entity-type - The entity type namespace (e.g. 'span', 'relation', 'token', 'text')
   
   Returns:
     Map of metadata keys to values, or empty map if no metadata"
  [entity entity-type]
  (->> entity
       (filter (fn [[k v]]
                 (and (= entity-type (namespace k))
                      (str/starts-with? (name k) "_")
                      (not (nil? v)))))
       (reduce (fn [m [k v]]
                 (assoc m (subs (name k) 1) v))
               {})))

(defn add-metadata-to-response
  "Add metadata to an entity response map if metadata exists.
   
   Args:
     core-attrs - The core entity attributes map
     entity - The full entity from XTDB
     entity-type - The entity type namespace (e.g. 'span', 'relation', 'token', 'text')
   
   Returns:
     Core attributes with :metadata key added if metadata exists"
  [core-attrs entity entity-type]
  (let [metadata-attrs (extract-metadata-from-entity entity entity-type)]
    (if (empty? metadata-attrs)
      core-attrs
      (assoc core-attrs :metadata metadata-attrs))))

(defn transform-metadata-for-storage
  "Transform external metadata map to internal entity attributes.
   
   Args:
     metadata - External metadata map (e.g. {'confidence' 0.95})
     entity-type - The entity type namespace (e.g. 'span', 'relation')
   
   Returns:
     Map of entity attributes (e.g. {:span/_confidence 0.95})"
  [metadata entity-type]
  (when metadata
    (reduce-kv (fn [m k v]
                 (assoc m (keyword entity-type (str "_" k)) v))
               {}
               metadata)))

(defn find-existing-metadata-keys
  "Find all existing metadata attribute keys for an entity.
   
   Args:
     entity - The entity map from XTDB
     entity-type - The entity type namespace
   
   Returns:
     Vector of metadata attribute keywords"
  [entity entity-type]
  (->> entity
       (filter (fn [[k _v]]
                 (and (= entity-type (namespace k))
                      (str/starts-with? (name k) "_"))))
       (map first)
       vec))

;; Transaction operation builders -----------------------------------------------

(defn set-metadata-tx-ops*
  "Build transaction ops for replacing all metadata on an entity.
   
   This is a complete replacement - existing metadata keys not in the new
   metadata map will be cleared (set to nil).
   
   Args:
     xt-map - Database connection map
     eid - Entity ID
     metadata - New metadata map
     entity-type - The entity type namespace
   
   Returns:
     Vector of transaction operations"
  [xt-map eid metadata entity-type]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        existing-entity (pxc/entity db eid)
        old-metadata-keys (find-existing-metadata-keys existing-entity entity-type)
        new-metadata (transform-metadata-for-storage metadata entity-type)
        clear-old (reduce (fn [m k] (assoc m k nil)) {} old-metadata-keys)
        final-updates (clojure.core/merge clear-old new-metadata)]
    (pxc/merge* xt-map eid final-updates)))

(defn delete-metadata-tx-ops*
  "Build transaction ops for removing all metadata from an entity.
   
   Args:
     xt-map - Database connection map  
     eid - Entity ID
     entity-type - The entity type namespace
   
   Returns:
     Vector of transaction operations"
  [xt-map eid entity-type]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        existing-entity (pxc/entity db eid)
        old-metadata-keys (find-existing-metadata-keys existing-entity entity-type)
        clear-updates (reduce (fn [m k] (assoc m k nil)) {} old-metadata-keys)]
    (pxc/merge* xt-map eid clear-updates)))

;; Generic operation builders ---------------------------------------------------

(defn make-set-metadata-operation
  "Build an operation for replacing all metadata on an entity.
   
   Args:
     xt-map - Database connection map
     eid - Entity ID
     metadata - New metadata map
     entity-type - The entity type namespace (e.g. 'span', 'relation')
     project-id-fn - Function to get project ID from entity ID: (fn [db eid] -> uuid)
     document-id-fn - Function to get document ID from entity: (fn [db entity] -> uuid)
   
   Returns:
     Operation map ready for submission"
  [xt-map eid metadata entity-type project-id-fn document-id-fn]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        entity (pxc/entity db eid)
        project-id (project-id-fn db eid)
        doc-id (document-id-fn db entity)
        tx-ops (set-metadata-tx-ops* xt-map eid metadata entity-type)
        op-type (keyword entity-type "set-metadata")]
    (op/make-operation
     {:type op-type
      :project project-id
      :document doc-id
      :description (str "Set metadata on " entity-type " " eid " with " (count metadata) " keys")
      :tx-ops tx-ops})))

(defn make-delete-metadata-operation
  "Build an operation for removing all metadata from an entity.
   
   Args:
     xt-map - Database connection map
     eid - Entity ID
     entity-type - The entity type namespace (e.g. 'span', 'relation')
     project-id-fn - Function to get project ID from entity ID: (fn [db eid] -> uuid)
     document-id-fn - Function to get document ID from entity: (fn [db entity] -> uuid)
   
   Returns:
     Operation map ready for submission"
  [xt-map eid entity-type project-id-fn document-id-fn]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        entity (pxc/entity db eid)
        project-id (project-id-fn db eid)
        doc-id (document-id-fn db entity)
        tx-ops (delete-metadata-tx-ops* xt-map eid entity-type)
        op-type (keyword entity-type "delete-metadata")]
    (op/make-operation
     {:type op-type
      :project project-id
      :document doc-id
      :description (str "Delete all metadata from " entity-type " " eid)
      :tx-ops tx-ops})))

;; Entity type validation -------------------------------------------------------

(def ^:private valid-entity-types
  "Set of entity types that support metadata"
  #{"document" "text" "token" "span" "relation" "vocab-item" "vmap"})

(defn- validate-entity-type!
  "Validate that the entity type supports metadata operations"
  [entity-type]
  (when-not (valid-entity-types entity-type)
    (throw (ex-info (str "Entity type '" entity-type "' does not support metadata operations. "
                         "Supported types: " (clojure.string/join ", " (sort valid-entity-types)))
                    {:entity-type entity-type
                     :supported-types valid-entity-types
                     :code 400}))))

;; Generic metadata management functions ----------------------------------------

(defn set-metadata
  "Set metadata on an entity using the generic metadata system.
   
   Args:
     xt-map - Database connection map
     eid - Entity ID
     metadata - New metadata map
     user-id - User performing the operation
     entity-type - The entity type namespace (e.g. 'span', 'relation', 'token', 'text')
     project-id-fn - Function to get project ID from entity ID
     document-id-fn - Function to get document ID from entity
   
   Returns:
     Result of operation submission"
  [xt-map eid metadata user-id entity-type project-id-fn document-id-fn]
  (validate-entity-type! entity-type)
  (submit-operations! xt-map
                      [(make-set-metadata-operation xt-map eid metadata entity-type
                                                    project-id-fn document-id-fn)]
                      user-id))

(defn delete-metadata
  "Delete all metadata from an entity using the generic metadata system.
   
   Args:
     xt-map - Database connection map
     eid - Entity ID
     user-id - User performing the operation
     entity-type - The entity type namespace (e.g. 'span', 'relation', 'token', 'text')
     project-id-fn - Function to get project ID from entity ID
     document-id-fn - Function to get document ID from entity
   
   Returns:
     Result of operation submission"
  [xt-map eid user-id entity-type project-id-fn document-id-fn]
  (validate-entity-type! entity-type)
  (submit-operations! xt-map
                      [(make-delete-metadata-operation xt-map eid entity-type
                                                       project-id-fn document-id-fn)]
                      user-id))