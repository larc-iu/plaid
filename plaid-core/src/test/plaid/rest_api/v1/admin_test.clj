(ns plaid.rest-api.v1.admin-test
  "The instance-operations endpoints. What matters here is less the numbers
  they report than the two contracts around them: only an admin gets in, and
  the handful of writes only ever unblock."
  (:require [clojure.string :as str]
            [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request api-call assert-ok assert-forbidden
                                    with-admin with-test-users user1-request user2-request
                                    with-clean-db]]
            [plaid.rest-api.v1.rate-limit :as rl]
            [plaid.server.locks :as locks]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- admin-get
  ([path] (admin-get admin-request path))
  ([request-fn path] (api-call request-fn {:method :get :path (str "/api/v1/admin" path)})))

(deftest server-report-describes-the-server
  (let [proj (create-test-project admin-request "AdminReportProj")
        _ (create-test-document admin-request proj "Doc")
        r (admin-get "/server")
        body (:body r)]
    (assert-ok r)

    (testing "Version, JVM, database, media, backup and settings all answer"
      (is (string? (:version body)))
      (is (pos? (:uptime-ms (:jvm body))))
      (is (string? (:java (:jvm body))))
      (is (some? (:database body)))
      (is (some? (:media body)))
      (is (some? (:backup body)))
      (is (some? (:settings body))))

    (testing "Table counts include the rows this test just wrote"
      (let [tables (:tables (:database body))]
        (is (pos? (:projects tables)))
        (is (pos? (:documents tables)))
        (is (pos? (:operations tables)))))

    (testing "No secret is in the report"
      (let [flat (pr-str body)]
        (is (not (re-find #"(?i)secret|password|jwt-secret" flat)))))))

(deftest admin-endpoints-refuse-a-non-admin
  (doseq [path ["/server" "/locks" "/rate-limits" "/logs" "/user-data"]]
    (testing (str "GET " path " is admin-only")
      (assert-forbidden (admin-get user1-request path))))
  (testing "So is taking a backup"
    (assert-forbidden (api-call user1-request {:method :post :path "/api/v1/admin/backup"}))))

(deftest locks-are-visible-and-releasable
  (let [proj (create-test-project admin-request "LockProj")
        doc (create-test-document admin-request proj "Doc")]

    (testing "Nothing held shows an empty list"
      (let [r (admin-get "/locks")]
        (assert-ok r)
        (is (= [] (:entries (:body r))))))

    (locks/acquire-lock! doc "someone-else@example.com")

    (testing "A held document shows who holds it"
      (let [entries (:entries (:body (admin-get "/locks")))]
        (is (= 1 (count entries)))
        (is (= doc (:document-id (first entries))))
        (is (= "someone-else@example.com" (:user-id (first entries))))))

    (testing "An admin can release a lock they do not hold"
      (let [r (api-call admin-request {:method :delete
                                       :path (str "/api/v1/admin/locks/" doc)})]
        (assert-ok r)
        (is (= "released" (:result (:body r))))
        (is (= [] (:entries (:body (admin-get "/locks")))))))

    (testing "Releasing again is idempotent rather than an error"
      (let [r (api-call admin-request {:method :delete
                                       :path (str "/api/v1/admin/locks/" doc)})]
        (assert-ok r)
        (is (= "not-held" (:result (:body r))))))))

(deftest rate-limit-buckets-can-be-read-and-cleared
  (testing "A quiet server reports no buckets, and the window it measures"
    (let [r (admin-get "/rate-limits")]
      (assert-ok r)
      (is (pos? (:window-ms (:body r))))
      (is (= [] (:logins (:body r))))
      (is (= [] (:ips (:body r))))))

  (let [failing (fn [] {:remote-addr "203.0.113.7"})]
    (dotimes [_ 3] (rl/record-failure! (failing) "victim@example.com"))

    (testing "Recorded failures show the address, the account and the limit"
      (let [body (:body (admin-get "/rate-limits"))
            login (first (:logins body))]
        (is (= 1 (count (:logins body))))
        (is (= "203.0.113.7" (:ip login)))
        (is (= "victim@example.com" (:user-id login)))
        (is (= 3 (:failures login)))
        (is (false? (:blocked login)) "three failures is under the limit")))

    (testing "Clearing one address forgets it"
      (let [r (api-call admin-request
                        {:method :delete
                         :path "/api/v1/admin/rate-limits?ip=203.0.113.7"})]
        (assert-ok r)
        (is (= [] (:logins (:body (admin-get "/rate-limits")))))))))

(deftest log-tail-says-so-when-there-is-no-file
  (testing "No configured log file is reported, not treated as an error"
    (let [r (admin-get "/logs")]
      (assert-ok r)
      (is (= [] (:lines (:body r))))
      (is (string? (:error (:body r)))))))

;; ============================================================
;; Private user data across accounts
;; ============================================================

(def ^:private u1 "user1@example.com")
(def ^:private u2 "user2@example.com")

(defn- put-data! [request-fn user-id key value]
  (api-call request-fn {:method :put
                        :path (str "/api/v1/users/" user-id "/data/" key)
                        :body value}))

(defn- seed-conversations!
  "The shape the assistant tab actually writes: per person and project, a
  small `meta` entry for the sidebar and a large `conv` transcript beside
  it, plus one unrelated preference key."
  []
  (put-data! user1-request u1 "igt:assistant:pA:meta:c1" {:title "Glossing help" :turns 3})
  (put-data! user1-request u1 "igt:assistant:pA:conv:c1" {:display [{:kind "user" :text "hi"}]})
  (put-data! user1-request u1 "igt:assistant:pB:meta:c2" {:title "Second project" :turns 1})
  (put-data! user1-request u1 "igt:assistant:pB:conv:c2" {:display []})
  (put-data! user1-request u1 "igt:prefs:documents:sort" {:key "name"})
  (put-data! user2-request u2 "igt:assistant:pA:meta:c3" {:title "Someone else's" :turns 9})
  (put-data! user2-request u2 "igt:assistant:pA:conv:c3" {:display []}))

(deftest user-data-lists-across-accounts
  (seed-conversations!)

  (testing "Unnarrowed: every account's entries, keys only, each naming its owner"
    (let [r (admin-get "/user-data")
          entries (:entries (:body r))]
      (assert-ok r)
      (is (= 7 (count entries)))
      (is (= #{u1 u2} (set (map :user-id entries))))
      (is (every? #(not (contains? % :value)) entries)
          "a listing stays a listing of keys until values are asked for")
      (is (every? :updated-at entries))))

  (testing "A glob reaches the segment in the middle that no prefix can"
    (let [entries (:entries (:body (admin-get (str "/user-data?pattern=igt:assistant:*:meta:*"
                                                   "&include-values=true"))))]
      (is (= ["igt:assistant:pA:meta:c1" "igt:assistant:pB:meta:c2" "igt:assistant:pA:meta:c3"]
             (mapv :key entries))
          "ordered by (user, key), so one person's conversations stay together")
      (is (= [u1 u1 u2] (mapv :user-id entries)))
      (is (= ["Glossing help" "Second project" "Someone else's"]
             (mapv #(get (:value %) "title") entries))
          "the small entry carries what a browsable index needs")
      (is (not-any? #(str/includes? (:key %) ":conv:") entries)
          "and not one transcript came along")))

  (testing "Prefix narrows as it does per user, and the two narrowings AND"
    (is (= 6 (count (:entries (:body (admin-get "/user-data?prefix=igt:assistant:")))))
        "both kinds, both people")
    (is (= ["igt:prefs:documents:sort"]
           (mapv :key (:entries (:body (admin-get "/user-data?prefix=igt:prefs:"))))))
    (is (= [["igt:assistant:pA:meta:c1" u1] ["igt:assistant:pA:meta:c3" u2]]
           (mapv (juxt :key :user-id)
                 (:entries (:body (admin-get (str "/user-data?prefix=igt:assistant:pA:"
                                                  "&pattern=igt:assistant:*:meta:*"))))))
        "that project's meta entries whoever owns them, and only where both hold")))

(deftest user-data-pages
  (seed-conversations!)
  (testing "One entry at a time, following the cursor, sees each exactly once"
    (loop [cursor nil seen [] guard 0]
      (let [entries+ (:body (admin-get (str "/user-data?pattern=igt:assistant:*:meta:*&limit=1"
                                            (when cursor (str "&cursor=" cursor)))))
            seen (into seen (map :key (:entries entries+)))]
        (cond
          (> guard 10) (is false "the cursor never ran out")
          (:next-cursor entries+) (recur (:next-cursor entries+) seen (inc guard))
          :else (is (= ["igt:assistant:pA:meta:c1" "igt:assistant:pB:meta:c2"
                        "igt:assistant:pA:meta:c3"]
                       seen))))))
  (testing "A garbled cursor is a 400, not a 500"
    (is (= 400 (:status (admin-get "/user-data?cursor=not-a-cursor"))))))

(deftest user-data-refuses-a-non-admin
  (seed-conversations!)
  (testing "A person cannot reach the cross-account listing, not even for their own entries"
    (assert-forbidden (admin-get user1-request "/user-data"))))
