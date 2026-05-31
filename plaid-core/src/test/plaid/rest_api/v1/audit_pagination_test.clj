(ns plaid.rest-api.v1.audit-pagination-test
  "Regression for #85: GET /projects/:id/audit honours `?limit=` + `?cursor=`
  and surfaces a `:next-cursor` field for forward pagination."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-rest-handler
                                            admin-request rest-handler with-admin
                                            assert-ok assert-created with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- create-many-ops!
  "Generate `n` audit-producing operations under the given project.
  Each op produces a single `operations` row (text-layer create is a
  single-op write), which is what the audit endpoint paginates over."
  [proj n]
  (dotimes [i n]
    (assert-created (create-text-layer admin-request proj (str "TL-" i)))))

(deftest paginated-audit-fetch
  (let [proj (create-test-project admin-request "AuditPaginationProj")
        ;; Project create + initial machinery already produces a handful
        ;; of audit rows; create-many-ops! brings the total well above 150.
        _ (create-many-ops! proj 150)
        page1 (get-project-audit admin-request proj {:limit 50})
        _ (assert-ok page1)
        body1 (:body page1)
        entries1 (:entries body1)
        cursor1 (:next-cursor body1)]

    (testing "First page respects limit and exposes a next-cursor"
      (is (= 50 (count entries1))
          (str "Expected exactly 50 entries, got " (count entries1)))
      (is (some? cursor1) "next-cursor should be present when more results exist"))

    (testing "Second page picks up strictly after the cursor"
      (let [page2 (get-project-audit admin-request proj {:limit 50 :cursor cursor1})
            _ (assert-ok page2)
            body2 (:body page2)
            entries2 (:entries body2)
            cursor2 (:next-cursor body2)
            ids1 (set (map :audit/id entries1))
            ids2 (set (map :audit/id entries2))]
        (is (= 50 (count entries2)) "Second page should also be full")
        (is (some? cursor2) "Third page should still exist")
        (is (empty? (clojure.set/intersection ids1 ids2))
            "Cursor pagination must not duplicate rows across pages")))

    (testing "Limit > result set yields nil next-cursor"
      (let [r (get-project-audit admin-request proj {:limit 1000})
            body (:body r)]
        (assert-ok r)
        (is (nil? (:next-cursor body))
            "next-cursor must be nil when the page returns fewer than limit rows")))))

(defn- raw-status
  "Hit the rest-handler directly and return only the status code. Used to
  exercise the malli coercion failure path, whose error response body is
  a raw Clojure map (not a parseable string)."
  [path]
  (:status (rest-handler (admin-request :get path))))

(deftest pagination-validation
  (let [proj (create-test-project admin-request "AuditPagValidationProj")
        base (str "/api/v1/projects/" proj "/audit")]
    (testing "limit > max-limit is rejected by malli coercion"
      (is (= 400 (raw-status (str base "?limit=5000")))))
    (testing "limit <= 0 is rejected"
      (is (= 400 (raw-status (str base "?limit=0")))))))
