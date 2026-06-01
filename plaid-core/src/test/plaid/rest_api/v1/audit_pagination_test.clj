(ns plaid.rest-api.v1.audit-pagination-test
  "GET /projects/:id/audit returns a BARE array by default (pagination
  deferred), but still honours the optional `?limit=` + `?cursor=` escape
  hatch for callers paging a large log. The cursor is the `:audit/id` of
  the last entry from the previous page; there is no `:next-cursor`
  envelope field anymore — the caller derives it from the array tail."
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
        entries1 (:body page1)
        ;; cursor for the next page = id of the last entry on this page
        cursor1 (:audit/id (last entries1))]

    (testing "Default (no limit) returns the FULL log as a bare array"
      (let [r (get-project-audit admin-request proj)
            body (:body r)]
        (assert-ok r)
        (is (sequential? body) "default response is a bare array, not an envelope")
        (is (> (count body) 50)
            "with no limit the full set (>150) comes back, not a 100-capped page")))

    (testing "First page respects ?limit"
      (is (= 50 (count entries1))
          (str "Expected exactly 50 entries, got " (count entries1)))
      (is (some? cursor1)))

    (testing "Second page picks up strictly after ?cursor"
      (let [page2 (get-project-audit admin-request proj {:limit 50 :cursor cursor1})
            _ (assert-ok page2)
            entries2 (:body page2)
            ids1 (set (map :audit/id entries1))
            ids2 (set (map :audit/id entries2))]
        (is (= 50 (count entries2)) "Second page should also be full")
        (is (empty? (clojure.set/intersection ids1 ids2))
            "Cursor pagination must not duplicate rows across pages")))))

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
