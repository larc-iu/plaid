(ns plaid.rest-api.v1.audit
  (:require [plaid.rest-api.v1.auth :as pra]
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

;; Pagination query schema: shared by all three audit endpoints. `:limit`
;; is bounded by `audit/max-limit` (see plaid.sql.audit) to keep a single
;; request's result set bounded. `:cursor` is the `:op/id` (= operations.id)
;; UUID of the last row from the previous page.
(def ^:private pagination-query
  [:map
   [:start-time {:optional true} inst?]
   [:end-time {:optional true} inst?]
   [:limit {:optional true} [:int {:min 1 :max audit/max-limit}]]
   [:cursor {:optional true} :uuid]])

(defn- ->opts [query]
  (-> {}
      (cond-> (:limit query)  (assoc :limit (:limit query)))
      (cond-> (:cursor query) (assoc :cursor (:cursor query)))))

(def audit-routes
  [["/projects/:project-id/audit"
    {:parameters {:path [:map [:project-id :uuid]]}
     :get {:summary    "Get audit log for a project"
           :middleware [[pra/wrap-reader-required get-project-id-from-audit-path]]
           :parameters {:query pagination-query}
           :handler    (fn [{{{:keys [project-id]} :path {:keys [start-time end-time] :as query} :query} :parameters db :db}]
                         (let [result (audit/get-project-audit-log db project-id start-time end-time (->opts query))]
                           {:status 200 :body result}))}}]

   ["/documents/:document-id/audit"
    {:parameters {:path [:map [:document-id :uuid]]}
     :get {:summary    "Get audit log for a document"
           :middleware [[pra/wrap-reader-required get-project-id-from-document]]
           :parameters {:query pagination-query}
           :handler    (fn [{{{:keys [document-id]} :path {:keys [start-time end-time] :as query} :query} :parameters db :db}]
                         (let [result (audit/get-document-audit-log db document-id start-time end-time (->opts query))]
                           {:status 200 :body result}))}}]

   ["/users/:user-id/audit"
    {:parameters {:path [:map [:user-id string?]]}
     :get        {:summary    "Get audit log for a user's actions"
                  :middleware [[pra/wrap-admin-required]]  ; Only admins can view other users' audit logs
                  :parameters {:query pagination-query}
                  :handler    (fn [{{{:keys [user-id]} :path {:keys [start-time end-time] :as query} :query} :parameters db :db}]
                                (let [result (audit/get-user-audit-log db user-id start-time end-time (->opts query))]
                                  {:status 200 :body result}))}}]])
