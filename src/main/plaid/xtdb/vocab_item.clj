(ns plaid.xtdb.vocab-item
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations! submit-operations-with-extras!]]
            [plaid.xtdb.vocab-layer :as vl]
            [plaid.xtdb.user :as user]
            [plaid.xtdb.metadata :as metadata]
            [taoensso.timbre :as log])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:vocab-item/id
                :vocab-item/layer
                :vocab-item/form])

;; reads --------------------------------------------------------------------------------
(defn get
  [db-like id]
  (when-let [item-entity (pxc/find-entity (pxc/->db db-like) {:vocab-item/id id})]
    (let [core-attrs (select-keys item-entity attr-keys)]
      (metadata/add-metadata-to-response core-attrs item-entity "vocab-item"))))

(defn get-all-in-layer
  "Get all vocab items in a specific vocab layer"
  [db-like layer-id]
  (let [db (pxc/->db db-like)]
    (->> (xt/q db
               '{:find [e]
                 :where [[?e :vocab-item/layer ?layer]]
                 :in [?layer]}
               layer-id)
         (map first)
         (mapv (partial get db)))))

;; writes --------------------------------------------------------------------------------
(defn create*
  [xt-map attrs]
  (let [{:keys [node db]} xt-map
        attrs (filter (fn [[k _]] (= "vocab-item" (namespace k))) attrs)
        {:vocab-item/keys [id layer] :as record} (clojure.core/merge (pxc/new-record "vocab-item")
                                                                     (into {} attrs))]
    ;; Check if vocab layer exists
    (when-not (pxc/entity db layer)
      (throw (ex-info (pxc/err-msg-not-found "Vocab layer" layer)
                      {:code 404 :id layer})))
    ;; Check if item already exists
    (when (pxc/find-entity db {:vocab-item/id id})
      (throw (ex-info (pxc/err-msg-already-exists "Vocab item" id)
                      {:code 409 :id id})))
    [[::xt/match layer (pxc/entity db layer)]
     [::xt/match id nil]
     [::xt/put record]]))

(defn create-operation
  [xt-map attrs metadata]
  (let [metadata-attrs (metadata/transform-metadata-for-storage metadata "vocab-item")
        attrs-with-metadata (clojure.core/merge attrs metadata-attrs)]
    (op/make-operation
      {:type :vocab-item/create
       :description (format "Create vocab item '%s'" (:vocab-item/form attrs))
       :tx-ops (create* xt-map attrs-with-metadata)
       :project nil
       :document nil})))

(defn create
  ([xt-map attrs user-id]
   (create xt-map attrs user-id nil))
  ([xt-map attrs user-id metadata]
   (submit-operations-with-extras! xt-map [(create-operation xt-map attrs metadata)] user-id #(-> % last last :xt/id))))

(defn merge-operation
  [xt-map eid m]
  (let [{:keys [db]} xt-map
        current (pxc/entity db eid)]
    (when-not current
      (throw (ex-info (pxc/err-msg-not-found "Vocab item" eid)
                      {:code 404 :id eid})))
    ;; If changing form, check uniqueness
    (op/make-operation
      {:type :vocab-item/merge
       :description (format "Update vocab item '%s'" (:vocab-item/form current))
       :tx-ops (pxc/merge* xt-map eid m)
       :project nil
       :document nil})))

(defn merge
  [{:keys [node db] :as xt-map} eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(defn delete*
  [xt-map eid]
  (let [{:keys [db]} xt-map
        record (pxc/entity db eid)]
    (when-not record
      (throw (ex-info (pxc/err-msg-not-found "Vocab item" eid)
                      {:code 404 :id eid})))
    ;; TODO: Check for dependent vmaps before deleting
    [[::xt/match eid record]
     [::xt/delete eid]]))

(defn delete-operation
  [xt-map eid]
  (let [{:keys [db]} xt-map
        current (pxc/entity db eid)]
    (op/make-operation
      {:type :vocab-item/delete
       :description (format "Delete vocab item '%s'" (:vocab-item/form current))
       :tx-ops (delete* xt-map eid)
       :project nil
       :document nil})))

(defn delete
  [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))