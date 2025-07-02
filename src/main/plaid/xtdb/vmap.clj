(ns plaid.xtdb.vmap
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations! submit-operations-with-extras!]]
            [plaid.xtdb.vocab-layer :as vl]
            [plaid.xtdb.vocab-item :as vi]
            [plaid.xtdb.user :as user]
            [plaid.xtdb.project :as prj]
            [plaid.xtdb.metadata :as metadata]
            [taoensso.timbre :as log])
  (:refer-clojure :exclude [get]))

(def attr-keys [:vmap/id
                :vmap/vocab-item
                :vmap/tokens])

;; reads --------------------------------------------------------------------------------
(defn format [raw-record]
  (let [core-attrs (select-keys raw-record [:vmap/id :vmap/vocab-item :vmap/tokens])]
    (metadata/add-metadata-to-response core-attrs raw-record "vmap")))

(defn get
  "Get a vmap by ID, formatted for external consumption (API responses)."
  [db-like id]
  (when-let [vmap-entity (pxc/find-entity (pxc/->db db-like) {:vmap/id id})]
    (format vmap-entity)))

(defn get-by-token
  "Get all vmaps associated with a specific token"
  [db-like token-id]
  (let [db (pxc/->db db-like)]
    (->> (xt/q db
               '{:find [(pull ?vm [*])]
                 :where [[?vm :vmap/tokens ?tok]]
                 :in [?tok]}
               token-id)
         (map first)
         (map format))))

(defn get-by-vocab-item
  "Get all vmaps for a specific vocab item"
  [db-like vocab-item-id]
  (let [db (pxc/->db db-like)]
    (->> (xt/q db
               '{:find [(pull ?vm [*])]
                 :where [[?vm :vmap/vocab-item ?vi]]
                 :in [?vi]}
               vocab-item-id)
         (map first)
         (map format))))

(defn get-by-vocab
  "Get all vmaps for a specific vocab layer"
  [db-like vocab-id]
  (let [db (pxc/->db db-like)]
    (->> (xt/q db
               '{:find [(pull ?vm [*])]
                 :where [[?vm :vmap/vocab-item ?vi]
                         [?vi :vocab-item/layer ?v]]
                 :in [?v]}
               vocab-id)
         (map first)
         (map format))))

;; Helper to get project ID from token
(defn project-id-from-token
  [db-like token-id]
  (-> (xt/q (pxc/->db db-like)
            '{:find [?prj]
              :where [[?prj :project/text-layers ?txtl]
                      [?txtl :text-layer/token-layers ?tokl]
                      [?tok :token/layer ?tokl]]
              :in [?tok]}
            token-id)
      first
      first))

;; Helper to get document ID from token
(defn document-id-from-token
  [db-like token-id]
  (-> (xt/q (pxc/->db db-like)
            '{:find [?doc]
              :where [[?tok :token/text ?txt]
                      [?txt :text/document ?doc]]
              :in [?tok]}
            token-id)
      first
      first))

;; writes --------------------------------------------------------------------------------
(defn create*
  [{:keys [db]} {:vmap/keys [id vocab-item tokens] :as attrs}]
  ;; Validate vocab item exists
  (let [item (pxc/entity db vocab-item)]
    (when-not item
      (throw (ex-info (pxc/err-msg-not-found "Vocab item" vocab-item)
                      {:code 404 :id vocab-item}))))

  ;; Validate 1 or more tokens referenced
  (when (empty? tokens)
    (throw (ex-info "VMap must reference at least one token"
                    {:code 400})))

  (let [token-records (map #(pxc/entity db %) tokens)]
    ;; Validate token exists
    (doseq [token-record token-records]
      (when-not token-record
        (throw (ex-info (pxc/err-msg-not-found "Token" (:token/id token-record))
                        {:code 404 :id (:token/id token-record)}))))
    ;; Validate tokens all belong to the same layer
    (when (> (->> token-records
                  (map :token/layer)
                  set
                  count)
             1)
      (throw (ex-info "Tokens inside VMap must all belong to the same layer" {:code 400})))
    ;; Validate tokens all belong to the same text
    (when (> (->> token-records
                  (map :token/text)
                  set
                  count)
             1)
      (throw (ex-info "Tokens inside VMap must all belong to the same text" {:code 400})))

    ;; Check if vmap already exists
    (when (pxc/find-entity db {:vmap/id id})
      (throw (ex-info (pxc/err-msg-already-exists "VMap" id)
                      {:code 409 :id id})))
    (let [record (pxc/create-record "vmap" id attrs attr-keys)]
      (into
        (mapv (fn [t] [::xt/match (:token/id t) t]) token-records)
        [[::xt/match vocab-item (pxc/entity db vocab-item)]
         [::xt/match id nil]
         [::xt/put record]]))))

(defn create-operation
  "Build an operation for creating a vmap"
  ([xt-map attrs]
   (create-operation xt-map attrs nil))
  ([xt-map attrs metadata]
   (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
         ;; Get project and document info from first token
         first-token-id (first (:vmap/tokens attrs))
         project-id (when first-token-id (project-id-from-token db first-token-id))
         document-id (when first-token-id (document-id-from-token db first-token-id))
         ;; Expand metadata into vmap attributes
         metadata-attrs (metadata/transform-metadata-for-storage metadata "vmap")
         attrs-with-metadata (clojure.core/merge attrs metadata-attrs)]
     (op/make-operation
       {:type :vmap/create
        :description (str "Create vocab mapping" 
                          (when metadata (str " with " (count metadata) " metadata keys")))
        :tx-ops (create* xt-map attrs-with-metadata)
        :project project-id
        :document document-id}))))

(defn create
  ([xt-map attrs user-id]
   (create xt-map attrs user-id nil))
  ([xt-map attrs user-id metadata]
   (submit-operations-with-extras! xt-map [(create-operation xt-map attrs metadata)] user-id #(-> % last last :xt/id))))

(defn delete*
  [{:keys [db]} eid]
  (let [record (pxc/entity db eid)]
    (when-not record
      (throw (ex-info (pxc/err-msg-not-found "VMap" eid)
                      {:code 404 :id eid})))
    [[::xt/match eid record]
     [::xt/delete eid]]))

(defn delete-operation
  [xt-map eid]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        vmap (pxc/entity db eid)
        ;; Get project and document info from first token
        first-token-id (first (:vmap/tokens vmap))
        project-id (when first-token-id (project-id-from-token db first-token-id))
        document-id (when first-token-id (document-id-from-token db first-token-id))]
    (op/make-operation
      {:type :vmap/delete
       :description "Delete vocab mapping"
       :tx-ops (delete* xt-map eid)
       :project project-id
       :document document-id})))

(defn delete
  [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

;; Metadata operations ----------------------------------------------------------------
(defn set-metadata*
  "Build transaction ops for replacing all metadata on a vmap"
  [xt-map eid metadata]
  (metadata/set-metadata-tx-ops* xt-map eid metadata "vmap"))

(defn set-metadata-operation
  "Build an operation for replacing all metadata on a vmap"
  [xt-map eid metadata]
  (letfn [(project-id-fn [db eid] 
            (let [vmap (pxc/entity db eid)
                  first-token-id (first (:vmap/tokens vmap))]
              (when first-token-id (project-id-from-token db first-token-id))))
          (document-id-fn [db vmap] 
            (let [first-token-id (first (:vmap/tokens vmap))]
              (when first-token-id (document-id-from-token db first-token-id))))]
    (metadata/make-set-metadata-operation xt-map eid metadata "vmap" project-id-fn document-id-fn)))

(defn set-metadata [xt-map eid metadata user-id]
  (letfn [(project-id-fn [db eid] 
            (let [vmap (pxc/entity db eid)
                  first-token-id (first (:vmap/tokens vmap))]
              (when first-token-id (project-id-from-token db first-token-id))))
          (document-id-fn [db vmap] 
            (let [first-token-id (first (:vmap/tokens vmap))]
              (when first-token-id (document-id-from-token db first-token-id))))]
    (metadata/set-metadata xt-map eid metadata user-id "vmap" project-id-fn document-id-fn)))

(defn delete-metadata*
  "Build transaction ops for removing all metadata from a vmap"
  [xt-map eid]
  (metadata/delete-metadata-tx-ops* xt-map eid "vmap"))

(defn delete-metadata-operation
  "Build an operation for removing all metadata from a vmap"
  [xt-map eid]
  (letfn [(project-id-fn [db eid] 
            (let [vmap (pxc/entity db eid)
                  first-token-id (first (:vmap/tokens vmap))]
              (when first-token-id (project-id-from-token db first-token-id))))
          (document-id-fn [db vmap] 
            (let [first-token-id (first (:vmap/tokens vmap))]
              (when first-token-id (document-id-from-token db first-token-id))))]
    (metadata/make-delete-metadata-operation xt-map eid "vmap" project-id-fn document-id-fn)))

(defn delete-metadata [xt-map eid user-id]
  (letfn [(project-id-fn [db eid] 
            (let [vmap (pxc/entity db eid)
                  first-token-id (first (:vmap/tokens vmap))]
              (when first-token-id (project-id-from-token db first-token-id))))
          (document-id-fn [db vmap] 
            (let [first-token-id (first (:vmap/tokens vmap))]
              (when first-token-id (document-id-from-token db first-token-id))))]
    (metadata/delete-metadata xt-map eid user-id "vmap" project-id-fn document-id-fn)))
