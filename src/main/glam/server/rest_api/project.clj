(ns glam.server.rest-api.project
  (:require [glam.server.id-counter :refer [id?]]
            [glam.models.project :as prj]
            [malli.experimental.lite :as ml]
            [glam.server.rest-api.util :as util]
            [glam.server.rest-api.common :refer [layer-schema-query]])
  (:import (java.util UUID)))

;; User routes --------------------------------------------------------------------------------
(defn get-accessible-projects [{parser :pathom-parser :as req}]
  (let [result (parser req [{:accessible-projects [:project/id :project/name]}])
        data (get result :accessible-projects)]
    {:status 200 :body data}))

(defn get-project [{{{:keys [id]} :path
                     {:keys [includeDocuments]} :query} :parameters
                    parser :pathom-parser
                    :as req}]
  (let [query [{[:project/id id]
                (cond-> [:project/id :project/name
                         {:project/writers [:user/id :user/name]}
                         {:project/readers [:user/id :user/name]}
                         {:project/text-layers layer-schema-query}]
                        (true? includeDocuments) (conj {:project/documents
                                                        [:document/id :document/name
                                                         {:document/lock-holder [:user/id :user/name :user/email]}]}))}]
        result (parser req query)
        data (get result [:project/id id])]
    (if (util/failed-get? data)
      {:status 404
       :body   {:error true :message "Project does not exist."}}
      {:status 200
       :body data})))

(def project-routes
  [""
   ["/projects"
    {:get {:handler get-accessible-projects}}]
   ["/project/:id"
    {:get {:handler get-project
           :parameters {:path {:id id?}
                        :query {:includeDocuments boolean?}}}}]])

(defn get-projects [{parser :pathom-parser :as req}]
  (let [result (parser req [{:all-projects [:project/id :project/name]}])
        data (get result :all-projects)]
    {:status 200 :body data}))

(defn create-project [{{{:keys [name]} :body} :parameters parser :pathom-parser :as req}]
  (let [params {:delta {:project/name {:after name}}
                :ident [:project/id (UUID/randomUUID)]}
        result (parser req [(list `prj/create-project params)])
        data (get result `prj/create-project)]
    (if (:server/error? data)
      {:status (:server/code data)
       :body   data}
      {:status 200
       :body   {:id      (-> data
                             (dissoc :tempids)
                             (assoc :id (-> data :tempids first second)))
                :message "Project created."}})))

(defn patch-project [{{{:keys [id]} :path
                       {:keys [userId privileges name action]} :body} :parameters
                      parser :pathom-parser :as req}]
  (let [action-symbol ({"setName" `prj/save-project
                        "setPrivileges" `prj/set-user-privileges} action)
        action-params ({"setName" {:delta {:project/name {:after name}} :ident [:project/id id]}
                        "setPrivileges"   {:user/id userId :project/id id :user/privileges privileges}} action)]
    (if (nil? action-symbol)
      {:status 400
       :body {:error true :message (str "Unknown action: `" action "`")}}
      (let [result (parser req [(list action-symbol action-params)])
            data (get result action-symbol)]
        (if (:server/error? data)
          {:status (:server/code data)
           :body   data}
          {:status 200
           :body   (if (= action-symbol `prj/save-project)
                     {:message (str "Text layer name changed to " name)
                      :error   false}
                     data)})))))

(def project-admin-routes
  [""
   ["/projects"
    {:get {:handler get-projects}}]
   ["/project"
    [""
     {:post {:handler     create-project
             :description "Creates a new project. ID is given in the response under \"id\"."
             :parameters  {:body {:name string?}}}}]
    ["/:id"
     {:get {:handler get-project
            :parameters {:query {:includeDocuments boolean?}
                         :path {:id id?}}}
      :patch {:handler patch-project
              :description (str "setName: sets the project's `name` to body param `name`."
                                "\nsetPrivileges: sets `userId`'s privileges on a project to `privileges`."
                                " Valid values are \"reader\", \"writer\", and \"none\".")
              :parameters {:path {:id id?}
                           :body {:action     [:enum "setPrivileges" "setName"]
                                  :name       (ml/optional string?)
                                  :userId     (ml/optional id?)
                                  :privileges (ml/optional [:enum "reader" "writer" "none"])}}}}]]])