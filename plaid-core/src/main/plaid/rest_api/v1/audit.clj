(ns plaid.rest-api.v1.audit
  (:require [clojure.string]
            [plaid.rest-api.v1.auth :as pra]
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

;; `?op-types=` takes a comma-separated list of the SAME `entity/verb`
;; strings the response spells in `op/type` (e.g. `span-layer/create`), so a
;; caller can copy a value straight out of a previous read. Values are shape-
;; checked rather than checked against a registry of known types: there is no
;; central enum of op types to check against, but the shape check does catch
;; the one confusion worth catching — the SSE audit-log stream spells the
;; same operation `span_layer:create` (snake_case, colon), and pasting that
;; here would otherwise silently match nothing.
(def ^:private op-type-pattern #"[a-z][a-z0-9-]*/[a-z][a-z0-9-]*")

(def ^:private op-types-doc
  (str "Pass ?op-types= with a comma-separated list of op types "
       "(e.g. span-layer/create,span-layer/delete) to return only matching "
       "operations, spelled exactly as an entry's op/type. Filtering applies "
       "to individual operations, like the time window does: an entry appears "
       "when one of its operations matches, carrying only the operations that "
       "did."))

(defn- parse-op-types
  "Split the comma-separated `?op-types=` value. Returns `{:op-types [...]}`
  (nil op-types meaning no filter) or `{:invalid \"bad-token\"}`, so the
  handler can 400 rather than quietly return an empty page."
  [raw]
  (if-let [raw (not-empty (some-> raw clojure.string/trim))]
    (let [tokens (->> (clojure.string/split raw #",")
                      (map clojure.string/trim)
                      (remove empty?)
                      distinct
                      vec)]
      (if-let [bad (first (remove #(re-matches op-type-pattern %) tokens))]
        {:invalid bad}
        {:op-types (not-empty tokens)}))
    {:op-types nil}))

;; Pagination query schema: shared by all three audit endpoints. The audit
;; log is always paginated into the uniform `{:entries :next-cursor}`
;; envelope (default page 100, max 1000); `:cursor` is the opaque token from
;; the previous page's `:next-cursor`. Adds the audit-only time-window
;; params on top of the shared `?limit`/`?cursor`.
(def ^:private pagination-query
  (into [:map
         [:start-time {:optional true} inst?]
         [:end-time {:optional true} inst?]
         [:op-types {:optional true} string?]]
        pagination/query-params))

(defn- audit-response
  "Shared handler body: parse `?op-types=`, then page. A malformed op type is
  a 400 — silently returning nothing would look like 'no such activity'."
  [{:keys [start-time end-time op-types] :as query} fetch]
  (let [{:keys [invalid] parsed :op-types} (parse-op-types op-types)]
    (if invalid
      {:status 400
       :body {:error (str "Invalid op type " (pr-str invalid)
                          ". Op types are spelled entity/verb, e.g. span-layer/create"
                          " — exactly as they appear in an entry's op/type.")}}
      (pagination/list-response
       query
       (fn [opts] (fetch (assoc opts :op-types parsed) start-time end-time))))))

(def ^:private tally-query
  [:map
   [:start-time {:optional true} inst?]
   [:end-time {:optional true} inst?]
   [:daily {:optional true} boolean?]])

(def ^:private tally-doc
  (str "Per-user activity counts. <code>changes</code> is the number of "
       "logical actions, folded the same way the audit feed folds them, so a "
       "single \"Confirm word analysis\" counts once however many rows it "
       "wrote; <code>operations</code> is the unfolded row count. "
       "<code>documents</code> counts distinct documents touched. Only users "
       "who did something appear — subtract from the roster you already hold "
       "to find the ones who did not. Pass <code>?daily=true</code> to add "
       "<code>by-day</code>, an ISO-date to change-count map, at the cost of "
       "a second grouped scan. Not paginated: the row count is the number of "
       "people, not the number of operations."))

(def audit-routes
  [["/projects/:project-id/audit"
    {:parameters {:path [:map [:project-id :uuid]]}
     :get {:summary    (str "Get audit log for a project. " op-types-doc)
           :middleware [[pra/wrap-reader-required get-project-id-from-audit-path]]
           :parameters {:query pagination-query}
           :handler    (fn [{{{:keys [project-id]} :path query :query} :parameters db :db}]
                         (audit-response
                          query
                          (fn [opts start end] (audit/get-project-audit-log db project-id start end opts))))}}]

   ["/projects/:project-id/audit/last-edits"
    {:parameters {:path [:map [:project-id :uuid]]}
     :get {:summary    (str "When the calling user last wrote to each document in a project, as a "
                            "<code>{document-id: timestamp}</code> map. Documents they have never "
                            "written to are absent. One cheap request marks up a whole document "
                            "list without asking per document.")
           :middleware [[pra/wrap-reader-required get-project-id-from-audit-path]]
           :handler    (fn [{{{:keys [project-id]} :path} :parameters db :db user-id :user/id}]
                         {:status 200
                          :body (audit/last-edits-in-project db project-id user-id)})}}]

   ["/documents/:document-id/audit"
    {:parameters {:path [:map [:document-id :uuid]]}
     :get {:summary    (str "Get audit log for a document. " op-types-doc)
           :middleware [[pra/wrap-reader-required get-project-id-from-document]]
           :parameters {:query pagination-query}
           :handler    (fn [{{{:keys [document-id]} :path query :query} :parameters db :db}]
                         (audit-response
                          query
                          (fn [opts start end] (audit/get-document-audit-log db document-id start end opts))))}}]

   ["/users/:user-id/audit"
    {:parameters {:path [:map [:user-id string?]]}
     :get        {:summary    (str "Get audit log for a user's actions. " op-types-doc)
                  :middleware [[pra/wrap-admin-required]]  ; Only admins can view other users' audit logs
                  :parameters {:query pagination-query}
                  :handler    (fn [{{{:keys [user-id]} :path query :query} :parameters db :db}]
                                (audit-response
                                 query
                                 (fn [opts start end] (audit/get-user-audit-log db user-id start end opts))))}}]

   ["/projects/:project-id/audit/tally"
    {:parameters {:path [:map [:project-id :uuid]]}
     :get {:summary    (str "Per-user activity in a project. " tally-doc)
           :middleware [[pra/wrap-maintainer-required get-project-id-from-audit-path]]
           :parameters {:query tally-query}
           :handler    (fn [{{{:keys [project-id]} :path {:keys [start-time end-time daily]} :query} :parameters db :db}]
                         {:status 200
                          :body   {:entries (audit/activity-tally db {:project-id  project-id
                                                                      :start-time  start-time
                                                                      :end-time    end-time
                                                                      :daily?      daily})}})}}]

   ["/audit"
    {:get {:summary    (str "Get the audit log across every project. Admin only. " op-types-doc)
           :middleware [[pra/wrap-admin-required]]
           :parameters {:query pagination-query}
           :handler    (fn [{{query :query} :parameters db :db}]
                         (audit-response
                          query
                          (fn [opts start end] (audit/get-audit-log db start end opts))))}}]

   ["/audit/tally"
    {:get {:summary    (str "Per-user activity across every project. Admin only. " tally-doc)
           :middleware [[pra/wrap-admin-required]]
           :parameters {:query tally-query}
           :handler    (fn [{{{:keys [start-time end-time daily]} :query} :parameters db :db}]
                         {:status 200
                          :body   {:entries (audit/activity-tally db {:start-time start-time
                                                                      :end-time   end-time
                                                                      :daily?     daily})}})}}]])
