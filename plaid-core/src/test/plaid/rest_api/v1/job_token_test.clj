(ns plaid.rest-api.v1.job-token-test
  "The token a job worker writes with (CONTRACT 4): the starter's, scoped to
  the job's project, its runner the worker's account, its `jti` the same for
  every token of one job so they all join the job's History entries, and
  minted only while the starter may write the project."
  (:require [buddy.sign.jwt :as jwt]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db
                                            with-rest-handler with-admin with-test-users
                                            admin-request]]
            [plaid.rest-api.v1.auth :as auth]
            [plaid.rest-api.v1.job-helpers :as jh :refer [as call start! job-id claim! heartbeat!]]
            [plaid.sql.common :as psc]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- claims [token] (jwt/unsign token "fake-secret"))

(defn- write-in [who p gid name]
  (call who :post (str "/api/v1/documents?group-id=" gid "&group-message=Assistant%20job&group-kind=job"
                       "&group-ref=job:x/doc:y/pass:gloss")
        {:project-id p :name name}))

(deftest the-token-is-the-starters-scoped-to-the-project
  (let [{:keys [p st]} (jh/world!)
        j (job-id (start! st p))
        token (-> (claim! jh/worker-a) :body :token)
        c (claims token)]
    (is (= "starter@example.com" (:user/id c)))
    (is (= [p] (:scope/projects c)))
    (is (= "admin@example.com" (:scope/runner c)))
    (is (= (str "job:" j) (:jti c)))
    (is (number? (:version c)))
    (is (<= (- (:exp c) (quot (System/currentTimeMillis) 1000)) (auth/delegated-token-ttl-seconds)))))

(deftest the-token-reaches-only-what-the-starter-may-in-the-project
  (let [{:keys [p q d1] :as world} (jh/world!)
        _ (jh/grant! q "writers" "maintainer@example.com")
        _ (job-id (start! (:m world) p))
        job-token (as (-> (claim! jh/worker-a) :body :token))
        vocab (-> (call admin-request :post "/api/v1/vocab-layers" {:name "lex" :project-id p}) :body :id)]
    (testing "inside its project it reads and writes"
      (is (= 200 (:status (call job-token :get (str "/api/v1/documents/" d1)))))
      (is (= 201 (:status (write-in job-token p (random-uuid) "made by the job")))))
    (testing "outside its project it is refused, though its user writes there"
      (is (= 403 (:status (call job-token :get (str "/api/v1/projects/" q)))))
      (is (= 403 (:status (call job-token :post "/api/v1/documents" {:project-id q :name "elsewhere"})))))
    (testing "a maintainer's route is refused, though its user maintains the project"
      (let [r (call job-token :patch (str "/api/v1/projects/" p) {:name "Renamed"})]
        (is (= 403 (:status r)))
        (is (= (:body auth/project-admin-refusal) (:body r)))))
    (testing "a vocabulary-admin route is refused"
      (is (= 403 (:status (call job-token :patch (str "/api/v1/vocab-layers/" vocab) {:name "renamed"})))))
    (testing "an admin's route is refused"
      (is (= 403 (:status (call job-token :get "/api/v1/users")))))
    (testing "a job's own routes are no exception"
      (is (= 403 (:status (call job-token :post (str "/api/v1/projects/" p "/jobs") {:app "igt" :tasks ["gloss"]}))))
      (is (= 403 (:status (call job-token :post "/api/v1/jobs/claim"
                                {:worker-id jh/worker-b :model "m" :apps ["igt"]})))))))

(deftest every-token-of-a-job-joins-its-history-entry
  (let [{:keys [p] :as world} (jh/world!)
        j (job-id (start! (:st world) p))
        first-token (-> (claim! jh/worker-a) :body :token)
        renewed (-> (heartbeat! j jh/worker-a) :body :token)
        gid (random-uuid)]
    (is (string? renewed) "a fresh token with every heartbeat")
    (is (= (:jti (claims first-token)) (:jti (claims renewed))))
    (is (= 201 (:status (write-in (as first-token) p gid "one"))))
    (is (= 201 (:status (write-in (as renewed) p gid "two"))) "the renewed token joins the group")
    (let [row (psc/fetch-by-id fix/db :operation_groups gid)]
      (is (= "starter@example.com" (:user_id row)))
      (is (= "job" (:kind row)))
      (is (= (str "job:" j) (:scoped_token row))))
    (testing "a token of another job may not join it"
      (let [other (auth/issue-job-token! fix/db "fake-secret" "starter@example.com" p
                                         "0197d1a0-2222-7000-8000-000000000001" nil "admin@example.com" nil)
            r (write-in (as other) p gid "three")]
        (is (= 403 (:status r)))
        (is (empty? (psc/q fix/db {:select [:id] :from [:documents] :where [:= :name "three"]})))))))

(deftest a-starter-demoted-to-reader-gets-no-token
  (let [{:keys [p] :as world} (jh/world!)
        j (job-id (start! (:st world) p))]
    (testing "at the heartbeat"
      (claim! jh/worker-a)
      (fix/assert-no-content (call admin-request :delete (str "/api/v1/projects/" p "/writers/starter@example.com")))
      (jh/grant! p "readers" "starter@example.com")
      (let [r (heartbeat! j jh/worker-a)]
        (is (= 409 (:status r)))
        (is (= "starter-access" (-> r :body :reason)))
        (is (not (contains? (:body r) :token))))
      (is (= "failed" (:state (jh/job-row j)))))
    (testing "at the claim"
      (let [j2 (job-id (start! (:w world) p))]
        (fix/assert-no-content (call admin-request :delete (str "/api/v1/projects/" p "/writers/writer@example.com")))
        (let [r (claim! jh/worker-b)]
          (is (= 204 (:status r)) "nothing taken, nothing minted"))
        (is (= ["failed" "starter-access"] ((juxt :state :reason) (jh/job-row j2))))))))

(deftest the-token-dies-with-the-workers-api-token
  (let [{:keys [p] :as world} (jh/world!)
        named (auth/issue-api-token! fix/db "fake-secret" "admin@example.com" "worker" "admin@example.com")
        worker (as (:token named))
        j (job-id (start! (:st world) p))
        token (-> (call worker :post "/api/v1/jobs/claim" {:worker-id jh/worker-a :model "m" :apps ["igt"]})
                  :body :token)]
    (is (= (str (:id named)) (:delegated/api-token (claims token))))
    (is (= 200 (:status (call (as token) :get (str "/api/v1/projects/" p)))))
    (fix/assert-no-content (call admin-request :delete (str "/api/v1/users/admin@example.com/tokens/" (:id named))))
    (is (= 401 (:status (call (as token) :get (str "/api/v1/projects/" p)))))
    (is (some? j))))
