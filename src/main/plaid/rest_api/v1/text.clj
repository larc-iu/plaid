(ns plaid.rest-api.v1.text
  (:require [plaid.rest-api.v1.auth :as pra]
            [reitit.coercion.malli]
            [plaid.xtdb.text-layer :as txtl]
            [plaid.xtdb.text :as txt]))

(defn get-project-id [{xtdb :xtdb params :params}]
  (let [txtl-id (-> params :body :text-layer-id)
        text-id (-> params :path :text-id)]
    (cond
      txtl-id (txtl/project-id xtdb txtl-id)
      text-id (txt/project-id xtdb text-id)
      :else nil)))

(def text-routes
  ["/texts"

   ["" {:post {:summary    "Create a new text for a document."
               :middleware [[pra/wrap-writer-required get-project-id]]
               :parameters {:body [:map
                                   [:text-layer-id :uuid]
                                   [:document-id :uuid]
                                   [:body string?]]}
               :handler    (fn [{{{:keys [text-layer-id document-id body]} :body} :parameters xtdb :xtdb}]
                             (let [attrs {:text/layer    text-layer-id
                                          :text/document document-id
                                          :text/body     body}
                                   result (txt/create {:node xtdb} attrs)]
                               (if (:success result)
                                 {:status 201
                                  :body   {:id (:extra result)}}
                                 {:status (or (:code result) 500)
                                  :body   {:error (:error result)}})))}}]

   ["/:text-id"
    {:parameters {:path [:map [:text-id :uuid]]}}

    ["" {:get    {:summary    "Get a text by ID."
                  :middleware [[pra/wrap-reader-required get-project-id]]
                  :handler    (fn [{{{:keys [text-id]} :path} :parameters xtdb :xtdb}]
                                (let [text (txt/get xtdb text-id)]
                                  (if (some? text)
                                    {:status 200
                                     :body   (dissoc text :xt/id)}
                                    {:status 404
                                     :body   {:error "Text not found"}})))}
         :patch  {:summary    "Update a text's body."
                  :middleware [[pra/wrap-writer-required get-project-id]]
                  :parameters {:body [:map [:body string?]]}
                  :handler    (fn [{{{:keys [text-id]} :path {:keys [body]} :body} :parameters xtdb :xtdb}]
                                (let [{:keys [success code error]} (txt/update-body {:node xtdb} text-id body)]
                                  (if success
                                    {:status 200
                                     :body   (dissoc (txt/get xtdb text-id) :xt/id)}
                                    {:status (or code 404)
                                     :body   {:error (or error "Failed to update text or text not found")}})))}
         :delete {:summary    "Delete a text."
                  :middleware [[pra/wrap-writer-required get-project-id]]
                  :handler    (fn [{{{:keys [text-id]} :path} :parameters xtdb :xtdb}]
                                (let [{:keys [success code error]} (txt/delete {:node xtdb} text-id)]
                                  (if success
                                    {:status 204}
                                    {:status (or code 404)
                                     :body   {:error (or error "Text not found")}})))}}]]])