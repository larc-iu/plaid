(ns plaid.sql.missing-entity-routing-test
  "Regression for #60: existence checks that throw OUTSIDE the
  `submit-operation!` macro bypass the outer try/catch in
  `submit-operation*` (task #47), surfacing as raw 500 to the client
  instead of the structured `{:success false :code 404}` map.

  Picks one site (token/delete) as the canonical exemplar — every other
  site in the task list shares the exact same shape.

  Before the fix, calling `token/delete` with a non-existent UUID threw
  ExceptionInfo straight out of the function (no `:success` key, no
  `:code` key on the return). After the fix the existence check fires
  INSIDE the body, so the outer catch projects it to a structured map."
  (:require [clojure.test :refer :all]
            [plaid.sql.common :as psc]
            [plaid.sql.token :as token]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    with-admin with-clean-db]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(deftest token-delete-missing-id-returns-404-map
  (let [bogus-id (psc/new-uuid)
        result (token/delete db bogus-id "admin@example.com")]
    (is (map? result)
        "must return a structured result map, not throw uncaught")
    (is (false? (:success result)))
    (is (= 404 (:code result))
        (str "expected :code 404, got " (:code result) " — "
             "validation likely throws outside submit-operation! again"))))
