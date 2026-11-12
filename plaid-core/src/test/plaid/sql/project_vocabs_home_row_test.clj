(ns plaid.sql.project-vocabs-home-row-test
  "The invariant every reader of \"the vocabularies of a project\" leans on:
  for every vocabulary of a live project, the row (its home, its id) is in
  `project_vocabs`. Checked after create, move, an attempt to unlink the
  home, a borrower's unlink and a borrower's delete."
  (:require [clojure.test :refer [deftest is use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db with-rest-handler
                                            with-admin api-call admin-request]]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :as h :refer [id]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- call [who method path & [body]]
  (api-call who (cond-> {:method method :path path} (some? body) (assoc :body body))))

(defn- missing-home-rows []
  (psc/q fix/db [(str "SELECT v.id FROM vocab_layers v JOIN projects p ON p.id = v.project_id "
                      "WHERE p.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM project_vocabs pv "
                      "WHERE pv.project_id = v.project_id AND pv.vocab_layer_id = v.id)")]))

(deftest the-home-row-is-always-there
  (let [a (h/create-test-project admin-request "A")
        b (h/create-test-project admin-request "B")
        c (h/create-test-project admin-request "C")
        v (id (call admin-request :post "/api/v1/vocab-layers" {:name "V" :project-id a}))
        w (id (call admin-request :post "/api/v1/vocab-layers" {:name "W" :project-id b}))]
    (is (empty? (missing-home-rows)) "after create")
    (fix/assert-no-content (h/link-vocab-to-project admin-request b v))
    (fix/assert-no-content (h/link-vocab-to-project admin-request c v))
    (is (= 409 (:status (call admin-request :delete (str "/api/v1/projects/" a "/vocabs/" v)))))
    (is (empty? (missing-home-rows)) "after an attempt to unlink the home")
    (fix/assert-ok (call admin-request :post (str "/api/v1/vocab-layers/" v "/move") {:project-id c}))
    (is (empty? (missing-home-rows)) "after a move to a borrower")
    (fix/assert-ok (call admin-request :post (str "/api/v1/vocab-layers/" w "/move") {:project-id c}))
    (is (empty? (missing-home-rows)) "after a move to a project that did not link it")
    (fix/assert-no-content (call admin-request :delete (str "/api/v1/projects/" b "/vocabs/" v)))
    (is (empty? (missing-home-rows)) "after a borrower's unlink")
    (fix/assert-no-content (call admin-request :delete (str "/api/v1/projects/" a "/vocabs/" v)))
    (fix/assert-no-content (call admin-request :delete (str "/api/v1/projects/" b "/vocabs/" w)))
    (fix/assert-no-content (call admin-request :delete (str "/api/v1/projects/" a)))
    (is (empty? (missing-home-rows)) "after a borrower's delete")
    (is (= 2 (count (psc/q fix/db {:select [:id] :from [:vocab_layers] :where [:= :project_id c]}))))))
