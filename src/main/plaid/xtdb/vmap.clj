(ns plaid.xtdb.vmap
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations! submit-operations-with-extras!]]
            [plaid.xtdb.vocab-layer :as vl]
            [plaid.xtdb.vocab-item :as vi]
            [plaid.xtdb.user :as user]
            [plaid.xtdb.project :as prj]
            [taoensso.timbre :as log])
  (:refer-clojure :exclude [get]))

(def attr-keys [:vmap/id
                :vmap/vocab-item
                :vmap/tokens])

;; reads --------------------------------------------------------------------------------
(defn get
  [db-like id]
  (-> (pxc/find-entity (pxc/->db db-like) {:vmap/id id})
      (dissoc :xt/id)))

(defn get-by-token
  "Get all vmaps associated with a specific token"
  [db-like token-id]
  (let [db (pxc/->db db-like)]
    (map first (xt/q db
                     '{:find [(pull ?vm [:vmap/id :vmap/vocab-item :vmap/tokens])]
                       :where [[?vm :vmap/tokens ?tok]]
                       :in [?tok]}
                     token-id))))

(defn get-by-vocab-item
  "Get all vmaps for a specific vocab item"
  [db-like vocab-item-id]
  (let [db (pxc/->db db-like)]
    (map first (xt/q db
                     '{:find [(pull ?vm [:vmap/id :vmap/vocab-item :vmap/tokens])]
                       :where [[?vm :vmap/vocab-item ?vi]]
                       :in [?vi]}
                     vocab-item-id))))

(defn get-by-vocab
  "Get all vmaps for a specific vocab layer"
  [db-like vocab-id]
  (let [db (pxc/->db db-like)]
    (map first (xt/q db
                     '{:find [(pull ?vm [:vmap/id :vmap/vocab-item :vmap/tokens])]
                       :where [[?vm :vmap/vocab-item ?vi]
                               [?vi :vocab-item/layer ?v]]
                       :in [?v]}
                     vocab-id))))

;; Helper to get project ID from token
(defn- project-id-from-token
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

;; writes --------------------------------------------------------------------------------
(defn create*
  [xt-map {:vmap/keys [id vocab-item tokens] :as attrs}]
  (let [{:keys [node db]} (pxc/ensure-db xt-map)]
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
           [::xt/put record]])))))

(defn create-operation
  [xt-map attrs]
  (let [{:keys [db]} xt-map
        ;; Get project and document info from first token
        first-token-id (first (:vmap/tokens attrs))
        project-id (when first-token-id (project-id-from-token db first-token-id))
        document-id (when first-token-id (:token/document (pxc/entity db first-token-id)))]
    (op/make-operation
      {:type :vmap/create
       :description "Create vocab mapping"
       :tx-ops (create* xt-map attrs)
       :project project-id
       :document document-id})))

(defn create
  [xt-map attrs user-id]
  (submit-operations! xt-map [(create-operation xt-map attrs)] user-id))

(defn delete*
  [xt-map eid]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        record (pxc/entity db eid)]
    (when-not record
      (throw (ex-info (pxc/err-msg-not-found "VMap" eid)
                      {:code 404 :id eid})))
    [[::xt/match eid record]
     [::xt/delete eid]]))

(defn delete-operation
  [xt-map eid]
  (let [{:keys [db]} xt-map
        vmap (pxc/entity db eid)
        ;; Get project and document info from first token
        first-token-id (first (:vmap/tokens vmap))
        project-id (when first-token-id (project-id-from-token db first-token-id))
        document-id (when first-token-id (:token/document (pxc/entity db first-token-id)))]
    (op/make-operation
      {:type :vmap/delete
       :description "Delete vocab mapping"
       :tx-ops (delete* xt-map eid)
       :project project-id
       :document document-id})))

(defn delete
  [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

;; Bulk operations --------------------------------------------------------------------------------
(defn delete-by-token*
  "Delete all vmaps associated with a token"
  [xt-map token-id]
  (let [{:keys [db]} xt-map
        vmaps (get-by-token db token-id)]
    (mapcat #(delete* xt-map (:vmap/id %)) vmaps)))

(defn delete-by-vocab-item*
  "Delete all vmaps associated with a vocab item"
  [xt-map vocab-item-id]
  (let [{:keys [db]} xt-map
        vmaps (get-by-vocab-item db vocab-item-id)]
    (mapcat #(delete* xt-map (:vmap/id %)) vmaps)))