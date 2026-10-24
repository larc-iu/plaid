(ns plaid.sql.service-registry
  "Persistent \"seen services\" registry: one row per (project, service-id)
  ever registered, so discovery can show offline services alongside live ones.

  All writes here are deliberately UNAUDITED (not routed through
  `submit-operation!`) — they fire on every service channel open/close, which
  is operational bookkeeping, not annotation data. Rows are upserted on registration
  and removable via the discard endpoint; project deletion cascades them away
  (FK ON DELETE CASCADE).

  Beside them, `service_claims` holds who each service id on a project
  belongs to: the account that first opened a channel for it (ruling R10).
  Forgetting a seen row leaves the claim. An admin's release drops it, and so
  does deactivating the account that holds it."
  (:require [clojure.data.json :as json]
            [plaid.sql.common :as psc]))

(defn record-seen!
  "Upsert the (project, service) row on registration. `extras-json` is the RAW
  JSON string exactly as the service sent it on the query string — stored
  verbatim so the parsed shape at read time is identical to the live entry's
  (re-serializing a keywordized map could alter the wire shape)."
  [db project-id service-id {:keys [service-name description extras-json]}]
  (let [now (psc/now-iso)]
    (psc/execute! db {:insert-into :seen_services
                      :values [{:project_id project-id
                                :service_id service-id
                                :service_name service-name
                                :description description
                                :extras extras-json
                                :first_seen_at now
                                :last_seen_at now}]
                      :on-conflict [:project_id :service_id]
                      :do-update-set [:service_name :description :extras :last_seen_at]})))

(defn touch-last-seen!
  "Bump `last_seen_at` — called when a service's channel closes, so the stored
  time means \"last seen alive\", not \"first connected\"."
  [db project-id service-id]
  (psc/execute! db {:update :seen_services
                    :set {:last_seen_at (psc/now-iso)}
                    :where [:and
                            [:= :project_id project-id]
                            [:= :service_id service-id]]}))

(defn- parse-extras [s]
  (when s
    (try (json/read-str s :key-fn keyword)
         (catch Exception _ nil))))

(defn list-seen
  "All previously-seen services on a project as public metadata maps
  {:service-id :service-name :description :extras :last-seen-at}, ordered by
  service-id. Extras parse to the same keywordized shape live entries carry."
  [db project-id]
  (->> (psc/q db {:select [:service_id :service_name :description :extras :last_seen_at]
                  :from :seen_services
                  :where [:= :project_id project-id]
                  :order-by [:service_id]})
       (mapv (fn [row]
               {:service-id (:service_id row)
                :service-name (:service_name row)
                :description (:description row)
                :extras (parse-extras (:extras row))
                :last-seen-at (:last_seen_at row)}))))

(defn delete-seen!
  "Forget a previously-seen service. Returns the number of rows deleted (0 or 1)."
  [db project-id service-id]
  (psc/execute! db {:delete-from :seen_services
                    :where [:and
                            [:= :project_id project-id]
                            [:= :service_id service-id]]}))

(defn- claim-holder [db project-id service-id]
  (:user_id (psc/q1 db {:select [:user_id]
                        :from :service_claims
                        :where [:and
                                [:= :project_id project-id]
                                [:= :service_id service-id]]})))

(defn claim!
  "Claim `service-id` on the project for `user-id` unless an account holds it
  already, and answer the account that holds it now: `user-id` when the claim
  was taken or was theirs, another account's id otherwise. A held claim is
  only read, since every channel open claims and an INSERT takes SQLite's
  write lock even when it inserts nothing. A missing one is inserted with ON
  CONFLICT DO NOTHING and read again, so two first registrations racing each
  other cannot both win. Unaudited, as the seen rows are."
  [db project-id service-id user-id]
  (or (claim-holder db project-id service-id)
      (do (psc/execute! db {:insert-into :service_claims
                            :values [{:project_id project-id
                                      :service_id service-id
                                      :user_id user-id
                                      :claimed_at (psc/now-iso)}]
                            :on-conflict [:project_id :service_id]
                            :do-nothing []})
          (claim-holder db project-id service-id))))

(defn release!
  "Drop the claim on `service-id`, so the next account to open a channel for
  it claims it. Returns the number of rows deleted (0 or 1)."
  [db project-id service-id]
  (psc/execute! db {:delete-from :service_claims
                    :where [:and
                            [:= :project_id project-id]
                            [:= :service_id service-id]]}))

(defn release-all-of!
  "Drop every claim `user-id` holds, on every project: a deactivated account
  runs no service, and its ids are free for the next account to register.
  Unaudited, as the claims are."
  [db user-id]
  (psc/execute! db {:delete-from :service_claims
                    :where [:= :user_id user-id]}))

(defn claims
  "Who holds each claimed service id on the project, as {service-id user-id}."
  [db project-id]
  (into {}
        (map (juxt :service_id :user_id))
        (psc/q db {:select [:service_id :user_id]
                   :from :service_claims
                   :where [:= :project_id project-id]})))
