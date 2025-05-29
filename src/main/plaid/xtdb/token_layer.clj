(ns plaid.xtdb.token-layer
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.span-layer :as sl]
            [taoensso.timbre :as log]
            [plaid.algos.token :as toka])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:token-layer/id
                :token-layer/name
                :token-layer/span-layers
                :config])

;; Queries ------------------------------------------------------------------------
(defn get
  [db-like id]
  (let [db (pxc/->db db-like)]
    (pxc/find-entity db {:token-layer/id id})))

(defn- parent-id [db id]
  (-> (xt/q db
            '{:find  [?txtl]
              :where [[?txtl :text-layer/token-layers ?tokl]]
              :in    [?tokl]}
            id)
      first
      first))

(defn get-existing-tokens
  "Find all tokens with their two indices for a given token layer and document."
  [db-like eid document-id]
  (let [db (pxc/->db db-like)]
    (map first (xt/q db '{:find  [(pull ?tok [:token/begin :token/end])]
                          :where [[?prj :project/text-layers ?txtl]
                                  [?doc :document/project ?prj]
                                  [?txtl :text-layer/token-layers ?tokl]
                                  [?txt :text/document ?doc]
                                  [?tok :token/text ?txt]
                                  [?tok :token/layer ?tokl]]
                          :in    [[?tokl ?doc]]}
                     [eid document-id]))))

;; Mutations ----------------------------------------------------------------------
(defn create* [xt-map {:token-layer/keys [id] :as attrs} text-layer-id]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        {:token-layer/keys [id] :as record} (clojure.core/merge (pxc/new-record "token-layer" id)
                                                                {:token-layer/span-layers []}
                                                                (select-keys attrs attr-keys))
        text-layer (pxc/entity db text-layer-id)
        tx [[::xt/match id nil]
            [::xt/match text-layer-id text-layer]
            [::xt/put (update text-layer :text-layer/token-layers conj id)]
            [::xt/put record]]]
    (cond
      (some? (pxc/entity db id))
      (throw (ex-info (pxc/err-msg-already-exists "Token layer" id) {:id id :code 409}))

      :else
      tx)))

(defn create [{:keys [node] :as xt-map} attrs text-layer-id]
  (pxc/submit-with-extras! node (create* xt-map attrs text-layer-id) #(-> % last last :xt/id)))

(defn merge
  [{:keys [node db] :as xt-map} eid m]
  (pxc/submit! node (pxc/merge* node eid (select-keys m [:token-layer/name]))))

(def shift-token-layer* (pxc/make-shift-layer* :text-layer/id :token-layer/id :text-layer/token-layers))
(defn shift-token-layer [{:keys [node db] :as xt-map} text-layer-id token-layer-id up?]
  (pxc/submit! node (shift-token-layer* xt-map text-layer-id token-layer-id up?)))

(defn delete* [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        span-layers (:token-layer/span-layers (pxc/entity db eid))
        span-layer-deletions (reduce into (map #(sl/delete* xt-map %) span-layers))
        token-ids (map first (xt/q db '{:find  [?tok]
                                        :where [[?tok :token/layer ?tokl]]
                                        :in    [?tokl]}
                                   eid))
        token-deletions (vec (mapcat (fn [id]
                                       [[::xt/match id (pxc/entity db id)]
                                        [::xt/delete id]])
                                     token-ids))]
    (reduce into
            [span-layer-deletions
             token-deletions
             [[::xt/match eid (pxc/entity db eid)]
              [::xt/delete eid]]])))


(defn delete [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        base-tx (delete* xt-map eid)
        text-layer-id (parent-id db eid)
        text-layer (pxc/entity db text-layer-id)
        delete-layer-tx [[::xt/match text-layer-id text-layer]
                         [::xt/put (pxc/remove-id text-layer :text-layer/token-layers eid)]]]
    (pxc/submit! node (into base-tx delete-layer-tx))))

;; Other --------------------------------------------------------------------------------
(defn sort-token-records [tokens]
  (->> tokens
       (sort-by #(or (:token/precedence %) 0) <)
       (sort-by :token/begin)))