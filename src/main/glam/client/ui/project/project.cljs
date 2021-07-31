(ns glam.client.ui.project.project
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [com.fulcrologic.fulcro.application :as app]
            [com.fulcrologic.fulcro.ui-state-machines :as sm]
            [glam.client.router :as r]
            [glam.client.util :as gcu]
            [glam.client.ui.material-ui :as mui]
            [glam.models.session :as session :refer [Session]]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.dom :as dom]))

(defsc DocumentListItem
  [this {:document/keys [id name] :as props}]
  {:query [:document/id :document/name]
   :ident :document/id}
  (mui/list-item {:button  true
                  :onClick #(r/route-to! :document {:id id})}
    (mui/list-item-text {:primary name :secondary id})))

(def ui-document-list-item (c/factory DocumentListItem {:keyfn :document/id}))

(defsc Project
  [this {:project/keys [id name documents] :as props}]
  {:query         [:project/id :project/name {:project/documents (c/get-query DocumentListItem)}]
   :ident         :project/id
   :pre-merge     (fn [{:keys [data-tree]}]
                    (merge {:project/documents []}
                           data-tree))
   :route-segment (r/last-route-segment :project)
   :will-enter    (fn [app {:keys [id] :as route-params}]
                    (log/info "Entering: " (pr-str route-params))
                    (let [parsed-id (gcu/parse-id id)]
                      (when parsed-id
                        (dr/route-deferred
                          [:project/id parsed-id]
                          #(df/load! app [:project/id parsed-id] Project
                                     {:post-mutation        `dr/target-ready
                                      :post-mutation-params {:target [:project/id parsed-id]}})))))}


  (mui/container {:maxWidth "md"}
    (mui/page-title name)
    (mui/arrow-breadcrumbs {}
      (mui/link {:color "inherit" :href (r/route-for :projects) :key "projects"} "Projects")
      (mui/link {:color "textPrimary" :href (r/route-for :project {:id id}) :key "user"} name))

    (if-not (empty? documents)
      (mui/padded-paper
        (mui/list {:subheader (mui/list-subheader {:color "primary"} "Documents")}
          (mapv ui-document-list-item documents)))
      (mui/box {:my 4}
        (mui/typography
          {:variant   "subtitle1"
           :component "h3"}
          "No documents exist.")))))

(def ui-project-detail (c/factory Project))

