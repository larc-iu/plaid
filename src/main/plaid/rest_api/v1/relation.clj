(ns plaid.rest-api.v1.relation
  (:require [plaid.rest-api.v1.auth :as pra]
            [reitit.coercion.malli]
            [plaid.xtdb.relation :as r]
            [plaid.xtdb.relation-layer :as rl]))

(defn get-project-id
  "Derive the project ID from a relation-layer or existing relation."
  [{db :db params :params}]
  (let [rl-id (-> params :body :layer-id)
        relation-id (-> params :path :relation-id)]
    (cond
      rl-id (rl/project-id db rl-id)
      relation-id (r/project-id db relation-id)
      :else nil)))

(def relation-routes
  ["/relations"

   ;; Create
   ["" {:post {:summary    (str "Create a new relation. A relation is a directed edge between two spans with a value, "
                                "useful for expressing phenomena such as syntactic or semantic relations. A relation "
                                "must at all times have both a valid source and target span. These spans must also "
                                "belong to a single span layer which is linked to the relation's relation layer."
                                "\n"
                                "\n<body>layer-id</body>: the relation layer"
                                "\n<body>source-id</body>: the source span this relation originates from"
                                "\n<body>target-id</body>: the target span this relation goes to"
                                "\n<body>value</value>: the label for the relation")
               :middleware [[pra/wrap-writer-required get-project-id]]
               :parameters {:body [:map
                                   [:layer-id :uuid]
                                   [:source-id :uuid]
                                   [:target-id :uuid]
                                   [:value any?]]}
               :handler    (fn [{{{:keys [layer-id source-id target-id value ]} :body} :parameters xtdb :xtdb user-id :user/id :as request}]
                             (let [attrs {:relation/layer  layer-id
                                          :relation/source source-id
                                          :relation/target target-id
                                          :relation/value  value}
                                   result (r/create {:node xtdb} attrs user-id)]
                               (if (:success result)
                                 {:status 201 :body {:id (:extra result)}}
                                 {:status (or (:code result) 400) :body {:error (:error result)}})))}}]

   ;; Get, update, delete by ID
   ["/:relation-id"
    {:parameters {:path [:map [:relation-id :uuid]]}}
    ["" {:get    {:summary    "Get a relation by ID."
                  :middleware [[pra/wrap-reader-required get-project-id]]
                  :handler    (fn [{{{:keys [relation-id]} :path} :parameters db :db}]
                                (let [relation (r/get db relation-id)]
                                  (if (some? relation)
                                    {:status 200 :body (dissoc relation :xt/id)}
                                    {:status 404 :body {:error "Relation not found"}})))}
         :patch  {:summary    "Update a relation's value."
                  :middleware [[pra/wrap-writer-required get-project-id]]
                  :parameters {:body [:map [:value any?]]}
                  :handler    (fn [{{{:keys [relation-id]} :path {:keys [value]} :body} :parameters xtdb :xtdb user-id :user/id :as request}]
                                (let [{:keys [success code error]} (r/merge {:node xtdb} relation-id {:relation/value value} user-id)]
                                  (if success
                                    {:status 200 :body (dissoc (r/get xtdb relation-id) :xt/id)}
                                    {:status (or code 404) :body {:error (or error "Failed to update relation or relation not found")}})))}
         :delete {:summary    "Delete a relation."
                  :middleware [[pra/wrap-writer-required get-project-id]]
                  :handler    (fn [{{{:keys [relation-id]} :path} :parameters xtdb :xtdb user-id :user/id}]
                                (let [{:keys [success code error]} (r/delete {:node xtdb} relation-id user-id)]
                                  (if success
                                    {:status 204}
                                    {:status (or code 404) :body {:error (or error "Relation not found")}})))}}]
    ["/source" {:put {:summary    "Update the source span of a relation."
                      :middleware [[pra/wrap-writer-required get-project-id]]
                      :parameters {:body [:map [:span-id :uuid]]}
                      :handler    (fn [{{{:keys [relation-id]} :path {:keys [span-id]} :body} :parameters xtdb :xtdb user-id :user/id}]
                                    (let [{:keys [success code error]} (r/set-end {:node xtdb} relation-id :relation/source span-id user-id)]
                                      (if success
                                        {:status 200 :body (dissoc (r/get xtdb relation-id) :xt/id)}
                                        {:status (or code 400) :body {:error (or error "Failed to update relation source")}})))}}]
    ["/target" {:put {:summary    "Update the target span of a relation."
                      :middleware [[pra/wrap-writer-required get-project-id]]
                      :parameters {:body [:map [:span-id :uuid]]}
                      :handler    (fn [{{{:keys [relation-id]} :path {:keys [span-id]} :body} :parameters xtdb :xtdb user-id :user/id}]
                                    (let [{:keys [success code error]} (r/set-end {:node xtdb} relation-id :relation/target span-id user-id)]
                                      (if success
                                        {:status 200 :body (dissoc (r/get xtdb relation-id) :xt/id)}
                                        {:status (or code 400) :body {:error (or error "Failed to update relation target")}})))}}]]])