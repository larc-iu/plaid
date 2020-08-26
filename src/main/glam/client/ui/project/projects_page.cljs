(ns glam.client.ui.project.projects-page
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [glam.client.router :as r]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
            [com.fulcrologic.fulcro.dom :as dom]
            [glam.client.ui.material-ui :as mui]))


(defsc ProjectListItem
  [this {:project/keys [id name] :as props}]
  {:query (fn [_] [:project/id :project/name])
   :ident :project/id}
  (dom/div
    (dom/h4 "Project")
    (dom/div "id: " (pr-str id))
    (dom/div "name: " (pr-str name))
    (dom/div (r/link :project {:id id} name))))

(def ui-project-item (c/factory ProjectListItem {:keyfn :project/id}))

(defsc ProjectList [this {:keys [visible-projects]}]
  {:initial-state {}
   :ident         (fn [_] [:component/id :project-list])
   :query         [{:visible-projects (c/get-query ProjectListItem)}]}
  (dom/div
    "This is the list of projects"
    (map ui-project-item visible-projects)))

(def ui-project-list (c/factory ProjectList))

(defsc ProjectsPage [this {:keys [project-list]}]
  {:query         [{:project-list (c/get-query ProjectList)}]
   :ident         (fn [_] [:component/id :projects-page])
   :initial-state (fn [_] {:project-list (c/get-initial-state ProjectList)})
   :route-segment (r/last-route-segment :projects)
   :will-enter    (fn [app route-params]
                    (dr/route-deferred
                      [:component/id :projects-page]
                      #(df/load! app :visible-projects ProjectListItem
                                 {:target               [:component/id :project-list :visible-projects]
                                  :post-mutation        `dr/target-ready
                                  :post-mutation-params {:target [:component/id :projects-page]}})))}
  (mui/page-container
    (ui-project-list project-list)))

(def ui-projects-page (c/factory ProjectsPage))
