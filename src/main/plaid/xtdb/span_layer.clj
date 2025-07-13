(ns plaid.xtdb.span-layer
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations!]]
            [plaid.xtdb.relation-layer :as rl])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:span-layer/id
                :span-layer/name
                :span-layer/relation-layers
                :config])

;; Queries ------------------------------------------------------------------------
(defn get
  "Get a span layer by ID, formatted for external consumption (API responses)."
  [db-like id]
  (when-let [span-layer-entity (pxc/find-entity (pxc/->db db-like) {:span-layer/id id})]
    (select-keys span-layer-entity attr-keys)))

(defn- parent-id [db id]
  (-> (xt/q db
            '{:find  [?tokl]
              :where [[?tokl :token-layer/span-layers ?sl]]
              :in    [?sl]}
            id)
      first
      first))

(defn project-id [db-like id]
  (-> (xt/q (pxc/->db db-like)
            '{:find  [?prj]
              :where [[?prj :project/text-layers ?txtl]
                      [?txtl :text-layer/token-layers ?tokl]
                      [?tokl :token-layer/span-layers ?sl]]
              :in    [?sl]}
            id)
      first
      first))

(defn- project-id-from-token-layer [db-like tokl-id]
  (-> (xt/q (pxc/->db db-like)
            '{:find  [?prj]
              :where [[?prj :project/text-layers ?txtl]
                      [?txtl :text-layer/token-layers ?tokl]]
              :in    [?tokl]}
            tokl-id)
      first
      first))

;; Mutations ----------------------------------------------------------------------
(defn create* [xt-map {:span-layer/keys [id] :as attrs} token-layer-id]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        {:span-layer/keys [id name] :as record} (clojure.core/merge (pxc/new-record "span-layer" id)
                                                                    {:span-layer/relation-layers []}
                                                                    (select-keys attrs attr-keys))
        token-layer (pxc/entity db token-layer-id)
        tx [[::xt/match id nil]
            [::xt/match token-layer-id token-layer]
            [::xt/put (update token-layer :token-layer/span-layers conj id)]
            [::xt/put record]]]
    (pxc/valid-name? name)
    (cond
      (some? (pxc/entity db id))
      (throw (ex-info (pxc/err-msg-already-exists "Span layer" id) {:id id :code 409}))

      :else
      tx)))

(defn create-operation
  "Build an operation for creating a span layer"
  [xt-map attrs token-layer-id]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        {:span-layer/keys [name]} attrs
        project-id (project-id-from-token-layer db token-layer-id)
        tx-ops (create* xt-map attrs token-layer-id)]
    (op/make-operation
     {:type        :span-layer/create
      :project     project-id
      :document    nil
      :description (str "Create span layer \"" name "\" in token layer " token-layer-id)
      :tx-ops      tx-ops})))

(defn create [xt-map attrs token-layer-id user-id]
  (submit-operations! xt-map [(create-operation xt-map attrs token-layer-id)] user-id #(-> % last last :xt/id)))

(defn merge-operation
  "Build an operation for updating a span layer"
  [xt-map eid m]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        project-id (project-id db eid)
        tx-ops (do (when-let [name (:span-layer/name m)]
                     (pxc/valid-name? name))
                   (pxc/merge* xt-map :span-layer/id eid (select-keys m [:span-layer/name])))]
    (op/make-operation
     {:type        :span-layer/update
      :project     project-id
      :document    nil
      :description (str "Update span layer " eid (when (:span-layer/name m) (str " to name \"" (:span-layer/name m) "\"")))
      :tx-ops      tx-ops})))

(defn merge
  [xt-map eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(def shift-span-layer* (pxc/make-shift-layer* :token-layer/id :span-layer/id :token-layer/span-layers))
(defn shift-span-layer-operation
  "Build an operation for shifting a span layer"
  [xt-map span-layer-id up?]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        project-id (project-id db span-layer-id)
        tx-ops (shift-span-layer* xt-map span-layer-id up?)]
    (op/make-operation
     {:type        :span-layer/shift
      :project     project-id
      :document    nil
      :description (str "Shift span layer " span-layer-id " " (if up? "up" "down"))
      :tx-ops      tx-ops})))

(defn shift-span-layer [xt-map span-layer-id up? user-id]
  (submit-operations! xt-map [(shift-span-layer-operation xt-map span-layer-id up?)] user-id))

(defn delete* [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        {relation-layers :span-layer/relation-layers :as span-layer} (pxc/entity db eid)
        relation-layer-deletions (reduce into (map #(rl/delete* xt-map %) relation-layers))
        span-ids (map first (xt/q db '{:find  [?s]
                                       :where [[?s :span/layer ?sl]]
                                       :in    [?sl]}
                                  eid))
        span-deletions (vec (mapcat (fn [id]
                                      [[::xt/match id (pxc/entity db id)]
                                       [::xt/delete id]])
                                    span-ids))]
    (cond
      (nil? (:span-layer/id span-layer))
      (throw (ex-info (pxc/err-msg-not-found "Span layer" eid) {:code 404}))

      :else
      (reduce into [relation-layer-deletions
                    span-deletions
                    [[::xt/match eid (pxc/entity db eid)]
                     [::xt/delete eid]]]))))

(defn delete-operation
  "Build an operation for deleting a span layer"
  [xt-map eid]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        span-layer (pxc/entity db eid)
        project-id (project-id db eid)
        relation-layers (:span-layer/relation-layers span-layer)
        base-tx (delete* xt-map eid)
        token-layer-id (parent-id db eid)
        token-layer (pxc/entity db token-layer-id)
        delete-layer-tx [[::xt/match token-layer-id token-layer]
                         [::xt/put (pxc/remove-id token-layer :token-layer/span-layers eid)]]
        all-tx-ops (into base-tx delete-layer-tx)]
    (op/make-operation
     {:type        :span-layer/delete
      :project     project-id
      :document    nil
      :description (str "Delete span layer " eid " with " (count relation-layers) " relation layers")
      :tx-ops      all-tx-ops})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))