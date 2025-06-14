(ns plaid.rest-api.v1.audit
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.xtdb.audit :as audit]
            [plaid.xtdb.project :as prj]
            [plaid.xtdb.document :as doc]))

(defn get-project-id-from-audit-path
  "Extract project ID from audit path parameters"
  [{:keys [params]}]
  (-> params :path :project-id))

(defn get-project-id-from-document
  "Get project ID from document ID in path"
  [{:keys [db params]}]
  (let [document-id (-> params :path :document-id)
        document (doc/get db document-id)]
    (:document/project document)))

(def audit-routes
  [["/projects/:project-id/audit"
    {:parameters {:path [:map [:project-id :uuid]]}
     :get {:summary    "Get audit log for a project"
           :middleware [[pra/wrap-reader-required get-project-id-from-audit-path]]
           :parameters {:query [:map
                               [:start-time {:optional true} inst?]
                               [:end-time {:optional true} inst?]]}
           :handler    (fn [{{{:keys [project-id]} :path {:keys [start-time end-time]} :query} :parameters db :db}]
                        (let [entries (audit/get-project-audit-log db project-id start-time end-time)]
                          {:status 200 :body entries}))}}]

   ["/documents/:document-id/audit"
    {:parameters {:path [:map [:document-id :uuid]]}
     :get {:summary    "Get audit log for a document"
           :middleware [[pra/wrap-reader-required get-project-id-from-document]]
           :parameters {:query [:map
                               [:start-time {:optional true} inst?]
                               [:end-time {:optional true} inst?]]}
           :handler    (fn [{{{:keys [document-id]} :path {:keys [start-time end-time]} :query} :parameters db :db}]
                        (let [entries (audit/get-document-audit-log db document-id start-time end-time)]
                          {:status 200 :body entries}))}}]

   ["/users/:user-id/audit"
    {:parameters {:path [:map [:user-id string?]]}
     :get        {:summary    "Get audit log for a user's actions"
                  :middleware [[pra/wrap-admin-required]]  ; Only admins can view other users' audit logs
                  :parameters {:query [:map
                                       [:start-time {:optional true} inst?]
                                       [:end-time {:optional true} inst?]]}
                  :handler    (fn [{{{:keys [user-id]} :path {:keys [start-time end-time]} :query} :parameters db :db}]
                                (let [entries (audit/get-user-audit-log db user-id start-time end-time)]
                                  {:status 200 :body entries}))}}]])