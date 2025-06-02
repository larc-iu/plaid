(ns plaid.rest-api.v1.relation
  (:require [plaid.rest-api.v1.auth :as pra]
            [reitit.coercion.malli]
            [plaid.xtdb.relation :as rel]
            [plaid.xtdb.common :as pxc]))

(def relation-routes
  ["/projects/:project-id/relations"
   {:middleware [[pra/wrap-maintainer-required :project-id]]
    :parameters {:path [:map [:project-id :uuid]]}}

   [""
    {:post {:summary    "Create a new relation."
            :parameters {:body [:map
                                [:layer-id :uuid]
                                [:source-id :uuid]
                                [:target-id :uuid]
                                [:value :any]
                                [:id {:optional true} :string]]}
            :handler    (fn [{{{:keys [project-id]} :path {:keys [id layer-id source-id target-id value]} :body} :parameters xtdb :xtdb :as req}]
                          (let [attrs (cond-> {:relation/layer layer-id
                                               :relation/source source-id
                                               :relation/target target-id
                                               :relation/value value}
                                        id (assoc :relation/id id))]
                            (let [result (rel/create {:node xtdb} attrs)]
                              (if (:success result)
                                {:status 201
                                 :body   {:id (:extra result)}}
                                {:status (or (:code result) 400) ; Default to 400 for creation errors
                                 :body   {:error (:error result)}}))))}}]

   ["/:relation-id"
    {:parameters {:path [:map [:project-id :uuid] [:relation-id :uuid]]}}

    [:get {:summary "Get a relation by ID."
           :handler (fn [{{{:keys [project-id relation-id]} :path} :parameters xtdb :xtdb}]
                      (let [relation (rel/get xtdb relation-id)]
                        (if (some? relation)
                          {:status 200
                           :body   (dissoc relation :xt/id)}
                          {:status 404
                           :body   {:error "Relation not found"}})))}]

    [:patch {:summary    "Update a relation's value."
             :parameters {:body [:map [:value :any]]}
             :handler    (fn [{{{:keys [project-id relation-id]} :path {:keys [value]} :body} :parameters xtdb :xtdb}]
                           (let [{:keys [success code error]} (rel/merge {:node xtdb} relation-id {:relation/value value})]
                             (if success
                               {:status 200
                                :body   (dissoc (rel/get xtdb relation-id) :xt/id)}
                               {:status (or code 404) ; Merge might fail if relation not found
                                :body   {:error (or error "Failed to update relation or relation not found")}})))}]
    [:delete {:summary "Delete a relation."
              :handler (fn [{{{:keys [project-id relation-id]} :path} :parameters xtdb :xtdb}]
                         (let [{:keys [success code error]} (rel/delete {:node xtdb} relation-id)]
                           (if success
                             {:status 204}
                             {:status (or code 404)
                              :body   {:error (or error "Relation not found")}})))}]

    ["/source"
     {:put {:summary    "Update the source span of a relation."
            :parameters {:body [:map [:span-id :uuid]]}
            :handler    (fn [{{{:keys [project-id relation-id]} :path {:keys [span-id]} :body} :parameters xtdb :xtdb}]
                          (let [{:keys [success code error]} (rel/set-end {:node xtdb} relation-id :relation/source span-id)]
                            (if success
                              {:status 200
                               :body (dissoc (rel/get xtdb relation-id) :xt/id)}
                              {:status (or code 400) ; set-end can have various validation errors (400 or 404)
                               :body {:error (or error "Failed to update relation source")}})))}}]
    ["/target"
     {:put {:summary    "Update the target span of a relation."
            :parameters {:body [:map [:span-id :uuid]]}
            :handler    (fn [{{{:keys [project-id relation-id]} :path {:keys [span-id]} :body} :parameters xtdb :xtdb}]
                          (let [{:keys [success code error]} (rel/set-end {:node xtdb} relation-id :relation/target span-id)]
                            (if success
                              {:status 200
                               :body (dissoc (rel/get xtdb relation-id) :xt/id)}
                              {:status (or code 400)
                               :body {:error (or error "Failed to update relation target")}})))}}]]]) 