(ns plaid.rest-api.v1.layer-constraints
  "The layer constraint routes under a token, span or relation layer, and the
  middleware that puts a constraint refusal's violations on the answer."
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.layer-constraints :as slc]))

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
                            "data, one operation per document. Body {constraints}. Answers {repaired, violations, "
                            "violation-count}, the violations being those of types with no remedy.")
              :middleware maintainer
              :parameters {:body [:map [:constraints constraint-list]]}
              :handler (fn [{{{:keys [constraints]} :body} :parameters db :db user-id :user/id :as request}]
                         (let [result (slc/repair-constraints db kind (id-of request) constraints user-id)]
                           (if (:success result)
                             {:status 200 :body (:extra result)}
                             (failure result))))}}]
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
