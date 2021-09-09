(ns glam.xtdb.project-config
  "Separated from project.clj to avoid circular imports"
  (:require [xtdb.api :as xt]
            [glam.xtdb.easy :as gxe]))

(defn span-deletions** [node span-layer-id]
  (let [span-ids (map first (xt/q (xt/db node) '{:find  [?s]
                                                 :where [[?s :span/layer ?sl]]
                                                 :in    [?sl]}
                                  span-layer-id))
        span-deletions (mapv gxe/delete* span-ids)]
    span-deletions))

(defn remove-span-layer-from-config** [node span-layer-id]
  (let [project-id (ffirst (xt/q (xt/db node) '{:find  [?prj]
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
      (into
        (span-deletions** node span-layer-id)
        [(gxe/match* project-id project)
         (gxe/put* updated-project)]))))
(defn remove-span-layer-from-config [node span-layer-id]
  (gxe/submit! node (remove-span-layer-from-config** node span-layer-id)))

(defn add-span-layer-to-config** [node span-layer-id]
  (let [project-id (ffirst (xt/q (xt/db node) '{:find  [?prj]
                                                :where [[?prj :project/text-layers ?txtl]
                                                        [?txtl :text-layer/token-layers ?tokl]
                                                        [?tokl :token-layer/span-layers ?sl]]
                                                :in    [?sl]}
                                 span-layer-id))
        project (gxe/entity node project-id)
        updated-project (update-in project [:project/config :editors :interlinear :sentence-level-span-layers]
                                   (fn [sls] (if-not (some #(= % span-layer-id) sls)
                                               (conj sls span-layer-id)
                                               sls)))]
    (if (= project updated-project)
      []
      (into
        (span-deletions** node span-layer-id)
        [(gxe/match* project-id project)
         (gxe/put* updated-project)]))))
(defn add-span-layer-to-config [node span-layer-id]
  (gxe/submit! node (add-span-layer-to-config** node span-layer-id)))
