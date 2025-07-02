(ns plaid.xtdb.vocab-link
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations! submit-operations-with-extras!]]
            [plaid.xtdb.vocab-layer :as vl]
            [plaid.xtdb.vocab-item :as vi]
            [plaid.xtdb.user :as user]
            [plaid.xtdb.project :as prj]
            [plaid.xtdb.metadata :as metadata]
            [taoensso.timbre :as log])
  (:refer-clojure :exclude [get format]))

(def attr-keys [:vocab-link/id
                :vocab-link/vocab-item
                :vocab-link/tokens])

;; reads --------------------------------------------------------------------------------
(defn format [raw-record]
  (let [core-attrs (select-keys raw-record [:vocab-link/id :vocab-link/vocab-item :vocab-link/tokens])]
    (metadata/add-metadata-to-response core-attrs raw-record "vocab-link")))

(defn get
  "Get a vocab-link by ID, formatted for external consumption (API responses)."
  [db-like id]
  (when-let [vocab-link-entity (pxc/find-entity (pxc/->db db-like) {:vocab-link/id id})]
    (format vocab-link-entity)))

(defn get-by-token
  "Get all vocab-links associated with a specific token"
  [db-like token-id]
  (let [db (pxc/->db db-like)]
    (->> (xt/q db
               '{:find [(pull ?vm [*])]
                 :where [[?vm :vocab-link/tokens ?tok]]
                 :in [?tok]}
               token-id)
         (map first)
         (map format))))

(defn get-by-vocab-item
  "Get all vocab-links for a specific vocab item"
  [db-like vocab-item-id]
  (let [db (pxc/->db db-like)]
    (->> (xt/q db
               '{:find [(pull ?vm [*])]
                 :where [[?vm :vocab-link/vocab-item ?vi]]
                 :in [?vi]}
               vocab-item-id)
         (map first)
         (map format))))

(defn get-by-vocab
  "Get all vocab-links for a specific vocab layer"
  [db-like vocab-id]
  (let [db (pxc/->db db-like)]
    (->> (xt/q db
               '{:find [(pull ?vm [*])]
                 :where [[?vm :vocab-link/vocab-item ?vi]
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
  [{:keys [db]} attrs]
  ;; Generate ID if not provided and merge with provided attrs
  (let [attrs (filter (fn [[k _]] (= "vocab-link" (namespace k))) attrs)
        {:vocab-link/keys [id vocab-item tokens] :as record} (clojure.core/merge
                                                               (pxc/new-record "vocab-link")
                                                               attrs)]

    ;; Validate vocab item exists
    (let [item (pxc/entity db vocab-item)]
      (when-not item
        (throw (ex-info (pxc/err-msg-not-found "Vocab item" vocab-item)
                        {:code 404 :id vocab-item}))))

    ;; Validate 1 or more tokens referenced
    (when (or (empty? tokens)
              (not (every? #(:token/id (pxc/entity db %)) tokens)))
      (throw (ex-info "Vocab link must reference at least one token"
                      {:code 400})))

    (let [token-records (map #(pxc/entity db %) tokens)]
      ;; Validate tokens exist
      (doseq [[token-id token-record] (map vector tokens token-records)]
        (when-not token-record
          (throw (ex-info (pxc/err-msg-not-found "Token" token-id)
                          {:code 404 :id token-id}))))
      ;; Validate tokens all belong to the same layer
      (when (> (->> token-records
                    (map :token/layer)
                    set
                    count)
               1)
        (throw (ex-info "Tokens inside vocab link must all belong to the same layer" {:code 400})))
      ;; Validate tokens all belong to the same text
      (when (> (->> token-records
                    (map :token/text)
                    set
                    count)
               1)
        (throw (ex-info "Tokens inside vocab link must all belong to the same text" {:code 400})))

      ;; Validate project is linked to vocab layer
      (let [project-id (project-id-from-token db (first tokens))
            {vocab-layer-id :vocab-item/layer} (pxc/entity db vocab-item)]
        (let [project-vocabs (set (:project/vocabs (pxc/entity db project-id)))]
          (when-not (project-vocabs vocab-layer-id)
            (throw (ex-info "Cannot create vocab link: project is not linked to the vocab layer"
                            {:code 400
                             :project-id project-id
                             :vocab-layer-id vocab-layer-id})))))

      ;; Check if vocab-link already exists
      (when (pxc/find-entity db {:vocab-link/id id})
        (throw (ex-info (pxc/err-msg-already-exists "Vocab link" id)
                        {:code 409 :id id})))
      (let [token-matches (mapv (fn [t]
                                  [::xt/match (:token/id t) t])
                                token-records)
            vocab-item-entity (pxc/entity db vocab-item)
            other-ops [[::xt/match vocab-item vocab-item-entity]
                       [::xt/match id nil]
                       [::xt/put record]]
            all-ops (into token-matches other-ops)]
        all-ops))))

(defn create-operation
  "Build an operation for creating a vocab-link"
  ([xt-map attrs]
   (create-operation xt-map attrs nil))
  ([xt-map attrs metadata]
   (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
         ;; Get project and document info from first token
         first-token-id (first (:vocab-link/tokens attrs))
         project-id (when first-token-id (project-id-from-token db first-token-id))
         document-id (when first-token-id (document-id-from-token db first-token-id))
         ;; Expand metadata into vocab-link attributes
         metadata-attrs (metadata/transform-metadata-for-storage metadata "vocab-link")
         attrs-with-metadata (clojure.core/merge attrs metadata-attrs)]
     (op/make-operation
       {:type :vocab-link/create
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
      (throw (ex-info (pxc/err-msg-not-found "Vocab link" eid)
                      {:code 404 :id eid})))
    [[::xt/match eid record]
     [::xt/delete eid]]))

(defn delete-operation
  [xt-map eid]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        vocab-link (pxc/entity db eid)
        ;; Get project and document info from first token
        first-token-id (first (:vocab-link/tokens vocab-link))
        project-id (when first-token-id (project-id-from-token db first-token-id))
        document-id (when first-token-id (document-id-from-token db first-token-id))]
    (op/make-operation
      {:type :vocab-link/delete
       :description "Delete vocab mapping"
       :tx-ops (delete* xt-map eid)
       :project project-id
       :document document-id})))

(defn delete
  [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

;; Metadata operations ----------------------------------------------------------------
(defn set-metadata*
  "Build transaction ops for replacing all metadata on a vocab-link"
  [xt-map eid metadata]
  (metadata/set-metadata-tx-ops* xt-map eid metadata "vocab-link"))

(defn set-metadata-operation
  "Build an operation for replacing all metadata on a vocab-link"
  [xt-map eid metadata]
  (letfn [(project-id-fn [db eid]
            (let [vocab-link (pxc/entity db eid)
                  first-token-id (first (:vocab-link/tokens vocab-link))]
              (when first-token-id (project-id-from-token db first-token-id))))
          (document-id-fn [db vocab-link]
            (let [first-token-id (first (:vocab-link/tokens vocab-link))]
              (when first-token-id (document-id-from-token db first-token-id))))]
    (metadata/make-set-metadata-operation xt-map eid metadata "vocab-link" project-id-fn document-id-fn)))

(defn set-metadata [xt-map eid metadata user-id]
  (letfn [(project-id-fn [db eid]
            (let [vocab-link (pxc/entity db eid)
                  first-token-id (first (:vocab-link/tokens vocab-link))]
              (when first-token-id (project-id-from-token db first-token-id))))
          (document-id-fn [db vocab-link]
            (let [first-token-id (first (:vocab-link/tokens vocab-link))]
              (when first-token-id (document-id-from-token db first-token-id))))]
    (metadata/set-metadata xt-map eid metadata user-id "vocab-link" project-id-fn document-id-fn)))

(defn delete-metadata*
  "Build transaction ops for removing all metadata from a vocab-link"
  [xt-map eid]
  (metadata/delete-metadata-tx-ops* xt-map eid "vocab-link"))

(defn delete-metadata-operation
  "Build an operation for removing all metadata from a vocab-link"
  [xt-map eid]
  (letfn [(project-id-fn [db eid]
            (let [vocab-link (pxc/entity db eid)
                  first-token-id (first (:vocab-link/tokens vocab-link))]
              (when first-token-id (project-id-from-token db first-token-id))))
          (document-id-fn [db vocab-link]
            (let [first-token-id (first (:vocab-link/tokens vocab-link))]
              (when first-token-id (document-id-from-token db first-token-id))))]
    (metadata/make-delete-metadata-operation xt-map eid "vocab-link" project-id-fn document-id-fn)))

(defn delete-metadata [xt-map eid user-id]
  (letfn [(project-id-fn [db eid]
            (let [vocab-link (pxc/entity db eid)
                  first-token-id (first (:vocab-link/tokens vocab-link))]
              (when first-token-id (project-id-from-token db first-token-id))))
          (document-id-fn [db vocab-link]
            (let [first-token-id (first (:vocab-link/tokens vocab-link))]
              (when first-token-id (document-id-from-token db first-token-id))))]
    (metadata/delete-metadata xt-map eid user-id "vocab-link" project-id-fn document-id-fn)))
