(ns plaid.rest-api.v1.token-layer
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.layer :refer [layer-config-routes]]
            [reitit.coercion.malli]
            [plaid.sql.text-layer :as txtl]
            [plaid.sql.token-layer :as tokl]))

(defn get-project-id [{db :db params :parameters}]
  (let [txtl-id (-> params :body :text-layer-id)
        tokl-id (-> params :path :token-layer-id)]
    (cond txtl-id
          (txtl/project-id db txtl-id)

          tokl-id
          (tokl/project-id db tokl-id)

          :else
          nil)))

(def token-layer-routes
  ["/token-layers"

   [""
    {:post {:summary    (str "Create a new token layer. The optional <body>overlap-mode</body> sets a per-layer "
                             "invariant on the layer's tokens and is immutable after creation:"
                             "\n<body>any</body> (default): tokens may overlap each other and leave gaps."
                             "\n<body>non-overlapping</body>: tokens in the same document may not overlap."
                             "\n<body>partitioning</body>: tokens must form a gap-free, non-overlapping, zero-width-free "
                             "cover of the entire text. A partitioning layer is always either empty (un-tokenized) or a "
                             "complete cover — never partial. On partitioning layers, single token create/update/delete "
                             "are rejected — use bulk-create to establish the partition and the token split/merge/shift "
                             "endpoints to modify it."
                             "\n"
                             "\nThe optional <body>parent-token-layer-id</body> makes this a nested layer (also "
                             "immutable): every token in this layer must be contained within a token of the parent "
                             "layer (which must belong to the same text layer). The parent layer must be "
                             "<body>non-overlapping</body> or <body>partitioning</body> (its tokens must be disjoint "
                             "so each child has exactly one containing parent — an <body>any</body> parent is rejected, "
                             "400), and tokens on a nested layer may not be zero-width. A nested layer may itself be "
                             "<body>any</body> or <body>non-overlapping</body> but not <body>partitioning</body> "
                             "(partitioning is reserved for root layers that tile the whole text) — e.g. words "
                             "(non-overlapping, parent=sentences) within sentences (partitioning). Structural "
                             "operations on a parent token cascade to the tokens nested in it: see the token "
                             "delete/split/merge/shift endpoints.")
            :middleware [[pra/wrap-maintainer-required get-project-id]]
            :parameters {:body [:map
                                [:text-layer-id :uuid]
                                [:name :string]
                                [:overlap-mode {:optional true} [:enum "any" "non-overlapping" "partitioning"]]
                                [:parent-token-layer-id {:optional true} :uuid]]}
            :handler    (fn [{{{:keys [name text-layer-id overlap-mode parent-token-layer-id]} :body} :parameters db :db user-id :user/id}]
                          (let [attrs (cond-> {:token-layer/name name}
                                        overlap-mode (assoc :token-layer/overlap-mode (keyword overlap-mode))
                                        parent-token-layer-id (assoc :token-layer/parent-token-layer parent-token-layer-id))
                                result (tokl/create db attrs text-layer-id user-id)]
                            (if (:success result)
                              {:status 201
                               :body   {:id (:extra result)}}
                              {:status (or (:code result) 500)
                               :body   {:error (:error result)}})))}}]

   ["/:token-layer-id"
    {:parameters {:path [:map [:token-layer-id :uuid]]}}

    [""
     {:get    {:summary "Get a token layer by ID."
               :middleware [[pra/wrap-reader-required get-project-id]]
               :handler (fn [{{{:keys [token-layer-id]} :path} :parameters db :db}]
                          (let [token-layer (tokl/get db token-layer-id)]
                            (if (some? token-layer)
                              {:status 200
                               :body   token-layer}
                              {:status 404
                               :body   {:error "Token layer not found"}})))}

      :patch  {:summary    "Update a token layer's name."
               :middleware [[pra/wrap-maintainer-required get-project-id]]
               :parameters {:body [:map [:name :string]]}
               :handler    (fn [{{{:keys [token-layer-id]} :path {:keys [name]} :body} :parameters db :db user-id :user/id}]
                             (let [{:keys [success code error]} (tokl/merge db token-layer-id {:token-layer/name name} user-id)]
                               (if success
                                 {:status 200
                                  :body   (tokl/get db token-layer-id)}
                                 {:status (or code 500)
                                  :body   {:error (or error "Internal server error")}})))}
      :delete {:summary "Delete a token layer."
               :middleware [[pra/wrap-maintainer-required get-project-id]]
               :handler (fn [{{{:keys [token-layer-id]} :path} :parameters db :db user-id :user/id}]
                          (let [{:keys [success code error]} (tokl/delete db token-layer-id user-id)]
                            (if success
                              {:status 204}
                              {:status (or code 500)
                               :body   {:error (or error "Internal server error")}})))}}]

    ["/shift"
     {:post {:summary    "Shift a token layer's order."
             :middleware [[pra/wrap-maintainer-required get-project-id]]
             :parameters {:body [:map [:direction [:enum "up" "down"]]]}
             :handler    (fn [{{{:keys [token-layer-id]} :path {:keys [direction]} :body} :parameters db :db user-id :user/id}]
                           (let [up? (= direction "up")
                                 {:keys [success code error]} (tokl/shift-token-layer db token-layer-id up? user-id)]
                             (if success
                               {:status 204}
                               {:status (or code 400)
                                :body   {:error (or error "Failed to shift token layer")}})))}}]

    (layer-config-routes :token-layer-id get-project-id)]])
