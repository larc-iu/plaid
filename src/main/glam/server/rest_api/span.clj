(ns glam.server.rest-api.span
  (:require [glam.server.pathom-parser :refer [parser]]
            [glam.server.id-counter :refer [id?]]
            [glam.models.span :as span]
            [glam.server.rest-api.util :as util]
            [malli.experimental.lite :as ml]))

(defn create-span [{{{:keys [value layer tokens]} :body} :parameters :as req}]
  (let [result (parser req [(list `span/create-span {:span/layer layer :span/value value :span/tokens tokens})])
        data (get result `span/create-span)]
    (if (:server/error? data)
      {:status (:server/code data)
       :body   data}
      {:status 200
       :body   (util/get-created-id data)})))

(defn get-span [{{{:keys [id]} :path} :parameters :as req}]
  (let [result (parser req [{[:span/id id] [:span/id :span/value :span/layer :span/tokens]}])
        data (get result [:span/id id])]
    (if (util/failed-get? data)
      {:status 404
       :body   {:error true :message "Span does not exist."}}
      {:status 200
       :body   data})))

(defn delete-span [{{{:keys [id]} :path} :parameters :as req}]
  (let [result (parser req [(list `span/delete-span {:span/id id})])
        data (get result `span/delete-span)]
    {:status (:server/code data)
     :body data}))

(defn patch-span [{{{:keys [id]} :path
                    {:keys [action value tokens]} :body} :parameters :as req}]
  (let [action-symbol ({"setValue" `span/update-value
                        "setTokens" `span/update-tokens} action)
        action-params ({"setValue" {:span/value value}
                        "setTokens" {:span/tokens tokens}} action)]
    (if (nil? action-symbol)
      {:status 400
       :body {:error true :message (str "Unknown action: `" action "`")}}
      (let [result (parser req [(list action-symbol (merge {:span/id id} action-params))])
            data (get result action-symbol)]
        {:status (:server/code data)
         :body   data}))))

(def span-routes
  ["/span"
   [""
    {:post {:parameters {:body {:value any?
                                :layer id?
                                :tokens [:vector id?]}}
            :description "Creates a new span. ID is given in the response under \"id\"."
            :handler    create-span}}]

   ["/:id"
    {:get {:parameters {:path {:id id?}}
           :handler    get-span}
     :delete {:parameters {:path {:id id?}}
              :handler delete-span}
     :patch
     {:parameters {:path {:id id?}
                   :body {:action [:enum "setValue" "setTokens"]
                          :value  (ml/optional any?)
                          :tokens (ml/optional [:vector id?])}}
      :description "setValue: sets the span's `value` to body param `value`.
                    setTokens: overwrite the span's `tokens` so that it exactly matches what's in body param `tokens`"
      :handler patch-span}}]])
