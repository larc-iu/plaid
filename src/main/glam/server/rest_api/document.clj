(ns glam.server.rest-api.document
  (:require [glam.server.pathom-parser :refer [parser]]
            [glam.server.id-counter :refer [id?]]
            [glam.models.document :as doc]
            [glam.server.rest-api.util :as util]
            [glam.server.rest-api.common :refer [document-body-query]]
            [malli.experimental.lite :as ml])
  (:import (java.util UUID)))

(defn create-document [{{{:keys [name project]} :body} :parameters :as req}]
  (let [params {:delta {:document/name {:after name}}
                :ident [:document/id (UUID/randomUUID)]
                :parent-ident [:project/id project]
                :parent-id project}
        result (parser req [(list `doc/create-document params)])
        data (get result `doc/create-document)]
    (if (:server/error? data)
      {:status (:server/code data)
       :body   data}
      {:status 200
       :body   {:id (-> data
                        (dissoc :tempids)
                        (assoc :id (-> data :tempids first second)))
                :message "Document created."}})))

(defn get-document [{{{:keys [id]} :path
                      {:keys [includeBody]} :query} :parameters :as req}]
  (let [query [{[:document/id id]
                (cond-> [:document/id :document/name
                         {:document/lock-holder [:user/id :user/name :user/email]}]
                        (true? includeBody) (conj document-body-query))}]
        result (parser req query)
        data (get result [:document/id id])]
    (if (util/failed-get? data)
      {:status 404
       :body   {:error true :message "Document does not exist."}}
      {:status 200
       :body   data})))

(defn delete-document [{{{:keys [id]} :path} :parameters :as req}]
  (let [result (parser req [(list `doc/delete-document {:ident [:document/id id]})])
        data (get result `doc/delete-document)]
    {:status (:server/code data)
     :body data}))

(defn patch-document [{{{:keys [id]} :path
                    {:keys [action name]} :body} :parameters :as req}]
  (let [action-symbol ({"setName" `doc/save-document} action)
        action-params ({"setName" {:ident [:document/id id]
                                   :delta {:document/name {:after name}}}} action)]
    (if (nil? action-symbol)
      {:status 400
       :body {:error true :message (str "Unknown action: `" action "`")}}
      (let [result (parser req [(list action-symbol (merge {:document/id id} action-params))])
            data (get result action-symbol)]
        {:status (:server/code data)
         :body   data}))))

(defn get-lock [{{{:keys [id]} :path} :parameters :as req}]
  (let [query [{[:document/id id]
                [:document/id {:document/lock-holder [:user/id :user/name :user/email]}]}]
        result (parser req query)
        data (get result [:document/id id])]
    (if (util/failed-get? data)
      {:status 404
       :body   {:error true :message "Document does not exist."}}
      {:status 200
       :body   (if (nil? (-> data :document/lock-holder :user/id))
                 {:id nil :lockFree true}
                 (assoc (:document/lock-holder data) :lockFree false))})))

(defn patch-lock [{{{:keys [id]} :path
                        {:keys [action]} :body} :parameters :as req}]
  (let [action-symbol ({"acquire" `doc/acquire-lock
                        "release" `doc/release-lock} action)
        action-params ({"acquire" {:document/id id}
                        "release" {:document/id id}} action)]
    (if (nil? action-symbol)
      {:status 400
       :body {:error true :message (str "Unknown action: `" action "`")}}
      (let [result (parser req [(list action-symbol (merge {:document/id id} action-params))])
            data (get result action-symbol)]
        {:status (:server/code data)
         :body   data}))))

(def document-routes
  [""
   [""
    {:post {:parameters  {:body {:name string? :project id?}}
            :description "Creates a new document. ID is given in the response under \"id\"."
            :handler     create-document}}]

   ["/:id"
    [""
     {:get    {:parameters {:path  {:id id?}
                            :query {:includeBody boolean?}}
               :handler    get-document}
      :delete {:parameters {:path {:id id?}}
               :handler    delete-document}
      :patch  {:parameters  {:path {:id id?}
                             :body {:action [:enum "setName"]
                                    :name   string?}}
               :description "setName: sets the document's name."
               :handler     patch-document}}]

    ["/lock"
     {:get   {:handler get-lock
              :parameters {:path {:id id?}}}
      :patch {:parameters  {:path {:id id?}
                            :body {:action [:enum "acquire" "release"]}}
              :description (str "`acquire`: attempt to get the lock (403 if it is held)\n"
                                "`release`: release your hold on the lock (403 if it is held)")
              :handler     patch-lock}}]]])
