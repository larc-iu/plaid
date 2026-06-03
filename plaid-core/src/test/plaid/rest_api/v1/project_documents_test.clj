(ns plaid.rest-api.v1.project-documents-test
  "GET /projects/:id/documents returns the uniform paginated envelope
  `{:entries [...] :next-cursor <opaque-or-nil>}`, ordered by (name, id).
  Default page size is 100, max 1000. `:next-cursor` is an opaque token the
  caller round-trips verbatim as `?cursor=` to fetch the next page; it is nil
  once the final (short) page is reached. Modelled on
  `plaid.rest-api.v1.audit-pagination-test`."
  (:require [clojure.test :refer :all]
            [clojure.string]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-rest-handler
                                            admin-request user1-request rest-handler api-call
                                            with-admin with-test-users
                                            assert-ok assert-no-content assert-forbidden with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- list-documents
  "GET /projects/:id/documents with optional {:limit :cursor} query params."
  ([user-request-fn project-id]
   (list-documents user-request-fn project-id {}))
  ([user-request-fn project-id {:keys [limit cursor]}]
   (let [qs (cond-> []
              limit  (conj (str "limit=" limit))
              cursor (conj (str "cursor=" cursor)))
         path (str "/api/v1/projects/" project-id "/documents"
                   (when (seq qs) (str "?" (clojure.string/join "&" qs))))]
     (api-call user-request-fn {:method :get :path path}))))

(defn- walk-all
  "Page through the project's documents via `:next-cursor`, returning the
  concatenated entries. Bounded so a cursor bug can't loop forever."
  [project-id limit]
  (loop [cursor nil acc [] guard 0]
    (let [r (list-documents admin-request project-id (cond-> {:limit limit}
                                                       cursor (assoc :cursor cursor)))
          _ (assert-ok r)
          {:keys [entries next-cursor]} (:body r)
          acc' (into acc entries)]
      (if (and next-cursor (< guard 100))
        (recur next-cursor acc' (inc guard))
        acc'))))

(deftest paginated-documents-fetch
  (let [proj (create-test-project admin-request "DocPaginationProj")
        ;; 7 docs with deterministic, lexicographically-orderable names.
        doc-names (mapv #(str "Doc-" %) (range 7))
        _ (doseq [n doc-names] (create-test-document admin-request proj n))]

    (testing "Default page returns the {:entries :next-cursor} envelope with all docs"
      (let [r (list-documents admin-request proj)
            body (:body r)]
        (assert-ok r)
        (is (map? body) "response is the paginated envelope, not a bare array")
        (is (contains? body :entries))
        (is (contains? body :next-cursor))
        (is (= 7 (count (:entries body))) "all 7 docs fit under the default page")
        (is (nil? (:next-cursor body)) "no next-cursor when the page is short")
        (is (= (sort doc-names) (mapv :document/name (:entries body)))
            "entries are ordered by name")))

    (testing "?limit=2 returns 2 entries plus an opaque string cursor"
      (let [r (list-documents admin-request proj {:limit 2})
            body (:body r)]
        (assert-ok r)
        (is (= 2 (count (:entries body))))
        (is (string? (:next-cursor body)) "next-cursor is an opaque string token")))

    (testing "Walking pages reassembles all docs, ordered, no dupes"
      (let [all (walk-all proj 2)
            names (mapv :document/name all)
            ids (mapv :document/id all)]
        (is (= 7 (count all)) "every document is visited exactly once")
        (is (= (count ids) (count (distinct ids))) "no duplicates across the walk")
        (is (= (sort doc-names) names) "global order is by name across pages")))))

(deftest documents-access-control
  (let [proj (create-test-project admin-request "DocAclProj")
        _ (create-test-document admin-request proj "Doc-A")]
    (testing "a non-reader gets 403"
      (assert-forbidden (list-documents user1-request proj)))
    (testing "a reader can list"
      (assert-no-content
       (api-call admin-request {:method :post
                                :path (str "/api/v1/projects/" proj "/readers/user1@example.com")}))
      (assert-ok (list-documents user1-request proj)))))

(defn- raw-status
  "Hit the rest-handler directly and return only the status code. Used to
  exercise the malli coercion / bad-cursor failure paths, whose error
  response body is a raw Clojure map (not a parseable EDN string)."
  [path]
  (:status (rest-handler (admin-request :get path))))

(deftest documents-pagination-validation
  (let [proj (create-test-project admin-request "DocPagValidationProj")
        base (str "/api/v1/projects/" proj "/documents")]
    (testing "limit > max-limit is rejected by malli coercion"
      (is (= 400 (raw-status (str base "?limit=5000")))))
    (testing "a malformed cursor yields a clean 400, not a 500"
      (is (= 400 (raw-status (str base "?cursor=garbage!!!")))))))
