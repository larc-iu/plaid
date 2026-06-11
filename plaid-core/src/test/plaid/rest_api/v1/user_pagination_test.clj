(ns plaid.rest-api.v1.user-pagination-test
  "GET /users always returns the uniform paginated envelope
  `{:entries [...] :next-cursor <opaque-or-nil>}`. Default page size 100,
  max 1000. `:next-cursor` is an opaque token round-tripped verbatim as
  `?cursor=` to fetch the next page; nil on the final (short) page."
  (:require [clojure.set]
            [clojure.string]
            [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    with-admin rest-handler admin-request
                                    api-call assert-ok with-clean-db db]]
            [plaid.sql.user :as user]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- list-users
  "GET /users with optional :limit/:cursor query params, parsed envelope."
  ([] (list-users {}))
  ([{:keys [limit cursor]}]
   (let [params (cond-> []
                  limit  (conj (str "limit=" limit))
                  cursor (conj (str "cursor=" cursor)))
         qs (when (seq params) (str "?" (clojure.string/join "&" params)))]
     (api-call admin-request {:method :get :path (str "/api/v1/users" qs)}))))

(defn- usernames [entries] (map :user/username entries))

(defn- walk-all
  "Page through GET /users via :next-cursor, returning the concatenated
  entries. Bounded so a cursor bug can't loop forever."
  [limit]
  (loop [cursor nil acc [] guard 0]
    (let [r (list-users (cond-> {:limit limit} cursor (assoc :cursor cursor)))
          _ (assert-ok r)
          {:keys [entries next-cursor]} (:body r)
          acc' (into acc entries)]
      (if (and next-cursor (< guard 100))
        (recur next-cursor acc' (inc guard))
        acc'))))

(deftest paginated-user-fetch
  ;; with-admin gives us admin@example.com; add 5 more so we have > 3 users.
  (doseq [u ["zz-aaa@example.com" "zz-bbb@example.com" "zz-ccc@example.com"
             "zz-ddd@example.com" "zz-eee@example.com"]]
    (user/create db u false "password" nil))

  (testing "Response is always the {:entries :next-cursor} envelope"
    (let [r (list-users)
          body (:body r)]
      (assert-ok r)
      (is (map? body) "response is the paginated envelope, not a bare array")
      (is (contains? body :entries))
      (is (contains? body :next-cursor))))

  (testing "?limit=2 returns exactly 2 entries + an opaque next-cursor"
    (let [r (list-users {:limit 2})
          _ (assert-ok r)
          {:keys [entries next-cursor]} (:body r)]
      (is (= 2 (count entries)) "first page respects ?limit")
      (is (string? next-cursor) "next-cursor is an opaque string token")
      (is (seq next-cursor))))

  (testing "Page 2 picks up strictly after the cursor, no overlap"
    (let [r1 (list-users {:limit 2})
          _ (assert-ok r1)
          {entries1 :entries cursor1 :next-cursor} (:body r1)
          r2 (list-users {:limit 2 :cursor cursor1})
          _ (assert-ok r2)
          entries2 (:entries (:body r2))
          names1 (set (usernames entries1))
          names2 (set (usernames entries2))]
      (is (= 2 (count entries2)))
      (is (empty? (clojure.set/intersection names1 names2))
          "cursor pagination must not duplicate rows across pages")))

  (testing "Walking every page reassembles the full roster with no dupes/gaps"
    (let [walked (usernames (walk-all 2))
          all    (usernames (:entries (:body (list-users {:limit 1000}))))]
      (is (= (count walked) (count (distinct walked)))
          "no duplicates across the full walk")
      (is (= (sort walked) (sort all))
          "walked pages reassemble exactly the full single-page roster")
      (is (>= (count walked) 6) "covers every user (admin + 5 created)"))))

(defn- raw-status
  "Hit the rest-handler directly and return only the status code. Used to
  exercise the malli coercion / cursor-decode failure paths, whose error
  response body is a raw map (not a parseable EDN string)."
  [path]
  (:status (rest-handler (admin-request :get path))))

(deftest pagination-validation
  (testing "limit > max-limit is rejected by malli coercion"
    (is (= 400 (raw-status "/api/v1/users?limit=5000"))))
  (testing "a malformed cursor yields a clean 400, not a 500"
    (is (= 400 (raw-status "/api/v1/users?cursor=garbage!!!")))))
