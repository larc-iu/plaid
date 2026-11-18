(ns plaid.rest-api.v1.operation-group
  "REST surface for logical-operation groups. There is deliberately no POST:
  a group row is created lazily by the first write that carries
  `?group-id=<uuid>&group-message=<text>` (see
  `plaid.rest-api.v1.middleware/wrap-operation-group`). The only thing a
  client does here is refine the label once the operation has finished."
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.sql.common :as psc]
            [plaid.sql.operation-group :as og]
            [plaid.sql.user :as user]))

(defn- group-projects
  "The projects the operations of group `id` were filed under."
  [db id]
  (map :project_id (psc/q db {:select-distinct [:project_id] :from [:operations]
                              :where [:and [:= :group_id (str id)] [:<> :project_id nil]]})))

(defn- wrap-owner-or-admin
  "The group's creator (the user whose write first stamped the id) or a
  global admin may read or relabel it. The creator only while they still
  read (to read) or write (to relabel) every project its operations were
  filed under: a relabel changes what those projects' History says, so a
  person removed or lowered to reader there may not (ACL8-2, ACL10-1).
  An unknown id is a 404 to an admin and to anyone else the 403 a real
  group of another person gets, with `unresolved` (ACL8-3, ACL10-4)."
  [handler]
  (fn [{{{:keys [id]} :path} :parameters db :db method :request-method :as request}]
    (let [group (og/get db id)
          admin? (user/admin? (:user/record request))
          refusal (if (= :get method)
                    "You can only read your own operation groups."
                    "You can only relabel your own operation groups.")]
      (cond
        (and (nil? group) admin?)
        {:status 404 :body {:error "Operation group not found"}}

        (nil? group)
        {:status 403 :body {:error refusal :unresolved true}}

        (not (or admin? (= (:operation-group/user group) (pra/->user-id request))))
        {:status 403 :body {:error refusal}}

        (and (not admin?)
             (not-every? #(pra/privileged? request (if (= :get method) :project/readers :project/writers)
                                           (constantly %))
                         (group-projects db id)))
        {:status 403 :body {:error (if (= :get method)
                                     "You no longer read every project this group's writes are in."
                                     "You no longer write in every project this group's writes are in.")}}

        :else
        (handler (cond-> (assoc request :operation-group group)
                   ;; For a scoped token, `pra/operation-group-token-scope`
                   ;; asks whether this token created the group.
                   (:auth/token-scope request)
                   (assoc :operation-group/token-key (og/scoped-token db id))))))))

(def operation-group-routes
  ["/operation-groups/:id"
   {:openapi {:security [{:auth []}]}
    :parameters {:path [:map [:id :uuid]]}
    :middleware [pra/wrap-login-required wrap-owner-or-admin]
    :plaid/token-scope pra/operation-group-token-scope}
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
