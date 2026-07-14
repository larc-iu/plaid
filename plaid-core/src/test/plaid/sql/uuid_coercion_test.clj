(ns plaid.sql.uuid-coercion-test
  (:require [clojure.test :refer [deftest is use-fixtures]]
            [plaid.fixtures :refer [db with-clean-db with-db]]
            [plaid.sql.common :as psc]
            [plaid.sql.metadata :as metadata]
            [plaid.sql.service-registry :as service-registry]
            [plaid.sql.user :as user]))

(use-fixtures :once with-db)
(use-fixtures :each with-clean-db)

(def uuid-text "550e8400-e29b-41d4-a716-446655440000")

(deftest uuid-coercion-follows-column-semantics-not-value-shape
  (let [project-id (psc/new-uuid)
        now (psc/now-iso)]
    (psc/execute! db {:insert-into :users
                      :values [{:id uuid-text
                                :username uuid-text
                                :password_hash "test-hash"
                                :password_changes 0
                                :is_admin 0}]})
    (psc/execute! db {:insert-into :projects
                      :values [{:id project-id :name uuid-text}]})
    (psc/execute! db {:insert-into :seen_services
                      :values [{:project_id project-id
                                :service_id uuid-text
                                :service_name uuid-text
                                :description uuid-text
                                :first_seen_at now
                                :last_seen_at now}]})
    (psc/execute! db {:insert-into :entity_metadata
                      :values [{:entity_type "project"
                                :entity_id project-id
                                :key uuid-text
                                :value "true"}]})

    (is (= uuid-text (:user/id (user/get db uuid-text))))
    (is (= uuid-text (:user/username (user/get db uuid-text))))
    (let [seen (first (service-registry/list-seen db project-id))]
      (is (= uuid-text (:service-id seen)))
      (is (= uuid-text (:service-name seen)))
      (is (= uuid-text (:description seen))))
    (is (= {uuid-text true}
           (metadata/get-metadata db "project" project-id)))
    (is (= project-id
           (:pid (psc/q1 db {:select [[:id :pid]]
                             :from [:projects]
                             :where [:= :id project-id]}
                         {:uuid-cols #{:pid}}))))))
