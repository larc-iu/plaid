(ns glam.xtdb.span-layer
  (:require [xtdb.api :as xt]
            [glam.xtdb.util :as xutil]
            [glam.xtdb.easy :as gxe]
            [glam.xtdb.project-config :as prjc])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:span-layer/id
                :span-layer/name])

(defn xt->pathom [doc]
  (when doc
    (-> doc)))

(defn create [node {:span-layer/keys [id] :as attrs}]
  (let [{:span-layer/keys [id] :as record} (clojure.core/merge (xutil/new-record "span-layer" id)
                                                               (select-keys attrs attr-keys))
        tx-status (gxe/submit! node [[:xtdb.api/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (xt->pathom (gxe/find-entity node {:span-layer/id id})))

(defn parent-id [node id]
  (-> (xt/q (xt/db node)
            '{:find  [?tokl]
              :where [[?tokl :token-layer/span-layers ?sl]]
              :in    [?sl]}
            id)
      first
      first))

;; Mutations ----------------------------------------------------------------------
(defn remove-span-layer-from-project-config** [node span-layer-id]
  (let [project-id (first (xt/q (xt/db node) '{:find  [?prj]
                                               :where [[?prj :project/text-layers ?txtl]
                                                       [?txtl :text-layer/token-layers ?tokl]
                                                       [?tokl :token-layer/span-layers ?sl]]
                                               :in    [?sl]}
                                span-layer-id))
        project (gxe/entity node project-id)
        updated-project (update-in project [:project/config :editors :interlinear :sentence-level-span-layers]
                                   (fn [sls] (filterv #(not= % span-layer-id) sls)))]
    (if (= project updated-project)
      []
      [(gxe/match* project-id project)
       (gxe/put* updated-project)])))

(defn merge
  [node eid m]
  (gxe/merge node eid (select-keys m [:span-layer/name])))
(defn delete** [node eid]
  (let [remove-from-project-tx (prjc/remove-span-layer-from-config** node eid)
        span-ids (map first (xt/q (xt/db node) '{:find  [?s]
                                                 :where [[?s :span/layer ?sl]]
                                                 :in    [?sl]}
                                  eid))
        span-deletions (mapv gxe/delete* span-ids)
        span-layer-deletion [(gxe/match* eid (gxe/entity node eid))
                             (gxe/delete* eid)]]
    (reduce into [remove-from-project-tx
                  span-deletions
                  span-layer-deletion])))
(defn delete [node eid]
  (gxe/submit-tx-sync node (delete** node eid)))


