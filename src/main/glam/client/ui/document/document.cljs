(ns glam.client.ui.document.document
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [glam.client.router :as r]
            [glam.client.util :as gcu]
            [glam.client.ui.material-ui :as mui]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.dom :as dom]))

(defsc ProjectNameQuery
  [this props]
  {:query [:project/id :project/name]
   :ident :project/id})

(defsc Document
  [this {:document/keys [id name project] :as props}]
  {:query         [:document/id :document/name {:document/project (c/get-query ProjectNameQuery)}]
   :ident         :document/id
   :route-segment (r/last-route-segment :document)
   :will-enter    (fn [app {:keys [id] :as route-params}]
                    (let [parsed-id (gcu/parse-id id)]
                      (when parsed-id
                        (dr/route-deferred
                          [:document/id parsed-id]
                          #(df/load! app [:document/id parsed-id] Document
                                     {:post-mutation        `dr/target-ready
                                      :post-mutation-params {:target [:document/id parsed-id]}})))))}

  (mui/container {:maxWidth "md"}
    (mui/page-title name)
    (mui/arrow-breadcrumbs {}
      (mui/link {:color "inherit" :href (r/route-for :projects) :key "projects"} "projects")
      (mui/link {:color "inherit" :href (r/route-for :project {:id (:project/id project)}) :key "project"} (:project/name project))
      (mui/link {:color "textPrimary" :underline "none" :key "document"} name))
    (dom/p
      (str
        name
        project))
    ))

