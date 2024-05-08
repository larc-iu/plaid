(ns glam.server.rest-api.text
  (:require [glam.server.id-counter :refer [id?]]
            [glam.models.text :as txt]
            [glam.server.rest-api.util :as util]
            [malli.experimental.lite :as ml]))

(defn create-text [{{{:keys [layer body document]} :body} :parameters parser :pathom-parser :as req}]
  (let [result (parser req [(list `txt/create-text {:text/layer layer :text/body body :text/document document})])
        data (get result `txt/create-text)]
    (if (:server/error? data)
      {:status (:server/code data)
       :body   data}
      {:status 200
       :body   (util/get-created-id data)})))

(defn get-text [{{{:keys [id]} :path} :parameters parser :pathom-parser :as req}]
  (let [result (parser req [{[:text/id id] [:text/id :text/body :text/layer :text/document]}])
        data (get result [:text/id id])]
    (if (util/failed-get? data)
      {:status 404
       :body   {:error true :message "Text does not exist."}}
      {:status 200
       :body   data})))

(defn delete-text [{{{:keys [id]} :path} :parameters parser :pathom-parser :as req}]
  (let [result (parser req [(list `txt/delete-text {:text/id id})])
        data (get result `txt/delete-text)]
    {:status (:server/code data)
     :body data}))

(defn patch-text [{{{:keys [id]} :path
                     {:keys [action ops] :as body} :body} :parameters parser :pathom-parser :as req}]
  (let [action-symbol ({"applyEdits" `txt/save-text} action)
        action-params ({"applyEdits" {:ops (mapv #(update % :type keyword) ops)}} action)]
    (if (nil? action-symbol)
      {:status 400
       :body {:error true :message (str "Unknown action: `" action "`")}}
      (let [result (parser req [(list action-symbol (merge {:text/id id} action-params))])
            data (get result action-symbol)]
        {:status (:server/code data)
         :body   data}))))

(def text-routes
  ["/text"
   [""
    {:post {:parameters {:body {:layer id?
                                :document id?
                                :body string?}}
            :description "Creates a new text. ID is given in the response under \"id\"."
            :handler    create-text}}]

   ["/:id"
    {:get {:parameters {:path {:id id?}}
           :handler    get-text}
     :delete {:parameters {:path {:id id?}}
              :handler delete-text}
     :patch
     {:parameters {:path {:id id?}
                   :body {:action [:enum "applyEdits"]
                          :ops    [:sequential map?]}}
      :description
      (str
        "applyEdits: apply a sequence of `insert` and `delete` ops to the body of the text.
        Parameter `ops` must be a list of objects that look like this:\n\n"

        "    {type: \"insert\",   {type: \"delete\",\n"
        "     index: 3,          index: 4,\n"
        "     value: \"is \"}      value: 3}\n\n"

        "For the `insert` op, the string indicated by `value` is inserted at the `index`.
        For the `delete` op, `value` chars are deleted starting from the `index`.\n\n"

        "We recommend that you use a library like fast-diff in order to accomplish this.
        See the original implementation of this in Glam here: https://github.com/lgessler/glam/blob/ddece77eabc31c5adb3d4b5ce5543cead12d6578/src/main/glam/algos/text.cljc#L17-L52")
      :handler    patch-text}}]])
