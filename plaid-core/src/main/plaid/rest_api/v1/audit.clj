(ns plaid.rest-api.v1.audit
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.pagination :as pagination]
            [plaid.sql.audit :as audit]
            [plaid.sql.document :as doc]))

(defn get-project-id-from-audit-path
  "Extract project ID from audit path parameters"
  [{params :parameters}]
  (-> params :path :project-id))

(defn get-project-id-from-document
  "Get project ID from document ID in path"
  [{db :db params :parameters}]
  (let [document-id (-> params :path :document-id)
        document (doc/get db document-id)]
    (:document/project document)))

;; Pagination query schema: shared by all three audit endpoints. The audit
;; log is always paginated into the uniform `{:entries :next-cursor}`
;; envelope (default page 100, max 1000); `:cursor` is the opaque token from
;; the previous page's `:next-cursor`. Adds the audit-only time-window
;; params on top of the shared `?limit`/`?cursor`.
(def ^:private pagination-query
  (into [:map
         [:start-time {:optional true} inst?]
         [:end-time {:optional true} inst?]]
        pagination/query-params))

(def audit-routes
  [["/projects/:project-id/audit"
    {:parameters {:path [:map [:project-id :uuid]]}
     :get {:summary    "Get audit log for a project"
           :middleware [[pra/wrap-reader-required get-project-id-from-audit-path]]
           :parameters {:query pagination-query}
           :handler    (fn [{{{:keys [project-id]} :path {:keys [start-time end-time] :as query} :query} :parameters db :db}]
                         (pagination/list-response
                          query
                          (fn [opts] (audit/get-project-audit-log db project-id start-time end-time opts))))}}]

   ["/documents/:document-id/audit"
    {:parameters {:path [:map [:document-id :uuid]]}
     :get {:summary    "Get audit log for a document"
           :middleware [[pra/wrap-reader-required get-project-id-from-document]]
           :parameters {:query pagination-query}
           :handler    (fn [{{{:keys [document-id]} :path {:keys [start-time end-time] :as query} :query} :parameters db :db}]
                         (pagination/list-response
                          query
                          (fn [opts] (audit/get-document-audit-log db document-id start-time end-time opts))))}}]

   ["/users/:user-id/audit"
    {:parameters {:path [:map [:user-id string?]]}
     :get        {:summary    "Get audit log for a user's actions"
                  :middleware [[pra/wrap-admin-required]]  ; Only admins can view other users' audit logs
                  :parameters {:query pagination-query}
                  :handler    (fn [{{{:keys [user-id]} :path {:keys [start-time end-time] :as query} :query} :parameters db :db}]
                                (pagination/list-response
                                 query
                                 (fn [opts] (audit/get-user-audit-log db user-id start-time end-time opts))))}}]])
