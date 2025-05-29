(ns plaid.xtdb.relation-layer
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:relation-layer/id
                :relation-layer/name
                :config])

;; Queries ------------------------------------------------------------------------
(defn get
  [db-like id]
  (let [db (pxc/->db db-like)]
    (pxc/find-entity db {:relation-layer/id id})))

(defn- parent-id [db id]
  (-> (xt/q db
            '{:find  [?sl]
              :where [[?sl :span-layer/relation-layers ?rl]]
              :in    [?rl]}
            id)
      first
      first))

;; Mutations ----------------------------------------------------------------------
(defn create* [xt-map {:relation-layer/keys [id] :as attrs} span-layer-id]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        {:relation-layer/keys [id] :as record} (clojure.core/merge (pxc/new-record "relation-layer" id)
                                                                   (select-keys attrs attr-keys))
        span-layer (pxc/entity db span-layer-id)
        tx [[::xt/match id nil]
            [::xt/match span-layer-id span-layer]
            [::xt/put (update span-layer :span-layer/relation-layers conj id)]
            [::xt/put record]]]
    (cond
      (some? (pxc/entity db id))
      (throw (ex-info (pxc/err-msg-already-exists "Relation layer" id) {:id id :code 409}))

      :else
      tx)))

(defn create [{:keys [node] :as xt-map} attrs span-layer-id]
  (pxc/submit-with-extras! node (create* xt-map attrs span-layer-id) #(-> % last last :xt/id)))

(defn merge
  [{:keys [node db] :as xt-map} eid m]
  (pxc/submit! node (pxc/merge* xt-map eid (select-keys m [:relation-layer/name]))))

(def shift-relation-layer* (pxc/make-shift-layer* :span-layer/id :relation-layer/id :span-layer/relation-layers))
(defn shift-relation-layer [{:keys [node db] :as xt-map} span-layer-id relation-layer-id up?]
  (pxc/submit! node (shift-relation-layer* xt-map span-layer-id relation-layer-id up?)))

(defn delete* [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        relation-ids (map first (xt/q db '{:find  [?r]
                                           :where [[?r :relation/layer ?rl]]
                                           :in    [?rl]}
                                      eid))
        relation-deletions (vec (mapcat (fn [id]
                                          [[::xt/match id (pxc/entity db id)]
                                           [::xt/delete id]])
                                        relation-ids))]
    (reduce into [relation-deletions
                  [[::xt/match eid (pxc/entity db eid)]
                   [::xt/delete eid]]])))

(defn delete [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        base-tx (delete* xt-map eid)
        span-layer-id (parent-id db eid)
        span-layer (pxc/entity db span-layer-id)
        delete-layer-tx [[::xt/match span-layer-id span-layer]
                         [::xt/put (pxc/remove-id span-layer :span-layer/relation-layers eid)]]]
    (pxc/submit! node (into base-tx delete-layer-tx))))
