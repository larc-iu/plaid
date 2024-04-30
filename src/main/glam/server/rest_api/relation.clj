(ns glam.server.rest-api.relation
  (:require [glam.server.id-counter :refer [id?]]
            [glam.models.relation :as r]
            [glam.server.rest-api.util :as util]
            [malli.experimental.lite :as ml]))

(defn create-relation [{{{:keys [value layer source target]} :body} :parameters parser :pathom-parser  :as req}]
  (let [result (parser req [(list `r/create-relation
                                  {:relation/layer layer
                                   :relation/value value
                                   :relation/source source
                                   :relation/target target})])
        data (get result `r/create-relation)]
    (if (:server/error? data)
      {:status (:server/code data)
       :body   data}
      {:status 200
       :body   (util/get-created-id data)})))

(defn get-relation [{{{:keys [id]} :path} :parameters parser :pathom-parser :as req}]
  (let [result (parser req [{[:relation/id id]
                             [:relation/id :relation/layer :relation/value :relation/source :relation/target]}])
        data (get result [:relation/id id])]
    (if (util/failed-get? data)
      {:status 404
       :body   {:error true :message "Relation does not exist."}}
      {:status 200
       :body   data})))

(defn delete-relation [{{{:keys [id]} :path} :parameters parser :pathom-parser  :as req}]
  (let [result (parser req [(list `r/delete-relation {:relation/id id})])
        data (get result `r/delete-relation)]
    {:status (:server/code data)
     :body data}))

(defn patch-relation [{{{:keys [id]} :path
                        {:keys [action value source target]} :body} :parameters
                       parser :pathom-parser
                       :as req}]
  (let [action-symbol ({"setValue" `r/set-value
                        "setSource" `r/set-source
                        "setTarget" `r/set-target}
                       action)
        action-params ({"setValue" {:relation/value value}
                        "setSource" {:relation/source source}
                        "setTarget" {:relation/target target}}
                       action)]
    (if (nil? action-symbol)
      {:status 400
       :body {:error true :message (str "Unknown action: `" action "`")}}
      (let [result (parser req [(list action-symbol (merge {:relation/id id} action-params))])
            data (get result action-symbol)]
        {:status (:server/code data)
         :body   data}))))

(def relation-routes
  ["/relation"
   [""
    {:post {:parameters {:body {:value any?
                                :layer id?
                                :source id?
                                :target id?}}
            :description "Creates a new relation. ID is given in the response under \"id\"."
            :handler    create-relation}}]

   ["/:id"
    {:get {:parameters {:path {:id id?}}
           :handler    get-relation}
     :delete {:parameters {:path {:id id?}}
              :handler delete-relation}
     :patch
     {:parameters {:path {:id id?}
                   :body {:action [:enum "setValue" "setTarget" "setSource"]
                          :value  (ml/optional any?)
                          :source (ml/optional id?)
                          :target (ml/optional id?)}}
      :description "setValue: sets the relation's `value` to body param `value`.
                    setSource: sets the relation's `source` to body param `source`.
                    setTarget: sets the relation's `target` to body param `target`."
      :handler patch-relation}}]])