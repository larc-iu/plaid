(ns plaid.rest-api.v1.operation-group
  "REST surface for logical-operation groups. There is deliberately no POST:
  a group row is created lazily by the first write that carries
  `?group-id=<uuid>&group-message=<text>` (see
  `plaid.rest-api.v1.middleware/wrap-operation-group`). The only thing a
  client does here is refine the label once the operation has finished."
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.sql.operation-group :as og]
            [plaid.sql.user :as user]))

(defn- wrap-owner-or-admin
  "The group's creator (the user whose write first stamped the id) or a
  global admin may relabel it. Unknown id → 404 (checked here so the
  ownership test has a row to look at)."
  [handler]
  (fn [{{{:keys [id]} :path} :parameters db :db :as request}]
    (let [group (og/get db id)]
      (cond
        (nil? group)
        {:status 404 :body {:error "Operation group not found"}}

        (not (or (user/admin? (:user/record request))
                 (= (:operation-group/user group) (pra/->user-id request))))
        {:status 403 :body {:error "You can only relabel your own operation groups."}}

        :else
        (handler (assoc request :operation-group group))))))

(def operation-group-routes
  ["/operation-groups/:id"
   {:openapi {:security [{:auth []}]}
    :parameters {:path [:map [:id :uuid]]}
    :middleware [pra/wrap-login-required wrap-owner-or-admin]}
   [""
    {:get {:summary "Get a logical-operation group (its label + creator)."
           :handler (fn [{group :operation-group}]
                      {:status 200 :body group})}
     :patch {:summary (str "Refine the label of a logical-operation group after the fact "
                           "(e.g. once a count is known). Groups are created lazily by the "
                           "first write carrying ?group-id=; this only relabels.")
             :parameters {:body [:map [:message [:maybe string?]]]}
             :handler (fn [{{{:keys [id]} :path {:keys [message]} :body} :parameters db :db}]
                        (if-let [g (og/set-message! db id message)]
                          {:status 200 :body g}
                          {:status 404 :body {:error "Operation group not found"}}))}}]])
