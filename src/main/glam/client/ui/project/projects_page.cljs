(ns glam.client.ui.project.projects-page
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [dv.fulcro-util :as fu]
            [glam.client.router :as r]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]))


(defsc ProjectListItem
  [this {:project/keys [id name slug] :as props}]
  {:query (fn [_] [:project/id :project/name :project/slug])
   :ident :project/id}
  [:div
   [:h4 "Project"]
   [:div "id: " (pr-str id)]
   [:div "name: " (pr-str name)]
   [:div "slug: " (pr-str slug)
    (r/link :project {:id id} name)
    (fu/props-data-debug this true)]])

(def ui-project-item (c/factory ProjectListItem {:keyfn :project/id}))

(defsc ProjectList [this {:keys [all-projects]}]
  {:initial-state {}
   :ident         (fn [_] [:component/id :project-list])
   :query         [{:all-projects (c/get-query ProjectListItem)}]}
  [:div "This is the list of projects"
   [:.ui.divider]
   (map ui-project-item all-projects)])

(def ui-project-list (c/factory ProjectList))

(defsc ProjectsPage [this {:keys [project-list]}]
  {:query             [{:project-list (c/get-query ProjectList)}]
   :ident             (fn [_] [:component/id :projects-page])
   :initial-state     (fn [_] {:project-list (c/get-initial-state ProjectList)})
   :route-segment     (r/route-segment :projects)
   :will-enter        (fn [app route-params]
                        (dr/route-deferred
                          [:component/id :projects-page]
                          #(df/load! app :all-projects ProjectListItem
                                     {:target [:component/id :project-list :all-projects]
                                      :post-mutation        `dr/target-ready
                                      :post-mutation-params {:target [:component/id :projects-page]}})))}
  [:div
   (ui-project-list project-list)])

(def ui-projects-page (c/factory ProjectsPage))
