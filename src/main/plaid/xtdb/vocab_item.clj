(ns plaid.xtdb.vocab-item
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations!]]
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
               '{:find [(pull ?vi [*])]
                 :where [[?vi :vocab-item/layer ?vl]]
                 :in [?vl]}
               layer-id)
         (map first)
         (map #(dissoc % :xt/id))
         (mapv #(metadata/add-metadata-to-response (select-keys % [:vocab-item/id :vocab-item/form]) % "vocab-item")))))

;; writes --------------------------------------------------------------------------------
(defn create*
  [{:keys [db]} attrs]
  (let [attrs (filter (fn [[k _]] (= "vocab-item" (namespace k))) attrs)
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
       :tx-ops (create* (pxc/ensure-db xt-map) attrs-with-metadata)
       :project nil
       :document nil})))

(defn create
  ([xt-map attrs user-id]
   (create xt-map attrs user-id nil))
  ([xt-map attrs user-id metadata]
   (submit-operations! xt-map [(create-operation xt-map attrs metadata)] user-id #(-> % last last :xt/id))))

(defn merge-operation
  [xt-map eid m]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        current (pxc/entity db eid)]
    (when-not current
      (throw (ex-info (pxc/err-msg-not-found "Vocab item" eid)
                      {:code 404 :id eid})))
    ;; If changing form, check uniqueness
    (op/make-operation
      {:type :vocab-item/merge
       :description (format "Update vocab item '%s'" (:vocab-item/form current))
       :tx-ops (pxc/merge* xt-map :vocab-item/id eid m)
       :project nil
       :document nil})))

(defn merge
  [{:keys [node db] :as xt-map} eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(defn delete*
  [{:keys [db]} eid]
  (let [record (pxc/entity db eid)]
    (when-not record
      (throw (ex-info (pxc/err-msg-not-found "Vocab item" eid)
                      {:code 404 :id eid})))
    ;; Delete all vocab-links for this vocab item
    (let [vocab-link-ids (map first (xt/q db
                                          '{:find [?vm]
                                            :where [[?vm :vocab-link/vocab-item ?vi]]
                                            :in [?vi]}
                                          eid))
          vocab-link-deletions (if (seq vocab-link-ids)
                                 (vec (mapcat (fn [vocab-link-id]
                                                (when-let [entity (pxc/entity db vocab-link-id)]
                                                  [[::xt/match vocab-link-id entity]
                                                   [::xt/delete vocab-link-id]]))
                                              vocab-link-ids))
                                 [])]
      (into vocab-link-deletions
            [[::xt/match eid record]
             [::xt/delete eid]]))))

(defn delete-operation
  [xt-map eid]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        current (pxc/entity db eid)
        ops (delete* xt-map eid)]
    (op/make-operation
      {:type :vocab-item/delete
       :description (format "Delete vocab item '%s'" (:vocab-item/form current))
       :tx-ops ops
       :project nil
       :document nil})))

(defn delete
  [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))