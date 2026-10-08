(ns plaid.rest-api.v1.layer-constraints
  "The layer constraint routes under a token, span or relation layer, and the
  middleware that puts a constraint refusal's violations on the answer."
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.layer-constraints :as slc]
            [plaid.sql.user :as user]))

(defn wrap-constraint-refusal
  "Put the violations of a write refused by a layer constraint on its answer.

  An operation refused at the end of its transaction notes the violations in
  `psaw/*refusal*`, bound here per request. Route handlers build their error
  answers from the operation's result in many ways, so the violations are
  added here, once, to whatever failed answer comes back, which is then a
  422. A batch's sub-requests pass through the router, so a refused sub-op
  carries them too."
  [handler]
  (fn [request]
    (let [refusal (atom nil)
          response (binding [psaw/*refusal* refusal] (handler request))]
      (if-let [{:keys [violations violation-count]} @refusal]
        (if (and (map? response) (>= (or (:status response) 0) 400))
          (-> response
              (assoc :status 422)
              (update :body #(merge (if (map? %) % {})
                                    {:violations violations :violation-count violation-count})))
          response)
        response))))

(defn- document-refusal
  "The answer to a repair naming a document it may not touch, or nil. An
  unknown id is a 403 with `unresolved`, and a document of another project a
  403, so a non-member learns nothing of either (the core ruling on unknown
  ids). An admin is told plainly: 404 and 400."
  [{:keys [kind id-of request db document]}]
  (let [admin? (user/admin? (:user/record request))]
    (case (slc/document-standing db kind (id-of request) document)
      :unknown (if admin?
                 {:status 404 :body {:error "Document not found"}}
                 {:status 403 :body {:error (str "User " (pra/->user-id request)
                                                 " lacks sufficient privileges to repair document "
                                                 document)
                                     :unresolved true}})
      :elsewhere (if admin?
                   {:status 400 :body {:error (str "Document " document " is not in this layer's project.")}}
                   {:status 403 :body {:error (str "User " (pra/->user-id request)
                                                   " lacks sufficient privileges to repair document "
                                                   document)}})
      nil)))

(defn- failure [{:keys [code error error-body]}]
  {:status (or code 500)
   :body (merge {:error (or error "Internal server error")} error-body)})

(def ^:private changed
  {:status 409
   :body {:error "This namespace's constraints on the layer changed since they were read."
          :constraints-changed true}})

(def ^:private constraint-list
  [:sequential [:map-of [:or :keyword :string] any?]])

(defn constraint-routes
  "The four routes on one layer of `kind` (:token, :span or :relation).
  `id-key` is the layer's path parameter and `project-fn` resolves the
  project the maintainer gate checks."
  [kind id-key project-fn]
  (let [maintainer [[pra/wrap-maintainer-required project-fn]]
        writer [[pra/wrap-writer-required project-fn]]
        id-of (fn [request] (get-in request [:parameters :path id-key]))]
    ["/constraints"
     ["/check"
      {:conflicting true
       :post {:summary (str "List the violations the given constraints would meet in this layer's stored data. "
                            "Writes nothing. Body {constraints}. Answers {violations, violation-count}.")
              :middleware maintainer
              :parameters {:body [:map [:constraints constraint-list]]}
              :handler (fn [{{{:keys [constraints]} :body} :parameters db :db :as request}]
                         (try
                           {:status 200 :body (slc/check-constraints db kind (id-of request) constraints)}
                           (catch clojure.lang.ExceptionInfo e
                             (if-let [code (:code (ex-data e))]
                               {:status code :body {:error (ex-message e)}}
                               (throw e)))))}}]
     ["/repair"
      {:conflicting true
       :post {:summary (str "Apply the remedies of the given constraints' remediable types (coextensive, "
                            "single-span, single-link, same-ancestor) to every violation in this layer's stored "
                            "data, one operation per document. Body {constraints, document?}. With document, only "
                            "that document is repaired, and a writer may ask. Without it, maintainers only. A "
                            "document another user holds the lock on is left as it is and listed under locked, "
                            "as {document, locked-by}. Answers {repaired, locked, violations, violation-count}, "
                            "the violations being those left: of types with no remedy, and in documents left.")
              :middleware writer
              :parameters {:body [:map
                                  [:constraints constraint-list]
                                  [:document {:optional true} :uuid]]}
              :handler (fn [{{{:keys [constraints document]} :body} :parameters db :db user-id :user/id :as request}]
                         (cond
                           (and (nil? document) (not (pra/privileged? request :project/maintainers project-fn)))
                           {:status 403 :body {:error "Repairing a whole layer requires maintainer privileges."}}

                           (and (nil? document) (:auth/token-scope request))
                           pra/project-admin-refusal

                           :else
                           (or (and document (document-refusal {:kind kind :id-of id-of :request request
                                                                :db db :document document}))
                               (let [result (slc/repair-constraints db kind (id-of request) constraints user-id
                                                                    :document document)]
                                 (if (:success result)
                                   {:status 200 :body (:extra result)}
                                   (failure result))))))}}]
     ["/:namespace"
      {:conflicting true
       :parameters {:path [:map [:namespace string?]]}
       :put {:summary (str "Declare the constraints of an app's namespace on this layer, replacing that namespace's "
                           "list. Body {constraints, expected?}. With expected (null for absent) the write answers "
                           "409 with constraints-changed when the stored list differs. A list that the layer's "
                           "stored data breaks is refused with 422 and its violations. Answers the layer's whole "
                           "constraint map.")
             :middleware maintainer
             :parameters {:body [:map
                                 [:constraints constraint-list]
                                 [:expected {:optional true} [:maybe constraint-list]]]}
             :handler (fn [{{{:keys [namespace]} :path body :body} :parameters db :db user-id :user/id :as request}]
                        (let [check (when (contains? body :expected) {:expected (:expected body)})
                              result (slc/set-constraints db kind (id-of request) namespace
                                                          (:constraints body) check user-id)]
                          (cond
                            (slc/changed-result? result) changed
                            (:success result) {:status 200 :body {:constraints (:extra result)}}
                            :else (failure result))))}
       :delete {:summary (str "Remove an app's namespace of constraints from this layer. Optional body {expected}, "
                              "as on PUT.")
                :middleware maintainer
                :parameters {:body [:maybe [:map [:expected {:optional true} [:maybe constraint-list]]]]}
                :handler (fn [{{{:keys [namespace]} :path body :body} :parameters db :db user-id :user/id :as request}]
                           (let [check (when (and (map? body) (contains? body :expected)) {:expected (:expected body)})
                                 result (slc/delete-constraints db kind (id-of request) namespace check user-id)]
                             (cond
                               (slc/changed-result? result) changed
                               (:success result) {:status 204}
                               :else (failure result))))}}]]))
