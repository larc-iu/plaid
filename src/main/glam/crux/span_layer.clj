(ns glam.crux.span-layer
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce]
            [glam.crux.project-config :as prjc])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:span-layer/id
                :span-layer/name])

(defn crux->pathom [doc]
  (when doc
    (-> doc)))

(defn create [node {:span-layer/keys [id] :as attrs}]
  (let [{:span-layer/keys [id] :as record} (clojure.core/merge (cutil/new-record "span-layer" id)
                                                               (select-keys attrs attr-keys))
        tx-status (gce/submit! node [[:crux.tx/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (crux->pathom (gce/find-entity node {:span-layer/id id})))

(defn parent-id [node id]
  (-> (crux/q (crux/db node)
              '{:find  [?tokl]
                :where [[?tokl :token-layer/span-layers ?sl]]
                :in    [?sl]}
              id)
      first
      first))

;; Mutations ----------------------------------------------------------------------
(defn remove-span-layer-from-project-config** [node span-layer-id]
  (let [project-id (first (crux/q (crux/db node) '{:find  [?prj]
                                                   :where [[?prj :project/text-layers ?txtl]
                                                           [?txtl :text-layer/token-layers ?tokl]
                                                           [?tokl :token-layer/span-layers ?sl]]
                                                   :in    [?sl]}
                                  span-layer-id))
        project (gce/entity node project-id)
        updated-project (update-in project [:project/config :editors :interlinear :sentence-level-span-layers]
                                   (fn [sls] (filterv #(not= % span-layer-id) sls)))]
    (if (= project updated-project)
      []
      [(gce/match* project-id project)
       (gce/put* updated-project)])))

(defn merge
  [node eid m]
  (gce/merge node eid (select-keys m [:span-layer/name])))
(defn delete** [node eid]
  (let [remove-from-project-tx (prjc/remove-span-layer-from-config** node eid)
        span-ids (map first (crux/q (crux/db node) '{:find [?s]
                                                     :where [[?s :span/layer ?sl]]
                                                     :in [?sl]}
                                    eid))
        span-deletions (mapv gce/delete* span-ids)
        span-layer-deletion [(gce/match* eid (gce/entity node eid))
                             (gce/delete* eid)]]
    (reduce into [remove-from-project-tx
                  span-deletions
                  span-layer-deletion])))
(defn delete [node eid]
  (gce/submit-tx-sync node (delete** node eid)))


