(ns plaid.xtdb.text-layer
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations!]]
            [plaid.xtdb.token-layer :as tokl])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:text-layer/id
                :text-layer/name
                :text-layer/token-layers
                :config])

;; Queries ------------------------------------------------------------------------
(defn get
  "Get a text layer by ID, formatted for external consumption (API responses)."
  [db-like id]
  (when-let [text-layer-entity (pxc/find-entity (pxc/->db db-like) {:text-layer/id id})]
    (select-keys text-layer-entity attr-keys)))

(defn- parent-id [db id]
  (-> (xt/q db
            '{:find  [?prj]
              :where [[?prj :project/text-layers ?txtl]]
              :in    [?txtl]}
            id)
      first
      first))

(defn project-id [db-like id]
  (parent-id (pxc/->db db-like) id))

;; Mutations ----------------------------------------------------------------------
(defn create* [xt-map {:text-layer/keys [id] :as attrs} project-id]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        {:text-layer/keys [id name] :as record} (clojure.core/merge (pxc/new-record "text-layer" id)
                                                                    {:text-layer/token-layers []}
                                                                    (select-keys attrs attr-keys))
        project (pxc/entity db project-id)
        tx [[::xt/match id nil]
            [::xt/match project-id project]
            [::xt/put (update project :project/text-layers conj id)]
            [::xt/put record]]]
    (pxc/valid-name? name)
    (cond
      (some? (pxc/entity db id))
      (throw (ex-info (pxc/err-msg-already-exists "Text layer" id) {:id id :code 409}))

      :else
      tx)))

(defn create-operation
  "Build an operation for creating a text layer"
  [xt-map attrs project-id]
  (let [{:text-layer/keys [name]} attrs
        tx-ops (create* xt-map attrs project-id)]
    (op/make-operation
     {:type        :text-layer/create
      :project     project-id
      :document    nil
      :description (str "Create text layer \"" name "\" in project " project-id)
      :tx-ops      tx-ops})))

(defn create [xt-map attrs project-id user-id]
  (submit-operations! xt-map [(create-operation xt-map attrs project-id)] user-id #(-> % last last :xt/id)))

(defn merge-operation
  "Build an operation for updating a text layer"
  [xt-map eid m]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        project-id (project-id db eid)
        tx-ops (do (when-let [name (:text-layer/name m)]
                     (pxc/valid-name? name))
                   (pxc/merge* xt-map :text-layer/id eid (select-keys m [:text-layer/name])))]
    (op/make-operation
     {:type        :text-layer/update
      :project     project-id
      :document    nil
      :description (str "Update text layer " eid (when (:text-layer/name m) (str " to name \"" (:text-layer/name m) "\"")))
      :tx-ops      tx-ops})))

(defn merge
  [{:keys [node db] :as xt-map} eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(def shift-text-layer* (pxc/make-shift-layer* :project/id :text-layer/id :project/text-layers))
(defn shift-text-layer-operation
  "Build an operation for shifting a text layer"
  [xt-map text-layer-id up?]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        project-id (project-id db text-layer-id)
        tx-ops (shift-text-layer* xt-map text-layer-id up?)]
    (op/make-operation
     {:type        :text-layer/shift
      :project     project-id
      :document    nil
      :description (str "Shift text layer " text-layer-id " " (if up? "up" "down"))
      :tx-ops      tx-ops})))

(defn shift-text-layer
  [xt-map text-layer-id up? user-id]
  (submit-operations! xt-map [(shift-text-layer-operation xt-map text-layer-id up?)] user-id))

(defn delete*
  "This does NOT remove refs from :project/text-layers and is primarily intended for use in
  plaid.xtdb.project/delete*. If you want to delete a text layer and nothing else, you should
  use plaid.xtdb.text-layer/delete instead."
  [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        {token-layers :text-layer/token-layers :as text-layer} (pxc/entity db eid)
        token-layer-deletions (reduce into [] (mapv #(tokl/delete* xt-map %) token-layers))
        text-ids (map first (xt/q db '{:find  [?txt]
                                       :where [[?txt :text/layer ?txtl]]
                                       :in    [?txtl]}
                                  eid))
        text-deletions (vec (mapcat (fn [id]
                                      [[::xt/match id (pxc/entity db id)]
                                       [::xt/delete id]])
                                    text-ids))]
    (cond
      (nil? (:text-layer/id text-layer))
      (throw (ex-info (pxc/err-msg-not-found "Text layer" eid) {:code 404}))

      :else
      (reduce
        into
        [token-layer-deletions
         text-deletions
         [[::xt/match eid text-layer]
          [::xt/delete eid]]]))))

(defn delete-operation
  "Build an operation for deleting a text layer"
  [xt-map eid]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        text-layer (pxc/entity db eid)
        project-id (parent-id db eid)
        token-layers (:text-layer/token-layers text-layer)
        base-tx (delete* xt-map eid)
        project (pxc/entity db project-id)
        delete-layer-tx [[::xt/match project-id project]
                         [::xt/put (pxc/remove-id project :project/text-layers eid)]]
        all-tx-ops (into base-tx delete-layer-tx)]
    (op/make-operation
     {:type        :text-layer/delete
      :project     project-id
      :document    nil
      :description (str "Delete text layer " eid " with " (count token-layers) " token layers")
      :tx-ops      all-tx-ops})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))