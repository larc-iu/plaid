(ns glam.xtdb.project-config
  "Separated from project.clj to avoid circular imports"
  (:require [xtdb.api :as xt]
            [glam.xtdb.easy :as gxe]
            [taoensso.timbre :as log]))

(declare update-span-layer-scope**)
(gxe/deftx update-span-layer-scope [node span-layer-id scope]
  (let [project-id (ffirst (xt/q (xt/db node) '{:find  [?prj]
                                                :where [[?prj :project/text-layers ?txtl]
                                                        [?txtl :text-layer/token-layers ?tokl]
                                                        [?tokl :token-layer/span-layers ?sl]]
                                                :in    [?sl]}
                                 span-layer-id))
        project (gxe/entity node project-id)
        updated-project (update-in project [:project/config :editors :interlinear :span-layer-scopes]
                                   (fn [id-to-scope-map]
                                     (if (nil? scope)
                                       (dissoc id-to-scope-map span-layer-id)
                                       (assoc id-to-scope-map span-layer-id scope))))]
    (if (= updated-project project)
      []
      [(gxe/merge* project-id {:project/config (:project/config updated-project)})])))
