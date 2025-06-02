(ns plaid.xtdb.text-layer
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.token-layer :as tokl])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:text-layer/id
                :text-layer/name
                :text-layer/token-layers
                :config])

;; Queries ------------------------------------------------------------------------
(defn get
  [db-like id]
  (let [db (pxc/->db db-like)]
    (pxc/find-entity db {:text-layer/id id})))

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

(defn create [{:keys [node] :as xt-map} attrs project-id]
  (pxc/submit-with-extras! node (create* xt-map attrs project-id) #(-> % last last :xt/id)))

(defn merge
  [{:keys [node db] :as xt-map} eid m]
  (when-let [name (:text-layer/name m)]
    (pxc/valid-name? name))
  (pxc/submit! node (pxc/merge* xt-map eid (select-keys m [:text-layer/name]))))

(def shift-text-layer* (pxc/make-shift-layer* :project/id :text-layer/id :project/text-layers))
(defn shift-text-layer
  [{:keys [node] :as xt-map} text-layer-id up?]
  (pxc/submit! node (shift-text-layer* xt-map text-layer-id up?)))

(defn delete*
  "This does NOT remove refs from :project/text-layers and is primarily intended for use in
  plaid.xtdb.project/delete*. If you want to delete a text layer and nothing else, you should
  use plaid.xtdb.text-layer/delete instead."
  [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        {token-layers :text-layer/token-layers :as text-layer} (pxc/entity db eid)
        token-layer-deletions (reduce into (mapv #(tokl/delete* xt-map %) token-layers))
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

(defn delete [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        base-tx (delete* xt-map eid)
        project-id (parent-id db eid)
        project (pxc/entity db project-id)
        delete-layer-tx [[::xt/match project-id project]
                         [::xt/put (pxc/remove-id project :project/text-layers eid)]]]
    (pxc/submit! node (into base-tx delete-layer-tx))))