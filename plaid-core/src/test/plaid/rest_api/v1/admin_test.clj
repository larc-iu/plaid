(ns plaid.rest-api.v1.admin-test
  "The instance-operations endpoints. What matters here is less the numbers
  they report than the two contracts around them: only an admin gets in, and
  the handful of writes only ever unblock."
  (:require [clojure.string :as str]
            [clojure.test :refer :all]
            [ring.mock.request :as mock]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request api-call assert-ok assert-forbidden
                                    with-admin with-test-users user1-request user2-request
                                    with-clean-db]]
            [plaid.rest-api.v1.auth :as auth]
            [plaid.rest-api.v1.rate-limit :as rl]
            [plaid.server.locks :as locks]
            [plaid.server.log-buffer :as log-buffer]
            [plaid.test-helpers :refer :all]))

(defn- with-log-buffer
  "Tests never run `configure-logging!`, so the appender the Logs endpoint
  reads has to be put on by hand. Same appender the server installs."
  [f]
  (log-buffer/install!)
  (f))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users
  with-log-buffer)
(use-fixtures :each with-clean-db)

(defn- bad-token-request
  "A request signed with a token the server will refuse, so the JWT
  middleware logs something that is not an access line."
  [method path]
  (-> (mock/request method path)
      (mock/header "accept" "application/edn")
      (mock/header "Authorization" "Bearer not-a-token")))

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

    (testing "The lock window reported is the one the lock table enforces"
      ;; Read through `locks/lock-expiration-ms`, the same call `acquire-lock!`
      ;; and `GET /info` make. Reading the config key directly reported nil
      ;; whenever an operator had not set it, which is most of the time.
      (is (= (locks/lock-expiration-ms)
             (:effective-lock-expiration-ms (:settings body))))
      (is (pos-int? (:effective-lock-expiration-ms (:settings body)))))

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
    (let [r (admin-get "/logs/file")]
      (assert-ok r)
      (is (= [] (:lines (:body r))))
      (is (string? (:error (:body r))))))
  (testing "And the live buffer is served regardless"
    (log-buffer/clear!)
    (admin-get "/server")
    (let [body (:body (admin-get "/logs"))]
      (is (nil? (:file body)))
      (is (= ["/api/v1/admin/server"] (map :path (:entries (:requests body))))))))

(deftest reading-the-log-is-not-itself-logged
  (log-buffer/clear!)
  (testing "A screen polling the log would otherwise be the only thing in it"
    (dotimes [_ 3] (admin-get "/logs"))
    (admin-get "/logs/file")
    (is (empty? (:entries (:requests (:body (admin-get "/logs"))))))))

(deftest live-log-names-who-made-each-request
  (log-buffer/clear!)
  (let [_ (create-test-project admin-request "LogProj")
        _ (api-call user1-request {:method :get :path "/api/v1/projects"})
        _ (api-call user1-request {:method :get
                                   :path "/api/v1/projects/00000000-0000-7000-8000-000000000000"})
        body (:body (admin-get "/logs?limit=500"))
        entries (:entries (:requests body))]

    (testing "Every buffered request carries the account that made it"
      (is (seq entries))
      (is (every? (comp string? :user) entries))
      (is (contains? (set (map :user entries)) "user1@example.com")))

    (testing "Newest first, with method, path, status and duration"
      ;; The request doing the reading is logged once its response is out the
      ;; door, so the newest entry is the one before it.
      (let [newest (first entries)]
        (is (= "GET" (:method newest)))
        (is (= "/api/v1/projects/00000000-0000-7000-8000-000000000000" (:path newest)))
        (is (= 403 (:status newest)))
        (is (int? (:ms newest)))))

    (testing "One account's work is one filter away"
      (let [theirs (:entries (:requests (:body (admin-get "/logs?user=user1@example.com"))))]
        (is (= 2 (count theirs)))
        (is (every? #(= "user1@example.com" (:user %)) theirs))))

    (testing "So is everything that failed"
      (let [failed (:requests (:body (admin-get "/logs?status=failures")))]
        (is (= 1 (:matched failed)))
        (is (= 403 (:status (first (:entries failed)))))))

    (testing "Stats describe the filtered set"
      (let [stats (:stats (:requests (:body (admin-get "/logs?user=user1@example.com"))))]
        (is (= 2 (:count stats)))
        (is (= 1 (:failures stats)))))))

(deftest live-log-keeps-events-out-of-the-request-flood
  (log-buffer/clear!)
  ;; A token is warned about once per window, so this test has to be the
  ;; first refusal of this one however the namespaces happen to be ordered.
  (auth/reset-jwt-rejection-log!)
  ;; A rejected token is logged by the JWT middleware, not by the access log,
  ;; so it lands in the event buffer while its 401 lands in the request one.
  (api-call bad-token-request {:method :get :path "/api/v1/projects"})
  (let [body (:body (admin-get "/logs"))]
    (testing "The rejection is an event"
      (is (some #(str/includes? (:message %) "JWT validation failed")
                (:entries (:events body)))))
    (testing "And its 401 is still a request, with nobody's name on it"
      (let [refused (first (filter #(= 401 (:status %)) (:entries (:requests body))))]
        (is (some? refused))
        (is (nil? (:user refused)))
        (is (= "/api/v1/projects" (:path refused)))))
    (testing "No access line landed in the event buffer"
      (is (not-any? #(str/includes? (:message %) "user=")
                    (:entries (:events body)))))))

(deftest a-request-that-matches-no-route-is-still-logged
  (log-buffer/clear!)
  ;; The access log used to be route middleware, so the two answers the
  ;; router gives without a route -- a path that matches nothing and a method
  ;; the path does not have -- left no line and no record at all.
  (api-call admin-request {:method :get :path "/api/v1/no-such-endpoint"})
  (api-call admin-request {:method :delete :path "/api/v1/projects"})
  (let [entries (:entries (:requests (:body (admin-get "/logs"))))
        by-path (into {} (map (juxt :path identity)) entries)]
    (testing "A path miss is a 404 with a line of its own"
      (is (= 404 (:status (get by-path "/api/v1/no-such-endpoint")))))
    (testing "And a method the route does not have is a 405"
      (is (= 405 (:status (get by-path "/api/v1/projects")))))))

(deftest a-batch-is-one-request-however-many-sub-ops-it-carries
  (log-buffer/clear!)
  ;; Every sub-op was logged as a request of its own, with no address, so five
  ;; thousand-op batches evicted the whole request buffer and everything an
  ;; operator might have come looking for with it.
  (let [proj (create-test-project admin-request "BatchLogProj")
        _ (log-buffer/clear!)
        res (api-call admin-request
                      {:method :post
                       :path "/api/v1/batch"
                       :body [{:path "/api/v1/documents" :method "post"
                               :body {:project-id proj :name "One"}}
                              {:path "/api/v1/documents" :method "post"
                               :body {:project-id proj :name "Two"}}]})
        entries (:entries (:requests (:body (admin-get "/logs"))))]
    (testing "the batch itself is logged, and its sub-ops are not"
      (is (= ["/api/v1/batch"] (map :path entries)))
      (is (= 200 (:status res))))))

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
