(ns plaid.rest-api.v1.relation
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.metadata :as metadata]
            [plaid.rest-api.v1.middleware :as prm]
            [reitit.coercion.malli]
            [xtdb.api :as xt]
            [plaid.xtdb.relation :as r]
            [plaid.xtdb.relation-layer :as rl]))

(defn get-project-id
  "Derive the project ID from a relation-layer or existing relation."
  [{db :db params :parameters}]
  (let [rl-id (-> params :body :layer-id)
        relation-id (-> params :path :relation-id)]
    (cond
      rl-id (rl/project-id db rl-id)
      relation-id (r/project-id db relation-id)
      :else nil)))

(defn bulk-get-project-id [{db :db params :parameters}]
  (let [rl-id (or (-> params :body first :relation-layer-id))
        relation-id (-> params :body first)]
    (cond
      rl-id (rl/project-id db rl-id)
      relation-id (r/project-id db relation-id)
      :else nil)))

(defn get-document-id
  "Get document ID from relation's source span."
  [{db :db params :parameters}]
  (let [source-id (-> params :body :source-id)
        span-id (-> params :body :span-id) ; For source/target updates
        relation-id (-> params :path :relation-id)]
    (cond
      ;; For new relation creation, use source span
      source-id
      (r/get-doc-id-of-span db source-id)

      ;; For source/target updates
      span-id
      (r/get-doc-id-of-span db span-id)

      ;; For existing relation operations
      relation-id
      (when-let [relation (r/get db relation-id)]
        (r/get-doc-id-of-span db (:relation/source relation)))

      :else nil)))

(defn bulk-get-document-id
  "Get document ID from first relation's source span."
  [{db :db params :parameters}]
  (when-let [first-relation (first (:body params))]
    (cond
      ;; For bulk create
      (:source first-relation)
      (r/get-doc-id-of-span db (:source first-relation))

      ;; For bulk delete (array of IDs)
      (uuid? first-relation)
      (when-let [relation (r/get db first-relation)]
        (r/get-doc-id-of-span db (:relation/source relation)))

      :else nil)))

(def relation-routes
  ["/relations"

   ;; Create
   ["" {:post {:summary (str "Create a new relation. A relation is a directed edge between two spans with a value, "
                             "useful for expressing phenomena such as syntactic or semantic relations. A relation "
                             "must at all times have both a valid source and target span. These spans must also "
                             "belong to a single span layer which is linked to the relation's relation layer."
                             "\n"
                             "\n<body>layer-id</body>: the relation layer"
                             "\n<body>source-id</body>: the source span this relation originates from"
                             "\n<body>target-id</body>: the target span this relation goes to"
                             "\n<body>value</value>: the label for the relation")
               :middleware [[pra/wrap-writer-required get-project-id]
                            [prm/wrap-document-version get-document-id]]
               :parameters {:query [:map [:document-version {:optional true} :uuid]]
                            :body [:map
                                   [:layer-id :uuid]
                                   [:source-id :uuid]
                                   [:target-id :uuid]
                                   [:value any?]
                                   [:metadata {:optional true} [:map-of string? any?]]]}
               :handler (fn [{{{:keys [layer-id source-id target-id value metadata]} :body} :parameters xtdb :xtdb user-id :user/id :as request}]
                          (let [attrs {:relation/layer layer-id
                                       :relation/source source-id
                                       :relation/target target-id
                                       :relation/value value}
                                result (r/create {:node xtdb} attrs user-id metadata)]
                            (if (:success result)
                              (prm/assoc-document-versions-in-header
                                {:status 201 :body {:id (:extra result)}}
                                result)
                              {:status (or (:code result) 500) :body {:error (:error result)}})))}}]

   ["/bulk" {:conflicting true
             :post {:summary (str "Create multiple relations in a single operation. Provide an array of objects whose keys"
                                  "are:\n"
                                  "<body>relation-layer-id</body>, the relation's layer\n"
                                  "<body>source</body>, the span id of the relation's source\n"
                                  "<body>target</body>, the span id of the relation's target\n"
                                  "<body>value</body>, the relation's value\n"
                                  "<body>metadata</body>, an optional map of metadata")
                    :openapi {:x-client-method "bulk-create"}
                    :middleware [[pra/wrap-writer-required bulk-get-project-id]
                                 [prm/wrap-document-version bulk-get-document-id]]
                    :parameters {:query [:map [:document-version {:optional true} :uuid]]
                                 :body [:sequential
                                        [:map
                                         [:relation-layer-id :uuid]
                                         [:source :uuid]
                                         [:target :uuid]
                                         [:value any?]
                                         [:metadata {:optional true} [:map-of string? any?]]]]}
                    :handler (fn [{{relations :body} :parameters xtdb :xtdb user-id :user/id}]
                               (let [relations-attrs (mapv (fn [relation-data]
                                                             (let [{:keys [relation-layer-id source target value metadata]} relation-data
                                                                   attrs {:relation/layer relation-layer-id
                                                                          :relation/source source
                                                                          :relation/target target
                                                                          :relation/value value}]
                                                               (if metadata
                                                                 (assoc attrs :metadata metadata)
                                                                 attrs)))
                                                           relations)
                                     result (r/bulk-create {:node xtdb} relations-attrs user-id)]
                                 (if (:success result)
                                   (prm/assoc-document-versions-in-header
                                     {:status 201 :body {:ids (:extra result)}}
                                     result)
                                   {:status (or (:code result) 500)
                                    :body {:error (:error result)}})))}
             :delete {:summary "Delete multiple relations in a single operation. Provide an array of IDs."
                      :openapi {:x-client-method "bulk-delete"}
                      :middleware [[pra/wrap-writer-required bulk-get-project-id]
                                   [prm/wrap-document-version bulk-get-document-id]]
                      :parameters {:query [:map [:document-version {:optional true} :uuid]]
                                   :body [:sequential :uuid]}
                      :handler (fn [{{relation-ids :body} :parameters xtdb :xtdb user-id :user/id}]
                                 (let [{:keys [success code error] :as result} (r/bulk-delete {:node xtdb} relation-ids user-id)]
                                   (if success
                                     (prm/assoc-document-versions-in-header
                                       {:status 204}
                                       result)
                                     {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]

   ;; Get, update, delete by ID
   ["/:relation-id"
    {:conflicting true
     :parameters {:path [:map [:relation-id :uuid]]}}
    ["" {:get {:summary "Get a relation by ID."
               :middleware [[pra/wrap-reader-required get-project-id]]
               :handler (fn [{{{:keys [relation-id]} :path} :parameters db :db}]
                          (let [relation (r/get db relation-id)]
                            (if (some? relation)
                              {:status 200 :body relation}
                              {:status 404 :body {:error "Relation not found"}})))}
         :patch {:summary "Update a relation's value."
                 :middleware [[pra/wrap-writer-required get-project-id]
                              [prm/wrap-document-version get-document-id]]
                 :parameters {:query [:map [:document-version {:optional true} :uuid]]
                              :body [:map [:value any?]]}
                 :handler (fn [{{{:keys [relation-id]} :path {:keys [value]} :body} :parameters xtdb :xtdb user-id :user/id :as request}]
                            (let [{:keys [success code error] :as result} (r/merge {:node xtdb} relation-id {:relation/value value} user-id)]
                              (if success
                                (prm/assoc-document-versions-in-header
                                  {:status 200 :body (r/get xtdb relation-id)}
                                  result)
                                {:status (or code 500) :body {:error (or error "Internal server error")}})))}
         :delete {:summary "Delete a relation."
                  :parameters {:query [:map [:document-version {:optional true} :uuid]]}
                  :middleware [[pra/wrap-writer-required get-project-id]
                               [prm/wrap-document-version get-document-id]]
                  :handler (fn [{{{:keys [relation-id]} :path} :parameters xtdb :xtdb user-id :user/id}]
                             (let [{:keys [success code error] :as result} (r/delete {:node xtdb} relation-id user-id)]
                               (if success
                                 (prm/assoc-document-versions-in-header
                                   {:status 204}
                                   result)
                                 {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]
    ["/source" {:put {:summary "Update the source span of a relation."
                      :middleware [[pra/wrap-writer-required get-project-id]
                                   [prm/wrap-document-version get-document-id]]
                      :openapi {:x-client-method "set-source"}
                      :parameters {:query [:map [:document-version {:optional true} :uuid]]
                                   :body [:map [:span-id :uuid]]}
                      :handler (fn [{{{:keys [relation-id]} :path {:keys [span-id]} :body} :parameters xtdb :xtdb user-id :user/id}]
                                 (let [{:keys [success code error] :as result} (r/set-end {:node xtdb} relation-id :relation/source span-id user-id)]
                                   (if success
                                     (prm/assoc-document-versions-in-header
                                       {:status 200 :body (r/get xtdb relation-id)}
                                       result)
                                     {:status (or code 400) :body {:error (or error "Failed to update relation source")}})))}}]
    ["/target" {:put {:summary "Update the target span of a relation."
                      :middleware [[pra/wrap-writer-required get-project-id]
                                   [prm/wrap-document-version get-document-id]]
                      :openapi {:x-client-method "set-target"}
                      :parameters {:query [:map [:document-version {:optional true} :uuid]]
                                   :body [:map [:span-id :uuid]]}
                      :handler (fn [{{{:keys [relation-id]} :path {:keys [span-id]} :body} :parameters xtdb :xtdb user-id :user/id}]
                                 (let [{:keys [success code error] :as result} (r/set-end {:node xtdb} relation-id :relation/target span-id user-id)]
                                   (if success
                                     (prm/assoc-document-versions-in-header
                                       {:status 200 :body (r/get xtdb relation-id)}
                                       result)
                                     {:status (or code 400) :body {:error (or error "Failed to update relation target")}})))}}]

    ;; Metadata operations  
    (metadata/metadata-routes "relation" :relation-id get-project-id get-document-id r/get r/set-metadata r/delete-metadata)]])