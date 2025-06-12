(ns plaid.rest-api.v1.text-layer
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.layer :refer [layer-config-routes]]
            [reitit.coercion.malli]
            [plaid.xtdb.text-layer :as txtl]))

(defn get-project-id [{db :db params :params}]
  (let [prj-id (-> params :body :project-id)
        txtl-id (-> params :path :text-layer-id)]
    (cond prj-id
          prj-id

          txtl-id
          (txtl/project-id db txtl-id)

          :else
          nil)))

(def text-layer-routes
  ["/text-layers"
   {:middleware [[pra/wrap-maintainer-required get-project-id]]}

   [""
    {:post {:summary    "Create a new text layer for a project."
            :parameters {:body [:map
                                [:project-id :uuid]
                                [:name :string]]}
            :handler    (fn [{{{:keys [project-id name]} :body} :parameters xtdb :xtdb :as req}]
                          (let [attrs {:text-layer/name name}]
                            (let [result (txtl/create {:node xtdb} attrs project-id)]
                              (if (:success result)
                                {:status 201
                                 :body   {:id (:extra result)}}
                                {:status (or (:code result) 500)
                                 :body   {:error (:error result)}}))))}}]

   ["/:text-layer-id"
    {:parameters {:path [:map [:text-layer-id :uuid]]}}

    [""
     {:get    {:summary "Get a text layer by ID."
               :handler (fn [{{{:keys [text-layer-id]} :path} :parameters db :db :as r}]
                          (let [text-layer (txtl/get db text-layer-id)]
                            (if (some? text-layer)
                              {:status 200
                               :body   (dissoc text-layer :xt/id)}
                              {:status 404
                               :body   {:error "Text layer not found"}})))}
      :patch  {:summary    "Update a text layer's name."
               :parameters {:body [:map [:name :string]]}
               :handler    (fn [{{{:keys [text-layer-id]} :path {:keys [name]} :body} :parameters xtdb :xtdb}]
                             (let [{:keys [success code error]} (txtl/merge {:node xtdb} text-layer-id {:text-layer/name name})]
                               (if success
                                 {:status 200
                                  :body   (dissoc (txtl/get xtdb text-layer-id) :xt/id)}
                                 {:status (or code 404)
                                  :body   {:error (or error "Failed to update text layer or text layer not found")}})))}
      :delete {:summary "Delete a text layer."
               :handler (fn [{{{:keys [text-layer-id]} :path} :parameters xtdb :xtdb}]
                          (let [{:keys [success code error]} (txtl/delete {:node xtdb} text-layer-id)]
                            (if success
                              {:status 204}
                              {:status (or code 404)
                               :body   {:error (or error "Text layer not found")}})))}}]

    ["/shift"
     {:post {:summary    "Shift a text layer's order within the project."
             :parameters {:body [:map [:direction [:enum "up" "down"]]]}
             :handler    (fn [{{{:keys [text-layer-id]} :path {:keys [direction]} :body} :parameters xtdb :xtdb}]
                           (let [up? (= direction "up")
                                 {:keys [success code error]} (txtl/shift-text-layer {:node xtdb} text-layer-id up?)]
                             (if success
                               {:status 204}
                               {:status (or code 400)
                                :body   {:error (or error "Failed to shift text layer")}})))}}]

    (layer-config-routes :text-layer-id)]])
