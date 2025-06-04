(ns plaid.rest-api.v1.relation
  (:require [plaid.rest-api.v1.auth :as pra]
            [reitit.coercion.malli]
            [plaid.xtdb.relation :as rel]
            [plaid.xtdb.relation-layer :as rll]))

(defn get-project-id
  "Derive the project ID from a relation-layer or existing relation."
  [{xtdb :xtdb params :params}]
  (let [rll-id (-> params :body :layer-id)
        relation-id (-> params :path :relation-id)]
    (cond
      rll-id (rll/project-id xtdb rll-id)
      relation-id (rel/project-id xtdb relation-id)
      :else nil)))

(def relation-routes
  ["/relations"

   ;; Create
   ["" {:post {:summary    "Create a new relation."
               :middleware [[pra/wrap-writer-required get-project-id]]
               :parameters {:body [:map
                                   [:layer-id :uuid]
                                   [:source-id :uuid]
                                   [:target-id :uuid]
                                   [:value any?]
                                   [:id {:optional true} string?]]}
               :handler    (fn [{{{:keys [layer-id source-id target-id value id]} :body} :parameters xtdb :xtdb}]
                             (let [attrs (cond-> {:relation/layer  layer-id
                                                  :relation/source source-id
                                                  :relation/target target-id
                                                  :relation/value  value}
                                                 id (assoc :relation/id id))
                                   result (rel/create {:node xtdb} attrs)]
                               (if (:success result)
                                 {:status 201 :body {:id (:extra result)}}
                                 {:status (or (:code result) 400) :body {:error (:error result)}})))}}]

   ;; Get, update, delete by ID
   ["/:relation-id"
    {:parameters {:path [:map [:relation-id :uuid]]}}
    ["" {:get    {:summary    "Get a relation by ID."
                  :middleware [[pra/wrap-reader-required get-project-id]]
                  :handler    (fn [{{{:keys [relation-id]} :path} :parameters xtdb :xtdb}]
                                (let [relation (rel/get xtdb relation-id)]
                                  (if (some? relation)
                                    {:status 200 :body (dissoc relation :xt/id)}
                                    {:status 404 :body {:error "Relation not found"}})))}
         :patch  {:summary    "Update a relation's value."
                  :middleware [[pra/wrap-writer-required get-project-id]]
                  :parameters {:body [:map [:value any?]]}
                  :handler    (fn [{{{:keys [relation-id]} :path {:keys [value]} :body} :parameters xtdb :xtdb}]
                                (let [{:keys [success code error]} (rel/merge {:node xtdb} relation-id {:relation/value value})]
                                  (if success
                                    {:status 200 :body (dissoc (rel/get xtdb relation-id) :xt/id)}
                                    {:status (or code 404) :body {:error (or error "Failed to update relation or relation not found")}})))}
         :delete {:summary    "Delete a relation."
                  :middleware [[pra/wrap-writer-required get-project-id]]
                  :handler    (fn [{{{:keys [relation-id]} :path} :parameters xtdb :xtdb}]
                                (let [{:keys [success code error]} (rel/delete {:node xtdb} relation-id)]
                                  (if success
                                    {:status 204}
                                    {:status (or code 404) :body {:error (or error "Relation not found")}})))}}]
    ["/source" {:put {:summary    "Update the source span of a relation."
                      :middleware [[pra/wrap-writer-required get-project-id]]
                      :parameters {:body [:map [:span-id :uuid]]}
                      :handler    (fn [{{{:keys [relation-id]} :path {:keys [span-id]} :body} :parameters xtdb :xtdb}]
                                    (let [{:keys [success code error]} (rel/set-end {:node xtdb} relation-id :relation/source span-id)]
                                      (if success
                                        {:status 200 :body (dissoc (rel/get xtdb relation-id) :xt/id)}
                                        {:status (or code 400) :body {:error (or error "Failed to update relation source")}})))}}]
    ["/target" {:put {:summary    "Update the target span of a relation."
                      :middleware [[pra/wrap-writer-required get-project-id]]
                      :parameters {:body [:map [:span-id :uuid]]}
                      :handler    (fn [{{{:keys [relation-id]} :path {:keys [span-id]} :body} :parameters xtdb :xtdb}]
                                    (let [{:keys [success code error]} (rel/set-end {:node xtdb} relation-id :relation/target span-id)]
                                      (if success
                                        {:status 200 :body (dissoc (rel/get xtdb relation-id) :xt/id)}
                                        {:status (or code 400) :body {:error (or error "Failed to update relation target")}})))}}]]])