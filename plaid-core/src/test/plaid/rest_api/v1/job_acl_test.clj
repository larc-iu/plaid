(ns plaid.rest-api.v1.job-acl-test
  "Who may do what with a job: the role matrix of the jobs SPEC, section 2,
  one cell at a time. ST the starter (a writer), W another writer, M a
  maintainer, R a reader, N signed in with no role, A the admin, S a
  delegated token of the maintainer scoped to the project."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db
                                            with-rest-handler with-admin with-test-users
                                            admin-request]]
            [plaid.rest-api.v1.job-helpers :as jh :refer [call start! job-id]]
            [plaid.sql.common :as psc]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private columns [:st :w :m :r :n :a :s])

(defn- cancel-any!
  "Cancel `p`'s active job as the admin, so the next start is not refused
  as a second job."
  [p]
  (when-let [j (:job/id (:body (call admin-request :get (str "/api/v1/projects/" p "/jobs/active"))))]
    (fix/assert-ok (call admin-request :post (str "/api/v1/jobs/" j "/cancel")))))

(deftest start-by-role
  (let [world (jh/world!)
        p (:p world)
        expected {:st 201 :w 201 :m 201 :r 403 :n 403 :a 201 :s 403}]
    (doseq [c columns]
      (testing (name c)
        (let [resp (start! (world c) p)]
          (is (= (expected c) (:status resp)) (pr-str (:body resp)))
          (when (= :s c)
            (is (= "A delegated token cannot start or stop a job." (-> resp :body :error))))
          (cancel-any! p))))))

;; A setup is set only by the start, so only who may start may set one, and
;; every reader reads it back (SU).
(deftest a-setup-by-role
  (let [world (jh/world!)
        p (:p world)
        expected {:st 201 :w 201 :m 201 :r 403 :n 403 :a 201 :s 403}]
    (doseq [c columns]
      (testing (name c)
        (let [jobs #(:n (psc/q1 fix/db {:select [[[:count :*] :n]] :from [:jobs]}))
              before (jobs)
              resp (start! (world c) p {:setup {:text false :fills []}})]
          (is (= (expected c) (:status resp)) (pr-str (:body resp)))
          (when (not= 201 (expected c))
            (is (= before (jobs)) "nothing is stored"))
          (cancel-any! p))))
    (testing "every reader reads it"
      (let [j (job-id (start! (:st world) p {:setup {:text true :fills [{:id "L1" :name "Case"}]}}))]
        (doseq [c (remove #{:n} columns)]
          (is (= {"text" true "fills" [{"id" "L1" "name" "Case"}]}
                 (:job/setup (:body (call (world c) :get (str "/api/v1/jobs/" j)))))
              (name c)))))))

(deftest reads-by-role
  (let [world (jh/world!)
        p (:p world)
        j (job-id (start! (:st world) p))]
    (doseq [c columns
            :let [expected (if (= :n c) 403 200)]]
      (testing (name c)
        (is (= expected (:status (call (world c) :get (str "/api/v1/projects/" p "/jobs")))) "list")
        (is (= expected (:status (call (world c) :get (str "/api/v1/projects/" p "/jobs/active")))) "active")
        (is (= expected (:status (call (world c) :get (str "/api/v1/jobs/" j)))) "get")
        (is (= expected (:status (call (world c) :get (str "/api/v1/jobs/" j "/pieces")))) "pieces")))
    (testing "active answers 204 once the job has ended"
      (fix/assert-ok (call admin-request :post (str "/api/v1/jobs/" j "/cancel")))
      (doseq [c (remove #{:n} columns)]
        (is (= 204 (:status (call (world c) :get (str "/api/v1/projects/" p "/jobs/active")))) (name c))))))

(deftest cancel-by-role
  (let [world (jh/world!)
        p (:p world)
        expected {:st 200 :w 403 :m 200 :r 403 :n 403 :a 200 :s 403}]
    (doseq [c columns]
      (testing (name c)
        (let [j (job-id (start! (:st world) p))
              resp (call (world c) :post (str "/api/v1/jobs/" j "/cancel"))]
          (is (= (expected c) (:status resp)) (pr-str (:body resp)))
          (case c
            :w (is (= "Only the person who started a job or a maintainer can stop it." (-> resp :body :error)))
            :s (is (= "A delegated token cannot start or stop a job." (-> resp :body :error)))
            nil)
          (cancel-any! p))))
    (testing "the starter, demoted to reader, may no longer stop it"
      (let [j (job-id (start! (:st world) p))]
        (fix/assert-no-content (call admin-request :delete (str "/api/v1/projects/" p "/writers/starter@example.com")))
        (jh/grant! p "readers" "starter@example.com")
        (is (= 403 (:status (call (:st world) :post (str "/api/v1/jobs/" j "/cancel")))))
        (is (= 200 (:status (call (:m world) :post (str "/api/v1/jobs/" j "/cancel")))) "a maintainer still may")))))

(deftest the-worker-line-by-role
  (let [world (jh/world!)]
    (doseq [c columns
            :let [resp (call (world c) :get "/api/v1/jobs/worker")]]
      (testing (name c)
        (is (= (if (= :s c) 403 200) (:status resp)))
        (when (not= :s c)
          (is (= {:seen-at nil :model nil :settings nil :instructions-max-chars 2000 :documents-max 500}
                 (:body resp))))))))

(deftest worker-routes-are-the-admins
  (let [world (jh/world!)
        p (:p world)
        j (job-id (start! (:st world) p))
        d (:d1 world)
        routes [[:post "/api/v1/jobs/claim" {:worker-id jh/worker-a :model "m" :apps ["igt"]}]
                [:post (str "/api/v1/jobs/" j "/heartbeat") {:worker-id jh/worker-a}]
                [:put (str "/api/v1/jobs/" j "/documents/" d) {:worker-id jh/worker-a :state "working"}]
                [:post (str "/api/v1/jobs/" j "/decisions")
                 {:worker-id jh/worker-a :decisions [{:form "ka" :key "k1" :analysis "{}" :count 1}]}]
                [:get (str "/api/v1/jobs/" j "/decisions")]
                [:post (str "/api/v1/jobs/" j "/decisions/lookup") {:forms ["ka"]}]
                [:post (str "/api/v1/jobs/" j "/landed") {:refs ["0197d1a0-0000-7000-8000-000000000001"]}]
                [:post (str "/api/v1/jobs/" j "/finish") {:worker-id jh/worker-a :state "done" :report {}}]
                [:get "/api/v1/jobs/model-busy?pool=key"]]]
    (doseq [c (remove #{:a} columns)
            [method path body] routes]
      (testing (str (name c) " " method " " path)
        (is (= 403 (:status (call (world c) method path body))))))
    (testing "the admin passes every one of them"
      (doseq [[method path body] routes
              :let [resp (call admin-request method path body)]]
        (is (< 199 (:status resp) 300) (str method " " path " " (pr-str (:body resp))))))))

(deftest an-unknown-job
  (let [world (jh/world!)
        unknown "0197d1a0-0000-7000-8000-0000000000ff"]
    (doseq [c (remove #{:a :s} columns)]
      (testing (name c)
        (let [resp (call (world c) :get (str "/api/v1/jobs/" unknown))]
          (is (= 403 (:status resp)))
          (is (true? (-> resp :body :unresolved))))
        (let [resp (call (world c) :post (str "/api/v1/jobs/" unknown "/cancel"))]
          (is (= 403 (:status resp)))
          (is (true? (-> resp :body :unresolved))))
        (let [resp (call (world c) :get (str "/api/v1/jobs/" unknown "/pieces"))]
          (is (= 403 (:status resp)))
          (is (true? (-> resp :body :unresolved))))))
    (testing "the admin is told it names nothing"
      (is (= {:error "Job not found"} (:body (call admin-request :get (str "/api/v1/jobs/" unknown)))))
      (is (= {:error "Job not found"} (:body (call admin-request :get (str "/api/v1/jobs/" unknown "/pieces")))))
      (is (= 404 (:status (call admin-request :post (str "/api/v1/jobs/" unknown "/cancel")))))
      (doseq [[method path body] [[:post (str "/api/v1/jobs/" unknown "/heartbeat") {:worker-id jh/worker-a}]
                                  [:post (str "/api/v1/jobs/" unknown "/finish")
                                   {:worker-id jh/worker-a :state "done" :report {}}]
                                  [:get (str "/api/v1/jobs/" unknown "/decisions")]
                                  [:post (str "/api/v1/jobs/" unknown "/decisions/lookup") {:forms ["ka"]}]]]
        (is (= 404 (:status (call admin-request method path body))) (str method " " path))))))

(deftest a-job-of-a-hidden-project
  (let [world (jh/world!)
        p (:p world)
        j (job-id (start! (:st world) p))]
    ;; The mark a project delete sets before the background removal.
    (psc/execute! fix/db {:update :projects :set {:deleted_at (psc/now-iso)} :where [:= :id p]})
    (doseq [c [:st :m :r]
            path [(str "/api/v1/jobs/" j) (str "/api/v1/jobs/" j "/pieces")]]
      (let [resp (call (world c) :get path)]
        (is (= 403 (:status resp)) (str (name c) " " path))
        (is (true? (-> resp :body :unresolved)) (str (name c) " " path))))
    (is (= 404 (:status (call admin-request :get (str "/api/v1/jobs/" j)))))
    (is (= 404 (:status (call admin-request :get (str "/api/v1/jobs/" j "/pieces")))))
    (is (= 204 (:status (jh/claim! jh/worker-a))) "no claim takes it")))

(deftest a-job-names-only-documents-of-its-project
  (let [world (jh/world!)
        resp (start! (:st world) (:p world) {:documents [(:d1 world) (:dq world)]})]
    (is (= 400 (:status resp)))
    (is (= "documents: 1 is not a document of this project." (-> resp :body :error)) "names nothing outside")))

;; The operator's list (the admin area's Jobs tab): every project's jobs,
;; newest first, each with its project's name. An admin's alone.
(deftest every-projects-jobs-by-role
  (let [world (jh/world!)
        {:keys [p q st]} world
        j1 (job-id (start! st p))
        _ (Thread/sleep 5)
        j2 (job-id (start! admin-request q))
        expected {:st 403 :w 403 :m 403 :r 403 :n 403 :a 200 :s 403}]
    (doseq [c columns]
      (testing (name c)
        (is (= (expected c) (:status (call (world c) :get "/api/v1/admin/jobs"))))))
    (let [entries (:entries (:body (call admin-request :get "/api/v1/admin/jobs")))]
      (is (= [[j2 "Jobs Q"] [j1 "Jobs P"]] (mapv (juxt :job/id :job/project-name) entries)))
      (is (= [1 2] (mapv :job/document-count entries)))
      (is (= #{"waiting"} (set (map :job/state entries))))
      (is (not-any? #(contains? % :job/documents) entries)))
    (testing "pages by cursor"
      (let [page1 (:body (call admin-request :get "/api/v1/admin/jobs?limit=1"))
            page2 (:body (call admin-request :get (str "/api/v1/admin/jobs?limit=1&cursor=" (:next-cursor page1))))]
        (is (= [j2] (mapv :job/id (:entries page1))))
        (is (= [j1] (mapv :job/id (:entries page2))))))
    (testing "a project being deleted leaves the list"
      (psc/execute! fix/db {:update :projects :set {:deleted_at (psc/now-iso)} :where [:= :id q]})
      (is (= [j1] (mapv :job/id (:entries (:body (call admin-request :get "/api/v1/admin/jobs")))))))))
