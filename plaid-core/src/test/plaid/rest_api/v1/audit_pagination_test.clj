(ns plaid.rest-api.v1.audit-pagination-test
  "GET /projects/:id/audit (and the document/user variants) always return the
  uniform paginated envelope `{:entries [...] :next-cursor <opaque-or-nil>}`.
  Default page size is 100, max 1000. `:next-cursor` is an opaque token the
  caller round-trips verbatim as `?cursor=` to fetch the next page; it is nil
  once the final (short) page is reached."
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

(defn- walk-all
  "Page through the project audit log via `:next-cursor`, returning the
  concatenated entries. Bounded so a cursor bug can't loop forever."
  [proj limit]
  (loop [cursor nil acc [] guard 0]
    (let [q (cond-> {:limit limit} cursor (assoc :cursor cursor))
          r (get-project-audit admin-request proj q)
          _ (assert-ok r)
          {:keys [entries next-cursor]} (:body r)
          acc' (into acc entries)]
      (if (and next-cursor (< guard 100))
        (recur next-cursor acc' (inc guard))
        acc'))))

(deftest paginated-audit-fetch
  (let [proj (create-test-project admin-request "AuditPaginationProj")
        ;; Project create + initial machinery already produces a handful
        ;; of audit rows; create-many-ops! brings the total well above 150.
        _ (create-many-ops! proj 150)
        page1 (get-project-audit admin-request proj {:limit 50})
        _ (assert-ok page1)
        {entries1 :entries cursor1 :next-cursor} (:body page1)]

    (testing "Response is always the {:entries :next-cursor} envelope"
      (let [r (get-project-audit admin-request proj)
            body (:body r)]
        (assert-ok r)
        (is (map? body) "response is the paginated envelope, not a bare array")
        (is (contains? body :entries))
        (is (contains? body :next-cursor))))

    (testing "Default page caps at 100 and exposes a next-cursor"
      (let [body (:body (get-project-audit admin-request proj))]
        (is (= 100 (count (:entries body)))
            "default page size is 100")
        (is (some? (:next-cursor body))
            "next-cursor present when more rows remain")))

    (testing "First page respects ?limit and exposes an opaque next-cursor"
      (is (= 50 (count entries1)))
      (is (string? cursor1) "next-cursor is an opaque string token"))

    (testing "Second page picks up strictly after ?cursor, no overlap"
      (let [page2 (get-project-audit admin-request proj {:limit 50 :cursor cursor1})
            _ (assert-ok page2)
            entries2 (:entries (:body page2))
            ids1 (set (map :audit/id entries1))
            ids2 (set (map :audit/id entries2))]
        (is (= 50 (count entries2)) "Second page should also be full")
        (is (empty? (clojure.set/intersection ids1 ids2))
            "Cursor pagination must not duplicate rows across pages")))

    (testing "Walking every page reassembles the full log with no gaps/dupes"
      (let [all-ids (map :audit/id (walk-all proj 40))]
        (is (= (count all-ids) (count (distinct all-ids)))
            "no duplicates across the full walk")
        (is (> (count all-ids) 150)
            "reassembled set covers every op")))))

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
      (is (= 400 (raw-status (str base "?limit=0")))))
    (testing "a malformed cursor yields a clean 400, not a 500"
      (is (= 400 (raw-status (str base "?cursor=not-a-real-cursor!!!")))))))
