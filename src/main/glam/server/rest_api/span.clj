(ns glam.server.rest-api.span
  (:require [glam.server.pathom-parser :refer [parser]]
            [glam.server.id-counter :refer [id?]]
            [glam.models.span :as span]
            [glam.server.rest-api.util :as util]))

(defn create-span [{{{:keys [value layer tokens]} :body} :parameters :as req}]
  (let [result (parser req [(list `span/create-span {:span/layer layer :span/value value :span/tokens tokens})])
        data (get result `span/create-span)]
    (if (:server/error? data)
      {:status 403
       :body   data}
      {:status 200
       :body   (util/get-created-id data)})))

(defn get-span [{{{:keys [id]} :path} :parameters :as req}]
  (let [result (parser req [{[:span/id id] [:span/id :span/value :span/layer :span/tokens]}])
        data (get result [:span/id id])]
    {:status 200
     :body   data}))

(defn patch-span [{{{:keys [id]} :path
                    {:keys [action value]} :body} :parameters :as req}]
  (let [result (parser req [(list `span/save-span {:span/id id :span/value value})])
        data (get result `span/save-span)]
    (if (:server/error? data)
      {:status 403
       :body   data}
      {:status 200
       :body   data})))

(def span-routes
  ["/span"
   [""
    {:post {:parameters {:body {:value string? :layer id? :tokens [:vector id?]}}
            :handler    create-span}}]

   ["/:id"
    {:get {:parameters {:path {:id id?}}
           :handler    get-span}
     :patch {:parameters {:path {:id id?}
                          :body {:action [:enum "setValue"] :value any?}}
             :description "setValue: sets the span's `value` to body param `value`."
             :handler patch-span}}]])
