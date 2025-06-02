(ns plaid.xtdb.span-layer
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.relation-layer :as rl])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:span-layer/id
                :span-layer/name
                :span-layer/relation-layers
                :config])

;; Queries ------------------------------------------------------------------------
(defn get
  [db-like id]
  (let [db (pxc/->db db-like)]
    (pxc/find-entity db {:span-layer/id id})))

(defn- parent-id [db id]
  (-> (xt/q db
            '{:find  [?tokl]
              :where [[?tokl :token-layer/span-layers ?sl]]
              :in    [?sl]}
            id)
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

(defn create [{:keys [node] :as xt-map} attrs token-layer-id]
  (pxc/submit-with-extras! node (create* xt-map attrs token-layer-id) #(-> % last last :xt/id)))

(defn merge
  [xt-map eid m]
  (when-let [name (:span-layer/name m)]
    (pxc/valid-name? name))
  (pxc/submit! (:node xt-map) (pxc/merge* xt-map eid (select-keys m [:span-layer/name]))))

(def shift-span-layer* (pxc/make-shift-layer* :token-layer/id :span-layer/id :token-layer/span-layers))
(defn shift-span-layer [{:keys [node db] :as xt-map} token-layer-id span-layer-id up?]
  (pxc/submit! node (shift-span-layer* xt-map token-layer-id span-layer-id up?)))

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

(defn delete [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        base-tx (delete* xt-map eid)
        token-layer-id (parent-id db eid)
        token-layer (pxc/entity db token-layer-id)
        delete-layer-tx [[::xt/match token-layer-id token-layer]
                         [::xt/put (pxc/remove-id token-layer :token-layer/span-layers eid)]]]
    (pxc/submit! node (into base-tx delete-layer-tx))))