(ns plaid.sql.service-registry
  "Persistent \"seen services\" registry: one row per (project, service-id)
  ever registered, so discovery can show offline services alongside live ones.

  All writes here are deliberately UNAUDITED (not routed through
  `submit-operation!`) — they fire on every service channel open/close, which
  is operational bookkeeping, not annotation data (same rationale as
  `plaid.sql.api-token/touch-last-used!`). Rows are upserted on registration
  and removable via the discard endpoint; project deletion cascades them away
  (FK ON DELETE CASCADE)."
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
