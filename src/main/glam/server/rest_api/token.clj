(ns glam.server.rest-api.token
  (:require [glam.server.id-counter :refer [id?]]
            [glam.models.token :as tok]
            [glam.server.rest-api.util :as util]
            [malli.experimental.lite :as ml]))

(defn create-token [{{{:keys [layer text begin end]} :body} :parameters parser :pathom-parser :as req}]
  (let [result (parser req [(list `tok/create {:token/layer layer :token/text text
                                               :token/begin begin :token/end end})])
        data (get result `tok/create)]
    (if (:server/error? data)
      {:status (:server/code data)
       :body   data}
      {:status 200
       :body   (util/get-created-id data)})))

(defn get-token [{{{:keys [id]} :path} :parameters parser :pathom-parser :as req}]
  (let [result (parser req [{[:token/id id] [:token/id :token/layer :token/text :token/begin :token/end]}])
        data (get result [:token/id id])]
    (if (util/failed-get? data)
      {:status 404
       :body   {:error true :message "Token does not exist."}}
      {:status 200
       :body   data})))

(defn delete-token [{{{:keys [id]} :path} :parameters parser :pathom-parser :as req}]
  (let [result (parser req [(list `tok/delete {:token/id id})])
        data (get result `tok/delete)]
    {:status (:server/code data)
     :body data}))

(defn patch-token [{{{:keys [id]} :path
                     {:keys [action newBegin newEnd deltaBegin deltaEnd] :as body} :body} :parameters parser :pathom-parser :as req}]
  (let [action-symbol ({"setExtent" `tok/set-extent} action)
        action-params ({"setExtent" {:new-begin newBegin :new-end newEnd
                                     :delta-begin deltaBegin :delta-end deltaEnd}} action)]
    (if (nil? action-symbol)
      {:status 400
       :body {:error true :message (str "Unknown action: `" action "`")}}
      (let [result (parser req [(list action-symbol (merge {:token/id id} action-params))])
            data (get result action-symbol)]
        {:status (:server/code data)
         :body   data}))))

(def token-routes
  ["/token"
   [""
    {:post {:parameters {:body {:begin int?
                                :end int?
                                :layer id?
                                :text id?}}
            :description "Creates a new token. ID is given in the response under \"id\"."
            :handler    create-token}}]

   ["/:id"
    {:get {:parameters {:path {:id id?}}
           :handler    get-token}
     :delete {:parameters {:path {:id id?}}
              :handler delete-token}
     :patch
     {:parameters {:path {:id id?}
                   :body {:action [:enum "setExtent"]
                          :newBegin (ml/optional int?)
                          :newEnd (ml/optional int?)
                          :deltaBegin (ml/optional int?)
                          :deltaEnd (ml/optional int?)}}
      :description (str "setExtent: modify the left and/or right boundaries of a token. `new` params specify absolute "
                        "text offsets, while `delta` params specify a difference relative to the existing offset. "
                        "If both are present for either `Begin` or `End`, the `new` parameter is used.")
      :handler patch-token}}]])
