(ns glam.crux.text-layer
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce]
            [glam.crux.token-layer :as tokl])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:text-layer/id
                :text-layer/name
                :text-layer/token-layers])

(defn crux->pathom [doc]
  (when doc
    (-> doc
        (update :text-layer/token-layers cutil/identize :token-layer/id))))

(defn create [node {:text-layer/keys [id] :as attrs}]
  (let [{:text-layer/keys [id] :as record} (clojure.core/merge (cutil/new-record "text-layer" id)
                                                               {:text-layer/token-layers []}
                                                               (select-keys attrs attr-keys))
        tx-status (gce/submit! node [[:crux.tx/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (crux->pathom (gce/find-entity node {:text-layer/id id})))

(defn parent-id [node id]
  (-> (crux/q (crux/db node)
              '{:find  [?p]
                :where [[?p :project/text-layers ?txtl]]
                :in    [?txtl]}
              id)
      first
      first))

;; Mutations ----------------------------------------------------------------------
(defn merge
  "Note: don't include the join"
  [node eid m]
  (gce/merge node eid (select-keys m [:text-layer/name])))

(defn add-token-layer** [node text-layer-id token-layer-id]
  (cutil/add-join** node text-layer-id :text-layer/token-layers token-layer-id))
(defn add-token-layer [node text-layer-id token-layer-id]
  (gce/submit! node (add-token-layer** node text-layer-id token-layer-id)))

(defn remove-token-layer** [node text-layer-id token-layer-id]
  (cutil/remove-join** node text-layer-id :text-layer/token-layers token-layer-id))
(defn remove-token-layer [node text-layer-id token-layer-id]
  (gce/submit! node (remove-token-layer** node text-layer-id token-layer-id)))

(defn delete** [node eid]
  (let [token-layers (:text-layer/token-layers (gce/entity node eid))
        token-layer-deletions (reduce into (mapv #(tokl/delete** node %) token-layers))
        text-ids (map first (crux/q (crux/db node) '{:find  [?txt]
                                                     :where [[?txt :text/layer ?txtl]]
                                                     :in    [?txtl]}
                                    eid))
        text-deletions (mapv gce/delete* text-ids)]
    (reduce
      into
      [token-layer-deletions
       text-deletions
       [(gce/match* eid (gce/entity node eid))
        (gce/delete* eid)]])))
(defn delete [node eid]
  (gce/submit-tx-sync node (delete** node eid)))
