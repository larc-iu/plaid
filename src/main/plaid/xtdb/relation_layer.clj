(ns plaid.xtdb.relation-layer
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations! submit-operations-with-extras!]])
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

(defn project-id [db-like id]
  (-> (xt/q (pxc/->db db-like)
            '{:find  [?prj]
              :where [[?prj :project/text-layers ?txtl]
                      [?txtl :text-layer/token-layers ?tokl]
                      [?tokl :token-layer/span-layers ?sl]
                      [?sl :span-layer/relation-layers ?rl]]
              :in    [?rl]}
            id)
      first
      first))

;; Mutations ----------------------------------------------------------------------
(defn create* [xt-map {:relation-layer/keys [id] :as attrs} span-layer-id]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        {:relation-layer/keys [id name] :as record} (clojure.core/merge (pxc/new-record "relation-layer" id)
                                                                        (select-keys attrs attr-keys))
        span-layer (pxc/entity db span-layer-id)
        tx [[::xt/match id nil]
            [::xt/match span-layer-id span-layer]
            [::xt/put (update span-layer :span-layer/relation-layers conj id)]
            [::xt/put record]]]
    (pxc/valid-name? name)
    (cond
      (some? (pxc/entity db id))
      (throw (ex-info (pxc/err-msg-already-exists "Relation layer" id) {:id id :code 409}))

      :else
      tx)))

(defn create-operation
  "Build an operation for creating a relation layer"
  [xt-map attrs span-layer-id]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        {:relation-layer/keys [name]} attrs
        project-id (project-id db span-layer-id)
        tx-ops (create* xt-map attrs span-layer-id)]
    (op/make-operation
     {:type        :relation-layer/create
      :project-id  project-id
      :document-id nil
      :description (str "Create relation layer \"" name "\" in span layer " span-layer-id)
      :tx-ops      tx-ops})))

(defn create [xt-map attrs span-layer-id user-id]
  (submit-operations-with-extras! xt-map [(create-operation xt-map attrs span-layer-id)] user-id #(-> % last last :xt/id)))

(defn merge-operation
  "Build an operation for updating a relation layer"
  [xt-map eid m]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        project-id (project-id db eid)
        tx-ops (do (when-let [name (:relation-layer/name m)]
                     (pxc/valid-name? name))
                   (pxc/merge* xt-map eid (select-keys m [:relation-layer/name])))]
    (op/make-operation
     {:type        :relation-layer/update
      :project-id  project-id
      :document-id nil
      :description (str "Update relation layer " eid (when (:relation-layer/name m) (str " to name \"" (:relation-layer/name m) "\"")))
      :tx-ops      tx-ops})))

(defn merge
  [{:keys [node db] :as xt-map} eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(def shift-relation-layer* (pxc/make-shift-layer* :span-layer/id :relation-layer/id :span-layer/relation-layers))
(defn shift-relation-layer-operation
  "Build an operation for shifting a relation layer"
  [xt-map relation-layer-id up?]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        project-id (project-id db relation-layer-id)
        tx-ops (shift-relation-layer* xt-map relation-layer-id up?)]
    (op/make-operation
     {:type        :relation-layer/shift
      :project-id  project-id
      :document-id nil
      :description (str "Shift relation layer " relation-layer-id " " (if up? "up" "down"))
      :tx-ops      tx-ops})))

(defn shift-relation-layer [xt-map relation-layer-id up? user-id]
  (submit-operations! xt-map [(shift-relation-layer-operation xt-map relation-layer-id up?)] user-id))

(defn delete* [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        relation-layer (pxc/entity db eid)
        relation-ids (map first (xt/q db '{:find  [?r]
                                           :where [[?r :relation/layer ?rl]]
                                           :in    [?rl]}
                                      eid))
        relation-deletions (vec (mapcat (fn [id]
                                          [[::xt/match id (pxc/entity db id)]
                                           [::xt/delete id]])
                                        relation-ids))]
    (cond
      (nil? (:relation-layer/id relation-layer))
      (throw (ex-info (pxc/err-msg-not-found "Relation layer" eid) {:code 404}))

      :else
      (reduce into [relation-deletions
                    [[::xt/match eid (pxc/entity db eid)]
                     [::xt/delete eid]]]))))

(defn delete-operation
  "Build an operation for deleting a relation layer"
  [xt-map eid]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        relation-layer (pxc/entity db eid)
        project-id (project-id db eid)
        relation-ids (map first (xt/q db '{:find  [?r]
                                           :where [[?r :relation/layer ?rl]]
                                           :in    [?rl]}
                                      eid))
        base-tx (delete* xt-map eid)
        span-layer-id (parent-id db eid)
        span-layer (pxc/entity db span-layer-id)
        delete-layer-tx [[::xt/match span-layer-id span-layer]
                         [::xt/put (pxc/remove-id span-layer :span-layer/relation-layers eid)]]
        all-tx-ops (into base-tx delete-layer-tx)]
    (op/make-operation
     {:type        :relation-layer/delete
      :project-id  project-id
      :document-id nil
      :description (str "Delete relation layer " eid " with " (count relation-ids) " relations")
      :tx-ops      all-tx-ops})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))
